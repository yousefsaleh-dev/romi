#pragma once
#include <ArduinoJson.h>
#include "romi_config.h"

#if ROMI_ENABLE_AUDIO
// Adapt the SDK-shaped backend config to the raw WebSocket setup envelope.
inline bool buildLiveSetup(JsonDocument& setupEnvelope, JsonVariantConst session) {
  const char* model = session["model"];
  if (!model || !session["config"].is<JsonObjectConst>()) return false;
  JsonObject setup = setupEnvelope["setup"].to<JsonObject>();
  setup["model"] = String(model).startsWith("models/") ? String(model) : String("models/") + model;
  JsonVariantConst config = session["config"];
  setup["generationConfig"]["responseModalities"] = config["responseModalities"];
  setup["generationConfig"]["speechConfig"] = config["speechConfig"];
  setup["tools"] = config["tools"];
  setup["inputAudioTranscription"] = config["inputAudioTranscription"];
  setup["outputAudioTranscription"] = config["outputAudioTranscription"];
  const char* instruction = config["systemInstruction"];
  if (!instruction) return false;
  setup["systemInstruction"]["parts"][0]["text"] = instruction;
  return !setupEnvelope.overflowed();
}
#endif
