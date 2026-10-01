#pragma once

#include <Arduino.h>

// The launcher writes ignored local mode overrides; pins and timings stay here.
#if __has_include("romi_local.h")
#include "romi_local.h"
#endif
#ifndef ROMI_ENABLE_AUDIO
#define ROMI_ENABLE_AUDIO 0
#endif
#ifndef ROMI_DEMO_ASSUME_SERVO_MOVED
#define ROMI_DEMO_ASSUME_SERVO_MOVED 0
#endif
#ifndef ROMI_HACKATHON_DEBUG_MODE
#define ROMI_HACKATHON_DEBUG_MODE 0
#endif
#ifndef ROMI_ALLOW_INSECURE_TLS_FOR_DEMO
#define ROMI_ALLOW_INSECURE_TLS_FOR_DEMO 0
#endif
#ifndef ROMI_BENCH_MODE
#define ROMI_BENCH_MODE 0
#endif

namespace romi {
static constexpr uint8_t SERVO_PIN = 23;
static constexpr uint8_t BUTTON_PIN = 33;
static constexpr uint8_t RED_LED_PIN = 25;
static constexpr uint8_t GREEN_LED_PIN = 26;

// The microphone and amplifier intentionally share BCLK and LRCLK.
static constexpr uint8_t I2S_BCLK_PIN = 14;
static constexpr uint8_t I2S_LRCLK_PIN = 27;
static constexpr uint8_t I2S_MIC_DATA_PIN = 32;
static constexpr uint8_t I2S_AMP_DATA_PIN = 22;

static constexpr int DOOR_CLOSED_ANGLE = 0;
static constexpr int DOOR_OPEN_ANGLE = 90;
static constexpr uint32_t SERVO_MOVE_WAIT_MS = 650;
static constexpr uint32_t SERVO_OPEN_HOLD_MS = 1500;
static constexpr uint32_t BUTTON_DEBOUNCE_MS = 45;
static constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 12000;
static constexpr uint32_t WIFI_RETRY_MS = 5000;
static constexpr uint32_t TIME_RETRY_MS = 5000;
static constexpr uint32_t API_DEFAULT_POLL_MS = 1500;
static constexpr uint32_t API_MIN_POLL_MS = 500;
static constexpr uint32_t API_MAX_POLL_MS = 10000;
static constexpr uint32_t API_BACKOFF_MAX_MS = 30000;
static constexpr uint32_t API_CONNECT_TIMEOUT_MS = 2000;
static constexpr uint32_t API_READ_TIMEOUT_MS = 2500;
static constexpr uint32_t TLS_HANDSHAKE_TIMEOUT_SECONDS = 5;
static constexpr uint32_t COMMAND_EXPIRY_GUARD_MS = 6000;
// More than the number of full servo cycles possible during a 20-second command TTL.
static constexpr size_t RECENT_COMMAND_COUNT = 16;

static_assert(DOOR_CLOSED_ANGLE >= 0 && DOOR_CLOSED_ANGLE <= 180, "Invalid closed angle");
static_assert(DOOR_OPEN_ANGLE >= 0 && DOOR_OPEN_ANGLE <= 180, "Invalid open angle");
static_assert(SERVO_MOVE_WAIT_MS * 2 + SERVO_OPEN_HOLD_MS + COMMAND_EXPIRY_GUARD_MS < 20000,
              "Door cycle is too slow for the server's 20-second command lifetime");
static_assert((SERVO_MOVE_WAIT_MS * 2 + SERVO_OPEN_HOLD_MS) * RECENT_COMMAND_COUNT > 20000,
              "Duplicate history must cover every servo cycle within command lifetime");
}  // namespace romi
