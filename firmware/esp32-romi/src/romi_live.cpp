#include "romi_audio.h"
#if ROMI_ENABLE_AUDIO
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <atomic>
#include <memory>
#include <mbedtls/base64.h>
#include "romi_audio_io.h"
#include "romi_gemini_ca.h"
#include "romi_http.h"
#include "romi_live_protocol.h"
#if __has_include("romi_secrets.h")
#include "romi_secrets.h"
#else
#include "romi_secrets.example.h"
#endif

namespace {
std::atomic<RomiSessionState> state{RomiSessionState::Idle};
std::atomic<bool> requested{false};
std::atomic<uint32_t> epoch{0};
bool initialized = false;
String baseUrl, requestId, setupMessage, fragment;
class RomiSocket : public WebSocketsClient {
 public:
  void eraseTokenUrl() {
    for (size_t index = 0; index < _client.cUrl.length(); ++index) _client.cUrl.setCharAt(index, 0);
    _client.cUrl = String();
  }
};
std::unique_ptr<RomiSocket> socket;
bool micEnabled = false;
bool sessionCreated = false, failed = false, finishAfterAudio = false, turnFinished = false;
bool waitingDoor = false;
uint32_t sessionEpoch = 0, startedAt = 0, lastActivityAt = 0, closingAt = 0, doorWaitAt = 0, nextDoorStatusAt = 0;
String pendingCallId, pendingCallName, pendingCommandId;
JsonDocument pendingToolResult;
uint32_t textInput = 0, textOutput = 0, audioInput = 0, audioOutput = 0;
int32_t firstLatency = -1;

class BoundedBody : public Stream {
 public:
  String body;
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
  size_t write(uint8_t byte) override { return write(&byte, 1); }
  size_t write(const uint8_t* bytes, size_t count) override {
    if (body.length() + count > 32768) return 0;
    return body.concat(reinterpret_cast<const char*>(bytes), count) ? count : 0;
  }
};

bool currentVisitor() { return requested.load() && epoch.load() == sessionEpoch; }
void wipeString(String& secret) {
  for (size_t index = 0; index < secret.length(); ++index) secret.setCharAt(index, 0);
  secret = String();
}

int apiRequest(const String& path, const String& body, JsonDocument& response, bool get = false) {
  if (WiFi.status() != WL_CONNECTED || !romiApiMutex() ||
      xSemaphoreTakeRecursive(romiApiMutex(), pdMS_TO_TICKS(10000)) != pdTRUE) return -1;
  int status = -1;
  {
    WiFiClientSecure client;
#if ROMI_ALLOW_INSECURE_TLS_FOR_DEMO
    client.setInsecure();
#else
    client.setCACert(ROMI_ROOT_CA_BUNDLE);
#endif
    client.setHandshakeTimeout(romi::TLS_HANDSHAKE_TIMEOUT_SECONDS);
    HTTPClient http;
    http.setConnectTimeout(romi::API_CONNECT_TIMEOUT_MS);
    http.setTimeout(10000);
    http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    if (http.begin(client, baseUrl + path)) {
      http.addHeader("Authorization", String("Bearer ") + ROMI_DEVICE_TOKEN);
      http.addHeader("Content-Type", "application/json");
      status = get ? http.GET() : http.POST(body);
      if (status > 0) {
        BoundedBody bounded;
        if (http.writeToStream(&bounded) < 0 || deserializeJson(response, bounded.body)) status = -1000;
        wipeString(bounded.body);  // Includes the ephemeral token for session creation.
      }
      http.end();
    }
  }
  xSemaphoreGiveRecursive(romiApiMutex());
  Serial.printf("[LIVE API] %s HTTP %d\n", path.startsWith("/api/ai/door-status") ? "/api/ai/door-status" : path.c_str(), status);
  return status;
}

String newRequestId() {
  uint8_t random[16];
  esp_fill_random(random, sizeof(random));
  random[6] = (random[6] & 0x0f) | 0x40;
  random[8] = (random[8] & 0x3f) | 0x80;
  char uuid[37];
  snprintf(uuid, sizeof(uuid), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
      random[0], random[1], random[2], random[3], random[4], random[5], random[6], random[7],
      random[8], random[9], random[10], random[11], random[12], random[13], random[14], random[15]);
  return String(uuid);
}

bool sendJson(JsonDocument& message) {
  if (!socket || !socket->isConnected() || message.overflowed()) return false;
  String encoded;
  serializeJson(message, encoded);
  if (encoded.length() != measureJson(message)) return false;
  return socket->sendTXT(encoded);
}

void sendToolResult(const String& callId, const String& name, JsonVariantConst result) {
  JsonDocument envelope;
  JsonObject response = envelope["toolResponse"]["functionResponses"].to<JsonArray>().add<JsonObject>();
  response["id"] = callId;
  response["name"] = name;
  response["response"] = result;
  if (!sendJson(envelope)) failed = true;
}

void rememberDoorResult(JsonVariantConst call, JsonVariantConst apiResult, JsonVariantConst commandId) {
  pendingCallId = call["id"].as<String>();
  pendingCallName = call["name"].as<String>();
  pendingCommandId = commandId.as<String>();
  pendingToolResult.set(apiResult);
  waitingDoor = true;
  doorWaitAt = millis();
  nextDoorStatusAt = millis();
  Serial.println("[LIVE] Tool waiting for actual ESP32 door ACK");
}

void executeTool(JsonVariantConst call) {
  const String name = call["name"].as<String>();
  if (name == "end_conversation") {
    setMicCapture(false);
    finishAfterAudio = true;
    turnFinished = true;
    closingAt = millis();
    state.store(RomiSessionState::Closing);
    return;  // A local end signal must not start another model turn.
  }
  String path;
  if (name == "check_in_booking") path = "/api/ai/check-in";
  else if (name == "find_available_slots") path = "/api/ai/availability";
  else if (name == "create_booking") path = "/api/ai/create-booking";
  else if (name == "get_booking_entry_status") path = "/api/ai/entry-status";
  JsonDocument payload, result;
  if (path.isEmpty() || waitingDoor) {
    result["result"] = "error";
    result["message"] = "Unsupported tool or another door operation is pending";
    sendToolResult(call["id"].as<String>(), name, result.as<JsonVariantConst>());
    return;
  }
  payload.set(call["args"]);
  payload["request_id"] = requestId;
  String body;
  serializeJson(payload, body);
  Serial.printf("[LIVE TOOL] %s\n", name.c_str());  // No patient arguments or transcripts.
  const int status = apiRequest(path, body, result);
  if (!currentVisitor()) return;
  if (status != 200 && !(name == "create_booking" && status == 409 && result["booking"].is<JsonObject>())) {
    result.clear();
    result["result"] = "error";
    result["http_status"] = status;
    result["message"] = "ROMI server did not validate the operation. Do not assume success.";
  } else if (name == "check_in_booking") {
    JsonVariantConst attempt = result["attempt"];
    JsonDocument adapted;
    adapted["result"] = attempt["reason"];
    adapted["entry_allowed_now"] = attempt["ok"];
    adapted["reason"] = attempt["reason"];
    adapted["attempts_remaining"] = attempt["attempts_remaining"];
    if (attempt["ok"] == true && attempt["door_command_id"].is<const char*>()) {
      rememberDoorResult(call, adapted.as<JsonVariantConst>(), attempt["door_command_id"]);
      return;
    }
    result.set(adapted);
  } else if (name == "create_booking") {
    JsonVariantConst booking = result["booking"];
    JsonDocument adapted;
    adapted.set(booking);
    adapted["result"] = booking["reason"] | "booking_created_future";
    if (booking["ok"] == true && booking["door_command_id"].is<const char*>()) {
      rememberDoorResult(call, adapted.as<JsonVariantConst>(), booking["door_command_id"]);
      return;
    }
    result.set(adapted);
  } else if (name == "find_available_slots") {
    // Keep the model response bounded; pass server timestamps verbatim.
    JsonDocument adapted;
    JsonArray selected = adapted["slots"].to<JsonArray>();
    for (JsonVariantConst slot : result["slots"].as<JsonArrayConst>()) {
      if (selected.size() >= 8) break;
      JsonObject entry = selected.add<JsonObject>();
      entry.set(slot);
      entry["appointment_at"] = slot["starts_at"];
    }
    adapted["result"] = selected.size() ? "slots_found" : "no_slots";
    result.set(adapted);
  }
  sendToolResult(call["id"].as<String>(), name, result.as<JsonVariantConst>());
  lastActivityAt = millis();
}

void trackUsage(JsonVariantConst usage) {
  for (JsonVariantConst item : usage["promptTokensDetails"].as<JsonArrayConst>()) {
    if (item["modality"] == "AUDIO") audioInput += item["tokenCount"].as<uint32_t>();
    else textInput += item["tokenCount"].as<uint32_t>();
  }
  for (JsonVariantConst item : usage["responseTokensDetails"].as<JsonArrayConst>()) {
    if (item["modality"] == "AUDIO") audioOutput += item["tokenCount"].as<uint32_t>();
    else textOutput += item["tokenCount"].as<uint32_t>();
  }
}

void receiveMessage(uint8_t* bytes, size_t length) {
  JsonDocument message;
  if (deserializeJson(message, reinterpret_cast<char*>(bytes), length)) { failed = true; return; }
  if (message["error"].is<JsonObject>()) {
    Serial.printf("[LIVE ERROR] Provider code=%d (details withheld to protect session credentials)\n", message["error"]["code"].as<int>());
    failed = true;
    return;
  }
  if (!message["setupComplete"].isNull()) {
    state.store(RomiSessionState::Active);
    lastActivityAt = millis();
    setMicCapture(true);
    JsonDocument greeting;
    greeting["realtimeInput"]["text"] = "ابدئي الكلام بتحية مصرية قصيرة، وعرّفي بنفسك باسم رومي.";
    if (!sendJson(greeting)) failed = true;
    Serial.println("[LIVE] Active: microphone and speaker on ESP32; no dashboard required");
  }
  trackUsage(message["usageMetadata"]);
  JsonVariantConst server = message["serverContent"];
  if (server["interrupted"] == true) clearSpeakerAudio();
  if (!server["inputTranscription"].isNull() || !server["interimInputTranscription"].isNull()) lastActivityAt = millis();
  if (server["turnComplete"] == true) { turnFinished = true; lastActivityAt = millis(); }
  for (JsonVariantConst part : server["modelTurn"]["parts"].as<JsonArrayConst>()) {
    const char* audio = part["inlineData"]["data"];
    if (!audio) continue;
    const String mime = part["inlineData"]["mimeType"].as<String>();
    if (!mime.startsWith("audio/pcm") || (mime.indexOf("rate=") >= 0 && mime.indexOf("rate=24000") < 0) ||
        !queueSpeakerAudio(audio)) {
      if (!currentVisitor()) return;
      Serial.println("[AUDIO ERROR] Unsupported PCM or playback capacity exceeded; closing safely");
      failed = true;
      return;
    }
    if (firstLatency < 0) firstLatency = millis() - startedAt;
    lastActivityAt = millis();
    if (!finishAfterAudio) turnFinished = false;
  }
  for (JsonVariantConst call : message["toolCall"]["functionCalls"].as<JsonArrayConst>()) {
    if (!currentVisitor() || failed || finishAfterAudio) break;
    executeTool(call);
  }
  for (JsonVariantConst cancelled : message["toolCallCancellation"]["ids"].as<JsonArrayConst>()) {
    if (cancelled.as<String>() == pendingCallId) { waitingDoor = false; pendingToolResult.clear(); }
  }
  if (!message["goAway"].isNull()) {
    finishAfterAudio = true;
    closingAt = millis();
    setMicCapture(false);
    state.store(RomiSessionState::Closing);
  }
}

void socketEvent(WStype_t type, uint8_t* payload, size_t length) {
  if (!currentVisitor()) return;
  if (type == WStype_CONNECTED) {
    socket->setReconnectInterval(60000);
    if (!socket->sendTXT(setupMessage)) failed = true;
    wipeString(setupMessage);
    Serial.println("[LIVE] WebSocket connected; waiting for setupComplete");
  } else if (type == WStype_TEXT || type == WStype_BIN) {
    if (length > romi::LIVE_MAX_MESSAGE_BYTES) failed = true;
    else receiveMessage(payload, length);
  } else if (type == WStype_FRAGMENT_TEXT_START || type == WStype_FRAGMENT_BIN_START) {
    fragment = String();
    if (length > romi::LIVE_MAX_MESSAGE_BYTES || !fragment.concat(reinterpret_cast<char*>(payload), length)) failed = true;
  } else if (type == WStype_FRAGMENT || type == WStype_FRAGMENT_FIN) {
    if (fragment.length() + length > romi::LIVE_MAX_MESSAGE_BYTES ||
        !fragment.concat(reinterpret_cast<char*>(payload), length)) { failed = true; return; }
    if (type == WStype_FRAGMENT_FIN) {
      receiveMessage(reinterpret_cast<uint8_t*>(const_cast<char*>(fragment.c_str())), fragment.length());
      wipeString(fragment);
    }
  } else if (type == WStype_DISCONNECTED || type == WStype_ERROR) {
    if (finishAfterAudio) turnFinished = true;
    else failed = true;
    Serial.println("[LIVE] Socket disconnected/error");
  }
}

bool openSession() {
  state.store(RomiSessionState::Starting);
  sessionEpoch = epoch.load();
  requestId = newRequestId();
  startedAt = lastActivityAt = millis();
  failed = finishAfterAudio = turnFinished = waitingDoor = false;
  textInput = textOutput = audioInput = audioOutput = 0;
  firstLatency = -1;
  clearSpeakerAudio();
  enableSpeakerPlayback(true);
  JsonDocument request, response;
  request["request_id"] = requestId;
  String body;
  serializeJson(request, body);
  const int status = apiRequest("/api/ai/session", body, response);
  const char* token = response["token"];
  sessionCreated = status == 200;
  if (!sessionCreated || response["request_id"].as<String>() != requestId || !currentVisitor()) {
    if (token) memset(const_cast<char*>(token), 0, strlen(token));
    Serial.println("[LIVE ERROR] Session request failed, mismatched or cancelled");
    return false;
  }
  if (!token || strncmp(token, "auth_tokens/", 12) != 0) {
    if (token) memset(const_cast<char*>(token), 0, strlen(token));
    Serial.println("[LIVE ERROR] Server did not return a supported ephemeral token");
    return false;
  }
  JsonDocument setup;
  if (!buildLiveSetup(setup, response.as<JsonVariantConst>())) {
    memset(const_cast<char*>(token), 0, strlen(token));
    return false;
  }
  serializeJson(setup, setupMessage);
  String encodedToken;
  for (const char* cursor = token; *cursor; ++cursor) {
    if (isalnum(static_cast<unsigned char>(*cursor)) || *cursor == '_' || *cursor == '-' || *cursor == '.') encodedToken += *cursor;
    else { char escaped[4]; snprintf(escaped, sizeof(escaped), "%%%02X", static_cast<unsigned char>(*cursor)); encodedToken += escaped; }
  }
  String url = String("/ws/google.ai.generativelanguage.") + romi::GEMINI_API_VERSION +
      ".GenerativeService.BidiGenerateContentConstrained?access_token=" + encodedToken;
  socket.reset(new RomiSocket());
  socket->onEvent(socketEvent);
  socket->setReconnectInterval(0);  // First attempt is immediate; failures close the visitor session.
  socket->beginSslWithCA(romi::GEMINI_HOST, 443, url.c_str(), ROMI_GEMINI_ROOT_CA, "");
  socket->enableHeartbeat(15000, 3000, 2);
  wipeString(encodedToken);
  wipeString(url);
  memset(const_cast<char*>(token), 0, strlen(token));
  Serial.printf("[LIVE] Starting visitor %s; free heap=%u\n", requestId.substring(0, 8).c_str(), ESP.getFreeHeap());
  return true;
}

void closeSession(bool providerError) {
  state.store(RomiSessionState::Closing);
  setMicCapture(false);
  enableSpeakerPlayback(false);
  clearSpeakerAudio();
  if (socket) { socket->onEvent(nullptr); socket->disconnect(); socket->eraseTokenUrl(); socket.reset(); }
  micEnabled = false;
  wipeString(setupMessage);
  wipeString(fragment);
  pendingToolResult.clear();
  waitingDoor = false;
  if (sessionCreated) {
    JsonDocument usage, response;
    usage["request_id"] = requestId;
    usage["text_input_tokens"] = min<uint32_t>(textInput, 2000000);
    usage["text_output_tokens"] = min<uint32_t>(textOutput, 2000000);
    usage["audio_input_tokens"] = min<uint32_t>(audioInput, 2000000);
    usage["audio_output_tokens"] = min<uint32_t>(audioOutput, 2000000);
    if (firstLatency < 0) usage["latency_ms"] = nullptr;
    else usage["latency_ms"] = firstLatency;
    usage["outcome"] = providerError ? "provider_error" : "completed";
    String body;
    serializeJson(usage, body);
    const int saved = apiRequest("/api/ai/usage", body, response);
    if (saved != 200) Serial.println("[LIVE WARN] Usage could not be saved");
  }
  requestId = pendingCallId = pendingCallName = pendingCommandId = String();
  sessionCreated = false;
  if (epoch.load() == sessionEpoch) requested.store(false);
  state.store(providerError ? RomiSessionState::Error : RomiSessionState::Idle);
  Serial.printf("[LIVE] Session cleaned up; heap=%u\n", ESP.getFreeHeap());
}

void pollDoorResult() {
  if (!waitingDoor || static_cast<int32_t>(millis() - nextDoorStatusAt) < 0) return;
  JsonDocument response;
  const int status = apiRequest(String("/api/ai/door-status?request_id=") + requestId, "", response, true);
  if (!currentVisitor()) return;
  const String commandStatus = response["command"]["status"].as<String>();
  if (status == 200 && response["command"]["simulated"].is<bool>() && response["command"]["simulated"] == false &&
      (commandStatus == "opened" || commandStatus == "failed" || commandStatus == "expired")) {
    pendingToolResult["result"] = commandStatus == "opened" ? "door_opened" : "door_failed";
  } else if (millis() - doorWaitAt > 18000) {
    pendingToolResult["result"] = "door_pending";
  } else { nextDoorStatusAt = millis() + 1000; return; }
  sendToolResult(pendingCallId, pendingCallName, pendingToolResult.as<JsonVariantConst>());
  pendingToolResult.clear();
  waitingDoor = false;
  lastActivityAt = millis();
}

void streamMicrophone() {
  if (state.load() != RomiSessionState::Active || finishAfterAudio || speakerPlaying() || waitingDoor) return;
  RomiMicFrame frame;
  if (!takeMicFrame(frame)) return;
  char encoded[857];
  size_t length = 0;
  if (mbedtls_base64_encode(reinterpret_cast<uint8_t*>(encoded), sizeof(encoded), &length,
      reinterpret_cast<uint8_t*>(frame.samples), sizeof(frame.samples)) != 0) { failed = true; return; }
  encoded[length] = 0;
  JsonDocument message;
  message["realtimeInput"]["audio"]["mimeType"] = "audio/pcm;rate=16000";
  message["realtimeInput"]["audio"]["data"] = encoded;
  if (!sendJson(message)) failed = true;
}

void liveWorker(void*) {
  for (;;) {
    if (!requested.load()) { vTaskDelay(pdMS_TO_TICKS(10)); continue; }
    if (WiFi.status() != WL_CONNECTED || time(nullptr) < 1735689600) {
      requested.store(false);
      state.store(RomiSessionState::Error);
      Serial.println("[LIVE ERROR] WiFi/time not ready; press button again when connected");
      continue;
    }
    if (!openSession()) { closeSession(currentVisitor()); continue; }
    while (currentVisitor() && !failed) {
      // Backpressure lets the I2S task drain audio before the next bounded frame arrives.
      if (speakerFreeSamples() >= romi::SPEAKER_BUFFER_SAMPLES / 2 &&
          xSemaphoreTakeRecursive(romiApiMutex(), 0) == pdTRUE) {
        // Keep transient HTTP TLS allocations out of the large provider-frame receive peak.
        socket->loop();
        xSemaphoreGiveRecursive(romiApiMutex());
      }
      if (WiFi.status() != WL_CONNECTED) { failed = true; break; }
      if (state.load() == RomiSessionState::Starting && millis() - startedAt > romi::SESSION_CONNECT_TIMEOUT_MS) { failed = true; break; }
      pollDoorResult();
      const bool capture = state.load() == RomiSessionState::Active && !finishAfterAudio && !speakerPlaying() && !waitingDoor;
      if (capture != micEnabled) { setMicCapture(capture); micEnabled = capture; }
      streamMicrophone();
      if (speakerPlaying() || waitingDoor) lastActivityAt = millis();
      else if (static_cast<int32_t>(lastMicActivity() - lastActivityAt) > 0) lastActivityAt = lastMicActivity();
      if (finishAfterAudio && ((turnFinished && !speakerPlaying()) || millis() - closingAt > romi::SESSION_CLOSE_DRAIN_MS)) break;
      if (millis() - startedAt > romi::SESSION_MAX_MS || millis() - lastActivityAt > romi::SESSION_SILENCE_TIMEOUT_MS) break;
      vTaskDelay(1);
    }
    closeSession(failed);
  }
}
}  // namespace

bool startAudioSystem(const char* deployedUrl) {
  baseUrl = deployedUrl;
  if (!initializeAudioIo()) { state.store(RomiSessionState::Error); return false; }
  if (!ROMI_BENCH_MODE && xTaskCreate(liveWorker, "romi-live", 12288, nullptr, 1, nullptr) != pdPASS) {
    state.store(RomiSessionState::Error);
    return false;
  }
  initialized = true;
  Serial.println("[LIVE] Standalone button sessions enabled; Gemini TLS uses trusted Google roots");
  return true;
}
void toggleAudioSession() {
  if (!initialized || ROMI_BENCH_MODE) { Serial.println("[LIVE] Session unavailable in audio bench/error mode"); return; }
  if (state.load() == RomiSessionState::Closing && !requested.load()) {
    Serial.println("[LIVE] Cleaning up; wait for IDLE before starting a new visitor");
    return;
  }
  const bool start = !requested.load();
  epoch.fetch_add(1);
  requested.store(start);
  if (!start) { setMicCapture(false); enableSpeakerPlayback(false); }
  state.store(start ? RomiSessionState::Starting : RomiSessionState::Closing);
  Serial.println(start ? "[BTN] Starting standalone voice session" : "[BTN] Cancelling voice session");
}
RomiSessionState audioSessionState() { return state.load(); }
void runAudioDebug(char command) {
  if (!initialized) return;
  if (command == 'M') printAudioLevels();
  if (command == 'A' && state.load() == RomiSessionState::Idle) playAudioTestTone();
}
#endif
