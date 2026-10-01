#include "romi_http.h"

#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

#include "romi_config.h"
#if __has_include("romi_secrets.h")
#include "romi_secrets.h"
#else
#include "romi_secrets.example.h"
#endif

namespace {
QueueHandle_t jobQueue = nullptr;
QueueHandle_t resultQueue = nullptr;
String deployedBaseUrl;
SemaphoreHandle_t apiMutex = nullptr;

// HTTPClient decodes chunked responses through this stream without growing RAM.
class BoundedResponse : public Stream {
 public:
  explicit BoundedResponse(RomiHttpResult& response) : response_(response) {}
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
  size_t write(uint8_t byte) override { return write(&byte, 1); }
  size_t write(const uint8_t* bytes, size_t count) override {
    if (length_ + count >= sizeof(response_.body)) return 0;
    memcpy(response_.body + length_, bytes, count);
    length_ += count;
    response_.body[length_] = '\0';
    return count;
  }

 private:
  RomiHttpResult& response_;
  size_t length_ = 0;
};

RomiHttpResult performRequest(const RomiHttpJob& job) {
  RomiHttpResult response;
  response.kind = job.kind;
  if (WiFi.status() != WL_CONNECTED) return response;
  if (xSemaphoreTakeRecursive(apiMutex, pdMS_TO_TICKS(15000)) != pdTRUE) return response;
  WiFiClientSecure client;
#if ROMI_ALLOW_INSECURE_TLS_FOR_DEMO
  client.setInsecure();
#else
  client.setCACert(ROMI_ROOT_CA_BUNDLE);
#endif
  client.setHandshakeTimeout(romi::TLS_HANDSHAKE_TIMEOUT_SECONDS);
  HTTPClient http;
  http.setConnectTimeout(romi::API_CONNECT_TIMEOUT_MS);
  http.setTimeout(romi::API_READ_TIMEOUT_MS);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  const char* path = job.kind == RomiRequestKind::Poll
      ? "/api/device/commands" : "/api/device/commands/ack";
  if (!http.begin(client, deployedBaseUrl + path)) {
    xSemaphoreGiveRecursive(apiMutex);
    return response;
  }
  http.addHeader("Authorization", String("Bearer ") + ROMI_DEVICE_TOKEN);
  http.addHeader("Content-Type", "application/json");
  response.status = job.kind == RomiRequestKind::Poll ? http.GET() : http.POST(String(job.body));
  if (response.status > 0) {
    BoundedResponse stream(response);
    if (http.writeToStream(&stream) < 0) response.status = -1000;
  }
  http.end();
  xSemaphoreGiveRecursive(apiMutex);
  return response;
}

void httpWorker(void*) {
  for (;;) {
    RomiHttpJob job;
    if (xQueueReceive(jobQueue, &job, portMAX_DELAY) != pdTRUE) continue;
    const RomiHttpResult response = performRequest(job);
    xQueueSend(resultQueue, &response, portMAX_DELAY);
  }
}
}  // namespace

bool startHttpWorker(const char* baseUrl) {
  deployedBaseUrl = baseUrl;
  apiMutex = xSemaphoreCreateRecursiveMutex();
  jobQueue = xQueueCreate(1, sizeof(RomiHttpJob));
  resultQueue = xQueueCreate(1, sizeof(RomiHttpResult));
  if (apiMutex && jobQueue && resultQueue &&
      xTaskCreate(httpWorker, "romi-http", 8192, nullptr, 1, nullptr) == pdPASS) return true;
  if (jobQueue) vQueueDelete(jobQueue);
  if (resultQueue) vQueueDelete(resultQueue);
  if (apiMutex) vSemaphoreDelete(apiMutex);
  apiMutex = nullptr;
  jobQueue = nullptr;
  resultQueue = nullptr;
  return false;
}

bool submitHttpJob(const RomiHttpJob& job) {
  return jobQueue && xQueueSend(jobQueue, &job, 0) == pdTRUE;
}

bool takeHttpResult(RomiHttpResult& response) {
  return resultQueue && xQueueReceive(resultQueue, &response, 0) == pdTRUE;
}
SemaphoreHandle_t romiApiMutex() { return apiMutex; }
