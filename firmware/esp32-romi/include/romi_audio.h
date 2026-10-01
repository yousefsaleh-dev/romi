#pragma once
#include "romi_config.h"

enum class RomiSessionState { Idle, Starting, Active, Closing, Error };

#if ROMI_ENABLE_AUDIO
bool startAudioSystem(const char* baseUrl);
void toggleAudioSession();
RomiSessionState audioSessionState();
void runAudioDebug(char command);
#else
inline bool startAudioSystem(const char*) { return true; }
inline void toggleAudioSession() {}
inline RomiSessionState audioSessionState() { return RomiSessionState::Idle; }
inline void runAudioDebug(char) {}
#endif
