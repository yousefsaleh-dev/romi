#pragma once

#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

enum class RomiRequestKind { Poll, Acknowledge };

struct RomiHttpJob {
  RomiRequestKind kind;
  char body[192] = {};
};

struct RomiHttpResult {
  RomiRequestKind kind;
  int status = -1;
  char body[2048] = {};
};

bool startHttpWorker(const char* baseUrl);
bool submitHttpJob(const RomiHttpJob& job);
bool takeHttpResult(RomiHttpResult& response);
SemaphoreHandle_t romiApiMutex();
