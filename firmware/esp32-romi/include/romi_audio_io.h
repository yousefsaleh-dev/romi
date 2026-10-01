#pragma once
#include "romi_config.h"
#if ROMI_ENABLE_AUDIO
struct RomiMicFrame { int16_t samples[320]; uint32_t epoch; };
bool initializeAudioIo();
void setMicCapture(bool enabled);
bool takeMicFrame(RomiMicFrame& frame);
bool queueSpeakerAudio(const char* base64);
void clearSpeakerAudio();
void enableSpeakerPlayback(bool enabled);
bool speakerPlaying();
size_t speakerFreeSamples();
uint32_t lastMicActivity();
void printAudioLevels();
void playAudioTestTone();
#endif
