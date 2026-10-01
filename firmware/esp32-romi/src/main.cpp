#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <Preferences.h>
#include <WiFi.h>
#include <time.h>

#include "romi_config.h"
#include "romi_http.h"
#include "romi_audio.h"

#if __has_include("romi_secrets.h")
#include "romi_secrets.h"
#else
#include "romi_secrets.example.h"
#define ROMI_USING_EXAMPLE_SECRETS 1
#endif

namespace {
enum class AppState { Boot, WifiConnecting, Idle, SessionStarting, SessionActive, SessionClosing, DoorOpening, Error };
enum class DoorPhase { Idle, Opening, Holding, Closing, AckPending };
enum class StatusLight { Idle, Connecting, Active, Error, DoorOpening };

struct DoorCommand {
  String id;
  time_t expiresAt;
  bool opened;
  const char* errorCode;

  DoorCommand(const String& commandId = "", time_t expiry = 0, bool wasOpened = false,
              const char* failureCode = nullptr)
      : id(commandId), expiresAt(expiry), opened(wasOpened), errorCode(failureCode) {}
};

Servo doorServo;
Preferences preferences;
AppState appState = AppState::Boot;
AppState sessionState = AppState::Idle;
DoorPhase doorPhase = DoorPhase::Idle;
DoorCommand doorCommand;
bool debugCycle = false;
bool networkBusy = false;
bool apiError = false;
String lastCommandId;
String recentCommandIds;
bool configurationReady = false;
bool wasConnected = false;
bool timeSyncStarted = false;
bool rawButton = HIGH;
bool stableButton = HIGH;
uint32_t buttonChangedAt = 0;
uint32_t wifiAttemptAt = 0;
uint32_t nextTimeAttemptAt = 0;
uint32_t nextPollAt = 0;
uint32_t nextAckAt = 0;
uint32_t doorPhaseAt = 0;
uint32_t apiBackoffMs = romi::API_DEFAULT_POLL_MS;
String apiBaseUrl;

bool due(uint32_t deadline) { return static_cast<int32_t>(millis() - deadline) >= 0; }
bool elapsed(uint32_t since, uint32_t interval) { return millis() - since >= interval; }

const char* stateName(AppState state) {
  switch (state) {
    case AppState::Boot: return "BOOT";
    case AppState::WifiConnecting: return "WIFI_CONNECTING";
    case AppState::Idle: return "IDLE";
    case AppState::SessionStarting: return "SESSION_STARTING";
    case AppState::SessionActive: return "SESSION_ACTIVE";
    case AppState::SessionClosing: return "SESSION_CLOSING";
    case AppState::DoorOpening: return "DOOR_OPENING";
    case AppState::Error: return "ERROR";
  }
  return "UNKNOWN";
}

void showStatus(StatusLight status) {
  bool red = false;
  bool green = false;
  switch (status) {
    case StatusLight::Idle: green = true; break;
    case StatusLight::Connecting: red = true; green = true; break;
    case StatusLight::Active: red = true; break;
    case StatusLight::Error: red = true; break;
    case StatusLight::DoorOpening: green = true; break;
  }
  digitalWrite(romi::RED_LED_PIN, red ? HIGH : LOW);
  digitalWrite(romi::GREEN_LED_PIN, green ? HIGH : LOW);
}

void setIdleStatus() { showStatus(StatusLight::Idle); }
void setConnectingStatus() { showStatus(StatusLight::Connecting); }
void setActiveStatus() { showStatus(StatusLight::Active); }
void setErrorStatus() { showStatus(StatusLight::Error); }
void setDoorOpeningStatus() { showStatus(StatusLight::DoorOpening); }

void refreshState() {
#if ROMI_ENABLE_AUDIO
  switch (audioSessionState()) {
    case RomiSessionState::Idle: sessionState = AppState::Idle; break;
    case RomiSessionState::Starting: sessionState = AppState::SessionStarting; break;
    case RomiSessionState::Active: sessionState = AppState::SessionActive; break;
    case RomiSessionState::Closing: sessionState = AppState::SessionClosing; break;
    case RomiSessionState::Error: sessionState = AppState::Error; break;
  }
#endif
  AppState next = !configurationReady ? AppState::Error
      : !ROMI_BENCH_MODE && (WiFi.status() != WL_CONNECTED || !timeSyncStarted) ? AppState::WifiConnecting
      : doorPhase != DoorPhase::Idle && doorPhase != DoorPhase::AckPending ? AppState::DoorOpening
      : apiError ? AppState::Error
      : sessionState;
  if (next == appState) return;
  appState = next;
  Serial.printf("[STATE] %s\n", stateName(appState));
  switch (appState) {
    case AppState::Boot: break;
    case AppState::WifiConnecting: setConnectingStatus(); break;
    case AppState::Idle: setIdleStatus(); break;
    case AppState::SessionStarting: setConnectingStatus(); break;
    case AppState::SessionActive: setActiveStatus(); break;
    case AppState::SessionClosing: setConnectingStatus(); break;
    case AppState::DoorOpening: setDoorOpeningStatus(); break;
    case AppState::Error: setErrorStatus(); break;
  }
}

String shortId(const String& id) { return id.substring(0, min(static_cast<size_t>(8), id.length())); }

bool validUuid(const String& id) {
  if (id.length() != 36) return false;
  for (size_t i = 0; i < 36; ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (id[i] != '-') return false;
    } else if (!isxdigit(static_cast<unsigned char>(id[i]))) {
      return false;
    }
  }
  return true;
}

int64_t daysSinceEpoch(int year, unsigned month, unsigned day) {
  year -= month <= 2;
  const int era = (year >= 0 ? year : year - 399) / 400;
  const unsigned yearOfEra = year - era * 400;
  const int adjustedMonth = static_cast<int>(month) + (month > 2 ? -3 : 9);
  const unsigned dayOfYear = (153 * adjustedMonth + 2) / 5 + day - 1;
  const unsigned yearOfCycle = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear;
  return era * 146097LL + static_cast<int64_t>(yearOfCycle) - 719468;
}

// PostgreSQL timestamptz JSON can be UTC (Z) or carry an explicit offset.
bool parseExpiry(const String& value, time_t& result) {
  if (value.length() < 20 || value[4] != '-' || value[7] != '-' || value[10] != 'T' ||
      value[13] != ':' || value[16] != ':') return false;
  for (size_t index = 0; index < 19; ++index) {
    if (index == 4 || index == 7 || index == 10 || index == 13 || index == 16) continue;
    if (!isdigit(static_cast<unsigned char>(value[index]))) return false;
  }
  int year, month, day, hour, minute, second, consumed = 0;
  if (sscanf(value.c_str(), "%4d-%2d-%2dT%2d:%2d:%2d%n", &year, &month, &day,
             &hour, &minute, &second, &consumed) != 6) return false;
  if (year < 2024 || month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 60) return false;
  size_t pos = consumed;
  if (pos < value.length() && value[pos] == '.') {
    ++pos;
    const size_t start = pos;
    while (pos < value.length() && isdigit(static_cast<unsigned char>(value[pos]))) ++pos;
    if (pos == start) return false;
  }
  int offsetSeconds = 0;
  if (pos < value.length() && (value[pos] == '+' || value[pos] == '-')) {
    const int sign = value[pos++] == '+' ? 1 : -1;
    if (value.length() - pos != 5 || value[pos + 2] != ':' ||
        !isdigit(static_cast<unsigned char>(value[pos])) ||
        !isdigit(static_cast<unsigned char>(value[pos + 1])) ||
        !isdigit(static_cast<unsigned char>(value[pos + 3])) ||
        !isdigit(static_cast<unsigned char>(value[pos + 4]))) return false;
    int offsetHours = 0, offsetMinutes = 0, used = 0;
    if (sscanf(value.c_str() + pos, "%2d:%2d%n", &offsetHours, &offsetMinutes, &used) != 2 ||
        offsetHours > 23 || offsetMinutes > 59) return false;
    pos += used;
    offsetSeconds = sign * (offsetHours * 3600 + offsetMinutes * 60);
  } else if (pos < value.length() && value[pos] == 'Z') {
    ++pos;
  } else {
    return false;
  }
  if (pos != value.length()) return false;
  static constexpr int daysInMonth[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  const bool leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
  if (day > daysInMonth[month - 1] + (month == 2 && leap ? 1 : 0) || second > 59) return false;
  const int64_t parsed = daysSinceEpoch(year, month, day) * 86400 +
      hour * 3600 + minute * 60 + second - offsetSeconds;
  if (parsed < 0 || static_cast<int64_t>(static_cast<time_t>(parsed)) != parsed) return false;
  result = static_cast<time_t>(parsed);
  return true;
}

bool clockReady() { return time(nullptr) > 1735689600; }  // 2025-01-01 UTC

bool commandHasTime(time_t expiry, uint32_t neededMs) {
  if (!clockReady()) return false;
  return static_cast<int64_t>(expiry) * 1000 - static_cast<int64_t>(time(nullptr)) * 1000 > neededMs;
}

bool credentialsConfigured() {
#ifdef ROMI_USING_EXAMPLE_SECRETS
  Serial.println("[ERROR] Copy include/romi_secrets.example.h to include/romi_secrets.h and configure it");
  return false;
#endif
  if (!ROMI_WIFI_SSID[0] || !ROMI_DEVICE_TOKEN[0] || !ROMI_API_BASE_URL[0] ||
      strstr(ROMI_WIFI_SSID, "REPLACE_WITH") || strstr(ROMI_WIFI_PASSWORD, "REPLACE_WITH") ||
      strstr(ROMI_DEVICE_TOKEN, "REPLACE_WITH") ||
      strstr(ROMI_API_BASE_URL, "YOUR_DEPLOYED_HOST")) {
    Serial.println("[ERROR] Configure WiFi, base URL, and device token in romi_secrets.h");
    return false;
  }
  apiBaseUrl = ROMI_API_BASE_URL;
  while (apiBaseUrl.endsWith("/")) apiBaseUrl.remove(apiBaseUrl.length() - 1);
  if (!apiBaseUrl.startsWith("https://") || apiBaseUrl.length() <= 8) {
    Serial.println("[ERROR] ROMI_API_BASE_URL must be HTTPS");
    return false;
  }
#if !ROMI_ALLOW_INSECURE_TLS_FOR_DEMO
  if (!strstr(ROMI_ROOT_CA_BUNDLE, "-----BEGIN CERTIFICATE-----")) {
    Serial.println("[ERROR] Configure ROMI_ROOT_CA_BUNDLE for validated HTTPS");
    return false;
  }
#else
  Serial.println("[DEMO] TLS certificate validation is disabled");
#endif
  return true;
}

void maintainWifi() {
  if (ROMI_BENCH_MODE || !configurationReady) return;
  if (WiFi.status() == WL_CONNECTED) {
    if (!wasConnected) {
      wasConnected = true;
      timeSyncStarted = false;
      nextTimeAttemptAt = 0;
      nextPollAt = millis();
      Serial.print("[WIFI] Connected IP=");
      Serial.println(WiFi.localIP());
      configTime(0, 0, "pool.ntp.org", "time.google.com");
      Serial.println("[TIME] Synchronizing for TLS and command expiry");
    }
    if (!clockReady()) {
      if (due(nextTimeAttemptAt)) {
        Serial.println("[TIME] Waiting for NTP");
        nextTimeAttemptAt = millis() + romi::TIME_RETRY_MS;
      }
    } else if (!timeSyncStarted) {
      timeSyncStarted = true;
      Serial.println("[TIME] Synchronized");
    }
    return;
  }
  if (wasConnected) {
    wasConnected = false;
    timeSyncStarted = false;
    Serial.println("[WARN] WiFi disconnected");
  }
  if (wifiAttemptAt != 0 && !elapsed(wifiAttemptAt, romi::WIFI_CONNECT_TIMEOUT_MS)) return;
  if (wifiAttemptAt != 0 && !elapsed(wifiAttemptAt, romi::WIFI_CONNECT_TIMEOUT_MS + romi::WIFI_RETRY_MS)) return;
  WiFi.disconnect();
  WiFi.begin(ROMI_WIFI_SSID, ROMI_WIFI_PASSWORD);
  wifiAttemptAt = millis() == 0 ? 1 : millis();
  Serial.println("[WIFI] Connecting...");
}

void scheduleBackoff(uint32_t& deadline) {
  deadline = millis() + apiBackoffMs;
  apiBackoffMs = min(apiBackoffMs * 2, romi::API_BACKOFF_MAX_MS);
}

void resetBackoff() { apiBackoffMs = romi::API_DEFAULT_POLL_MS; }

void beginCommand(const String& id, time_t expiry) {
  // Save before energizing the servo, so a reset cannot repeat this command.
  String updatedHistory = recentCommandIds;
  if (updatedHistory.length() >= romi::RECENT_COMMAND_COUNT * 37) updatedHistory.remove(0, 37);
  updatedHistory += id + '\n';
  if (preferences.putString("recentCommands", updatedHistory) != updatedHistory.length()) {
    Serial.println("[ERROR] Could not persist command ID; refusing actuation");
    doorCommand = DoorCommand(id, expiry, false, "PERSISTENCE_FAILURE");
    doorPhase = DoorPhase::AckPending;
    nextAckAt = millis();
    return;
  }
  lastCommandId = id;
  recentCommandIds = updatedHistory;
  doorCommand = DoorCommand(id, expiry);
  doorPhase = DoorPhase::Opening;
  doorPhaseAt = millis();
  doorServo.write(romi::DOOR_OPEN_ANGLE);
  Serial.printf("[DOOR] Opening command=%s\n", shortId(id).c_str());
  refreshState();
}

void pollCommands() {
  if (ROMI_BENCH_MODE || networkBusy || !configurationReady || !timeSyncStarted ||
      doorPhase != DoorPhase::Idle || !due(nextPollAt)) return;
  RomiHttpJob job;
  job.kind = RomiRequestKind::Poll;
  networkBusy = submitHttpJob(job);
  if (!networkBusy) return;
  Serial.println("[API] Polling door commands");
}

void completePoll(const RomiHttpResult& response) {
  const int status = response.status;
  if (status != 200) {
    apiError = true;
    Serial.printf("[ERROR] Poll HTTP %d%s\n", status, status == 401 ? " (check device token)" : "");
    scheduleBackoff(nextPollAt);
    return;
  }
  JsonDocument doc;
  if (deserializeJson(doc, response.body) || !doc["command"].is<JsonVariant>()) {
    apiError = true;
    Serial.println("[ERROR] Invalid poll JSON");
    scheduleBackoff(nextPollAt);
    return;
  }
  resetBackoff();
  apiError = false;
  uint32_t interval = doc["retry_after_ms"].is<uint32_t>()
      ? doc["retry_after_ms"].as<uint32_t>() : romi::API_DEFAULT_POLL_MS;
  nextPollAt = millis() + constrain(interval, romi::API_MIN_POLL_MS, romi::API_MAX_POLL_MS);
  if (doc["command"].isNull()) {
    Serial.println("[API] No pending command");
    return;
  }
  if (!doc["command"].is<JsonObject>()) {
    apiError = true;
    Serial.println("[ERROR] Invalid command object");
    return;
  }
  String id = doc["command"]["id"].as<String>();
  id.toLowerCase();
  const String expiryText = doc["command"]["expires_at"].as<String>();
  time_t expiry;
  if (!validUuid(id) || !parseExpiry(expiryText, expiry)) {
    apiError = true;
    Serial.println("[ERROR] Invalid command ID or expiry; no actuation");
    return;
  }
  Serial.printf("[DOOR] Command received %s\n", shortId(id).c_str());
  if (id == lastCommandId || recentCommandIds.indexOf(id + '\n') >= 0) {
    Serial.println("[WARN] Duplicate command ignored; no actuation");
    doorCommand = DoorCommand(id, expiry, false, "DUPLICATE_COMMAND");
    doorPhase = DoorPhase::AckPending;
    nextAckAt = millis();
    return;
  }
  const uint32_t cycleMs = 2 * romi::SERVO_MOVE_WAIT_MS + romi::SERVO_OPEN_HOLD_MS +
      romi::COMMAND_EXPIRY_GUARD_MS;
  if (!commandHasTime(expiry, cycleMs)) {
    Serial.println("[ERROR] Command expired or insufficient time for safe cycle");
    doorCommand = DoorCommand(id, expiry, false, "COMMAND_EXPIRED");
    doorPhase = DoorPhase::AckPending;
    nextAckAt = millis();
    return;
  }
  beginCommand(id, expiry);
}

// Replace this function with a limit/reed/Hall sensor check in production.
bool doorOpenFeedback() {
#if ROMI_DEMO_ASSUME_SERVO_MOVED
  Serial.println("[DEMO] Timed servo movement is being used as door verification");
  return true;
#else
  Serial.println("[ERROR] No door position sensor; cannot confirm opening");
  return false;
#endif
}

void advanceDoor() {
  switch (doorPhase) {
    case DoorPhase::Idle: case DoorPhase::AckPending: return;
    case DoorPhase::Opening:
      if (!elapsed(doorPhaseAt, romi::SERVO_MOVE_WAIT_MS)) return;
      doorCommand.opened = debugCycle ? false : doorOpenFeedback();
      doorCommand.errorCode = doorCommand.opened ? nullptr : "DOOR_FEEDBACK_UNAVAILABLE";
      doorPhase = DoorPhase::Holding;
      doorPhaseAt = millis();
      return;
    case DoorPhase::Holding:
      if (!elapsed(doorPhaseAt, romi::SERVO_OPEN_HOLD_MS)) return;
      doorServo.write(romi::DOOR_CLOSED_ANGLE);
      doorPhase = DoorPhase::Closing;
      doorPhaseAt = millis();
      Serial.println("[DOOR] Closing...");
      return;
    case DoorPhase::Closing:
      if (!elapsed(doorPhaseAt, romi::SERVO_MOVE_WAIT_MS)) return;
      if (debugCycle) {
        debugCycle = false;
        doorPhase = DoorPhase::Idle;
        Serial.println("[DEBUG] Servo cycle complete");
        refreshState();
        return;
      }
      doorPhase = DoorPhase::AckPending;
      nextAckAt = millis();
      Serial.println("[DOOR] Movement cycle complete");
      refreshState();
      return;
  }
}

void acknowledgeCommand() {
  if (networkBusy || doorPhase != DoorPhase::AckPending || !timeSyncStarted || !due(nextAckAt)) return;
  if (!commandHasTime(doorCommand.expiresAt, 0)) {
    Serial.printf("[ERROR] ACK window expired for %s; manual reconciliation needed\n",
                  shortId(doorCommand.id).c_str());
    doorPhase = DoorPhase::Idle;
    doorCommand = DoorCommand();
    refreshState();
    return;
  }
  JsonDocument payload;
  payload["command_id"] = doorCommand.id;
  payload["opened"] = doorCommand.opened;
  if (!doorCommand.opened) payload["error_code"] = doorCommand.errorCode ? doorCommand.errorCode : "UNKNOWN";
  RomiHttpJob job;
  job.kind = RomiRequestKind::Acknowledge;
  serializeJson(payload, job.body, sizeof(job.body));
  networkBusy = submitHttpJob(job);
}

void completeAcknowledgement(const RomiHttpResult& response) {
  const int status = response.status;
  if (status == 200) {
    JsonDocument acknowledgement;
    if (deserializeJson(acknowledgement, response.body) ||
        acknowledgement["command"]["id"].as<String>() != doorCommand.id ||
        acknowledgement["command"]["status"].as<String>() != (doorCommand.opened ? "opened" : "failed")) {
      apiError = true;
      Serial.println("[ERROR] Invalid ACK response; retrying without moving servo");
      scheduleBackoff(nextAckAt);
      return;
    }
  }
  if (status == 200 || status == 409) {
    apiError = false;
    Serial.printf("[ACK] %s command=%s\n", status == 200 ? "Saved" : "Already closed/expired (409)",
                  shortId(doorCommand.id).c_str());
    doorPhase = DoorPhase::Idle;
    doorCommand = DoorCommand();
    resetBackoff();
    nextPollAt = millis() + romi::API_DEFAULT_POLL_MS;
    refreshState();
  } else {
    apiError = true;
    Serial.printf("[ERROR] ACK HTTP %d%s\n", status, status == 401 ? " (check device token)" : "");
    scheduleBackoff(nextAckAt);
  }
}

void receiveNetworkResult() {
  if (!networkBusy) return;
  RomiHttpResult response;
  if (!takeHttpResult(response)) return;
  networkBusy = false;
  if (response.kind == RomiRequestKind::Poll) completePoll(response);
  else completeAcknowledgement(response);
}

void onButtonPressed() {
#if ROMI_ENABLE_AUDIO
  toggleAudioSession();
#else
  // Audio-free firmware cannot own a Gemini session or control a separate browser.
  // This local state lets the single button start/cancel the physical kiosk workflow.
  if (sessionState == AppState::Idle) {
    sessionState = AppState::SessionStarting;
    Serial.println("[BTN] Session requested");
    sessionState = AppState::SessionActive;
#if !ROMI_ENABLE_AUDIO
    Serial.println("[SESSION] Local session active; start voice in the browser manually");
#endif
  } else if (sessionState == AppState::SessionActive) {
    sessionState = AppState::SessionClosing;
    Serial.println("[BTN] Session cancelled");
    sessionState = AppState::Idle;
  }
#endif
  refreshState();
}

void readButton() {
  const bool value = digitalRead(romi::BUTTON_PIN);
  if (value != rawButton) {
    rawButton = value;
    buttonChangedAt = millis();
  }
  if (value != stableButton && elapsed(buttonChangedAt, romi::BUTTON_DEBOUNCE_MS)) {
    stableButton = value;
    if (stableButton == LOW) onButtonPressed();
  }
}

#if ROMI_HACKATHON_DEBUG_MODE
void readDebugCommands() {
  while (Serial.available()) {
    const char key = toupper(Serial.read());
    runAudioDebug(key);
    switch (key) {
      case 'O':
        if (doorPhase == DoorPhase::Idle && !networkBusy) {
          doorServo.write(romi::DOOR_OPEN_ANGLE);
          Serial.println("[DEBUG] Servo open");
        }
        break;
      case 'C':
        if (doorPhase == DoorPhase::Idle && !networkBusy) {
          doorServo.write(romi::DOOR_CLOSED_ANGLE);
          Serial.println("[DEBUG] Servo closed");
        }
        break;
      case 'T':
        if (doorPhase == DoorPhase::Idle && !networkBusy) {
          doorServo.write(romi::DOOR_OPEN_ANGLE);
          debugCycle = true;
          doorPhase = DoorPhase::Opening;
          doorPhaseAt = millis();
          doorCommand = DoorCommand();
          Serial.println("[DEBUG] Servo cycle test (no API ACK)");
        }
        break;
      case 'S': Serial.printf("[DEBUG] state=%s WiFi=%d doorPhase=%d\n", stateName(appState),
                              WiFi.status() == WL_CONNECTED, static_cast<int>(doorPhase)); break;
      case 'P': nextPollAt = millis(); Serial.println("[DEBUG] Poll requested"); break;
    }
  }
}
#endif
}  // namespace

void setup() {
  Serial.begin(115200);
  Serial.println("[BOOT] ROMI starting");
  pinMode(romi::BUTTON_PIN, INPUT_PULLUP);
  pinMode(romi::RED_LED_PIN, OUTPUT);
  pinMode(romi::GREEN_LED_PIN, OUTPUT);
  setConnectingStatus();
  ESP32PWM::allocateTimer(0);
  doorServo.setPeriodHertz(50);
  doorServo.attach(romi::SERVO_PIN, 500, 2400);
  doorServo.write(romi::DOOR_CLOSED_ANGLE);
  preferences.begin("romi-door", false);
  lastCommandId = preferences.getString("lastCommand", "");
  lastCommandId.toLowerCase();
  recentCommandIds = preferences.getString("recentCommands", "");
#if ROMI_DEMO_ASSUME_SERVO_MOVED
  Serial.println("[DEMO] Door ACK may use timed servo movement; no physical feedback sensor");
#endif
  if (ROMI_BENCH_MODE) {
    configurationReady = true;
    Serial.println("[BENCH] Offline hardware test; WiFi and API polling disabled");
    Serial.println("[DEBUG] Commands: O=open C=close T=cycle S=status");
  } else {
    configurationReady = credentialsConfigured();
    if (configurationReady && !startHttpWorker(apiBaseUrl.c_str())) {
      configurationReady = false;
      Serial.println("[ERROR] Could not start network worker");
    }
  }
  if (configurationReady && !ROMI_BENCH_MODE) {
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(false);
    maintainWifi();
  }
#if ROMI_ENABLE_AUDIO
  if (configurationReady && !startAudioSystem(apiBaseUrl.c_str())) {
    Serial.println("[AUDIO ERROR] I2S/live task setup failed; door core remains available");
  }
#endif
  refreshState();
}

void loop() {
  readButton();
#if ROMI_HACKATHON_DEBUG_MODE
  readDebugCommands();
#endif
  maintainWifi();
  receiveNetworkResult();
  advanceDoor();
  acknowledgeCommand();
  pollCommands();
  refreshState();
  delay(1);  // Let the HTTP worker and ESP32 system tasks run between GPIO ticks.
}
