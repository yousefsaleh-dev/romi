#include "romi_audio_io.h"
#if ROMI_ENABLE_AUDIO
#include <atomic>
#include <driver/i2s.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include <mbedtls/base64.h>

namespace {
constexpr i2s_port_t audioPort = I2S_NUM_0;
QueueHandle_t micQueue = nullptr;
int16_t* speakerSamples = nullptr;
size_t readIndex = 0, writeIndex = 0, sampleCount = 0;
portMUX_TYPE speakerLock = portMUX_INITIALIZER_UNLOCKED;
std::atomic<bool> recording{false};
std::atomic<bool> playbackEnabled{true};
std::atomic<uint32_t> micEpoch{0};
std::atomic<uint32_t> activityAt{0}, playbackAt{0};
std::atomic<int32_t> leftPeak{0}, rightPeak{0};

bool popSpeakerSample(int16_t& sample) {
  portENTER_CRITICAL(&speakerLock);
  const bool available = sampleCount > 0;
  if (available) {
    sample = speakerSamples[readIndex];
    readIndex = (readIndex + 1) % romi::SPEAKER_BUFFER_SAMPLES;
    --sampleCount;
  }
  portEXIT_CRITICAL(&speakerLock);
  return available;
}

void pushSpeakerSample(int16_t sample) {
  portENTER_CRITICAL(&speakerLock);
  speakerSamples[writeIndex] = sample;
  writeIndex = (writeIndex + 1) % romi::SPEAKER_BUFFER_SAMPLES;
  ++sampleCount;
  portEXIT_CRITICAL(&speakerLock);
}

void audioPump(void*) {
  int32_t input[256], output[256];
  RomiMicFrame frame = {};
  size_t captured = 0;
  int decimation = 0, repetition = 0;
  int64_t sum = 0;
  int16_t playingSample = 0;
  bool hadPlayback = false;
  for (;;) {
    size_t received = 0;
    i2s_read(audioPort, input, sizeof(input), &received, pdMS_TO_TICKS(5));
    const size_t frames = received / (2 * sizeof(int32_t));
    if (frame.epoch != micEpoch.load()) { captured = 0; decimation = 0; sum = 0; frame.epoch = micEpoch.load(); }
    const bool capture = recording.load() && !speakerPlaying();
    if (!capture) { captured = 0; decimation = 0; sum = 0; }
    for (size_t index = 0; index < frames; ++index) {
      const int32_t left = input[index * 2] >> 16;
      const int32_t right = input[index * 2 + 1] >> 16;
      leftPeak.store(max(leftPeak.load(), abs(left)));
      rightPeak.store(max(rightPeak.load(), abs(right)));
      if (!capture) continue;
      sum += input[index * 2 + romi::MIC_LEFT_SLOT];
      if (++decimation < static_cast<int>(romi::I2S_CLOCK_RATE / romi::MIC_RATE)) continue;
      int64_t sample = ((sum / decimation) >> 16) * romi::MIC_GAIN;
      sample = max<int64_t>(-32768, min<int64_t>(32767, sample));
      frame.samples[captured++] = static_cast<int16_t>(sample);
      sum = 0; decimation = 0;
      if (abs(static_cast<int>(sample)) > romi::MIC_ACTIVITY_THRESHOLD) activityAt.store(millis());
      if (captured == 320) {
        if (xQueueSend(micQueue, &frame, 0) != pdTRUE) {
          RomiMicFrame discarded;
          xQueueReceive(micQueue, &discarded, 0);
          xQueueSend(micQueue, &frame, 0);
        }
        captured = 0;
      }
    }
    for (size_t index = 0; index < 128; ++index) {
      if (repetition == 0) {
        playingSample = 0;
        hadPlayback = popSpeakerSample(playingSample);
      }
      repetition = (repetition + 1) % (romi::I2S_CLOCK_RATE / romi::SPEAKER_RATE);
      if (hadPlayback) playbackAt.store(millis());
      const int32_t scaled = static_cast<int32_t>(playingSample) * romi::SPEAKER_VOLUME_PERCENT / 100;
      output[index * 2] = output[index * 2 + 1] = scaled * 65536;
    }
    size_t written = 0;
    i2s_write(audioPort, output, sizeof(output), &written, pdMS_TO_TICKS(10));
    if (!received && !written) vTaskDelay(1);
  }
}
}  // namespace

bool initializeAudioIo() {
  speakerSamples = static_cast<int16_t*>(calloc(romi::SPEAKER_BUFFER_SAMPLES, sizeof(int16_t)));
  micQueue = xQueueCreate(4, sizeof(RomiMicFrame));
  bool driverInstalled = false;
  const auto fail = [&]() {
    if (driverInstalled) i2s_driver_uninstall(audioPort);
    if (micQueue) vQueueDelete(micQueue);
    free(speakerSamples);
    micQueue = nullptr;
    speakerSamples = nullptr;
    return false;
  };
  if (!speakerSamples || !micQueue) return fail();
  i2s_config_t config = {};
  config.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_RX | I2S_MODE_TX);
  config.sample_rate = romi::I2S_CLOCK_RATE;
  config.bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT;
  config.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;
  config.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  config.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  config.dma_buf_count = 4;
  config.dma_buf_len = 128;
  config.use_apll = true;
  config.tx_desc_auto_clear = true;
  i2s_pin_config_t pins = {};
  pins.mck_io_num = I2S_PIN_NO_CHANGE;
  pins.bck_io_num = romi::I2S_BCLK_PIN;
  pins.ws_io_num = romi::I2S_LRCLK_PIN;
  pins.data_out_num = romi::I2S_AMP_DATA_PIN;
  pins.data_in_num = romi::I2S_MIC_DATA_PIN;
  if (i2s_driver_install(audioPort, &config, 0, nullptr) != ESP_OK) return fail();
  driverInstalled = true;
  if (i2s_set_pin(audioPort, &pins) != ESP_OK) return fail();
  i2s_zero_dma_buffer(audioPort);
  if (xTaskCreate(audioPump, "romi-i2s", 6144, nullptr, 2, nullptr) != pdPASS) return fail();
  Serial.println("[AUDIO] Shared 48kHz stereo/32-bit I2S clocks; mic=16kHz mono, output=24kHz mono");
  return true;
}

void setMicCapture(bool enabled) {
  recording.store(false);
  micEpoch.fetch_add(1);
  xQueueReset(micQueue);
  activityAt.store(millis());
  recording.store(enabled);
}
bool takeMicFrame(RomiMicFrame& frame) {
  return xQueueReceive(micQueue, &frame, 0) == pdTRUE && frame.epoch == micEpoch.load() && recording.load();
}
size_t speakerFreeSamples() {
  portENTER_CRITICAL(&speakerLock);
  const size_t free = romi::SPEAKER_BUFFER_SAMPLES - sampleCount;
  portEXIT_CRITICAL(&speakerLock);
  return free;
}
bool speakerPlaying() { return speakerFreeSamples() < romi::SPEAKER_BUFFER_SAMPLES ||
    (playbackAt.load() != 0 && millis() - playbackAt.load() < 250); }
uint32_t lastMicActivity() { return activityAt.load(); }
void clearSpeakerAudio() {
  portENTER_CRITICAL(&speakerLock);
  readIndex = writeIndex = sampleCount = 0;
  portEXIT_CRITICAL(&speakerLock);
}
void enableSpeakerPlayback(bool enabled) {
  playbackEnabled.store(enabled);
  if (!enabled) clearSpeakerAudio();
}

bool queueSpeakerAudio(const char* encoded) {
  const size_t length = strlen(encoded);
  if (length == 0 || length % 4 != 0) return false;
  size_t decodedBytes = length / 4 * 3;
  if (encoded[length - 1] == '=') --decodedBytes;
  if (encoded[length - 2] == '=') --decodedBytes;
  if (decodedBytes % 2) return false;
  uint8_t decoded[192];
  bool lowBytePresent = false;
  uint8_t lowByte = 0;
  for (size_t offset = 0; offset < length; offset += 256) {
    size_t used = 0;
    if (mbedtls_base64_decode(decoded, sizeof(decoded), &used,
        reinterpret_cast<const uint8_t*>(encoded + offset), min<size_t>(256, length - offset)) != 0) {
      clearSpeakerAudio();
      return false;
    }
    for (size_t index = 0; index < used; ++index) {
      if (!lowBytePresent) lowByte = decoded[index];
      else {
        const uint32_t waitAt = millis();
        while (speakerFreeSamples() == 0 && playbackEnabled.load() && millis() - waitAt < 1000) vTaskDelay(1);
        if (!playbackEnabled.load() || speakerFreeSamples() == 0) return false;
        pushSpeakerSample(static_cast<int16_t>(lowByte | static_cast<uint16_t>(decoded[index]) << 8));
      }
      lowBytePresent = !lowBytePresent;
    }
  }
  return !lowBytePresent;
}

void printAudioLevels() {
  Serial.printf("[AUDIO] raw16 peak slot0=%ld slot1=%ld free speaker samples=%u heap=%u\n",
      static_cast<long>(leftPeak.exchange(0)), static_cast<long>(rightPeak.exchange(0)),
      static_cast<unsigned>(speakerFreeSamples()), ESP.getFreeHeap());
}
void playAudioTestTone() {
  if (speakerPlaying()) return;
  for (int index = 0; index < 2400; ++index) pushSpeakerSample(index % 48 < 24 ? 4000 : -4000);
  Serial.println("[AUDIO] 500Hz test tone, 100ms (output volume applies)");
}
#endif
