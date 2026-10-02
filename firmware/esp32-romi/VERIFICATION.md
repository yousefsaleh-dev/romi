# Verification record — 2026-10-01

**Latest status note — 2026-10-02:** after the successful deployed runs below, the published Google key returned HTTP 401 / ACCESS_TOKEN_TYPE_UNSUPPORTED. Voice availability requires a replacement key on Vercel and a new verification; the passing runs remain historical evidence. Current firmware settings include the deployed origin, device token and validated root CA, with Wi-Fi placeholders. Server `.env.local` is now ignored and untracked. No physical board has been flashed or tested. See the last section of [deployment results](../../docs/deployment-device-tests.md) and the [Arabic handoff](../../docs/hackathon-handoff-prompt.md).

## Native and core firmware builds

Target: classic ESP32 DevKit V1 / ESP-WROOM-32 (`esp32dev`). PlatformIO 6.2.0, espressif32 6.12.0, Arduino ESP32 2.0.17, ArduinoJson 7.4.3, ESP32Servo 3.2.1; full adds WebSockets 2.7.3. Core explicitly excludes WebSockets.

Network builds used a temporary **synthetic** settings header (`romi.invalid`, nonfunctional compile-only CA) so network/audio code was retained by the linker. It contained no live credentials and was removed afterward. Local flags were restored to safe. The smaller example-settings image fails closed at runtime and is not a provisioned board.

| Profile | Result | Static RAM / 327,680 | Flash / 1,310,720 | Time |
| --- | --- | --- | --- | --- |
| Full native audio + demo verification, final pass | SUCCESS | 47,792 / 14.6% | 1,045,849 / 79.8% | 12.98 s |
| Full native audio + sensor-required verification, final pass | SUCCESS | 47,792 / 14.6% | 1,044,733 / 79.7% | 14.24 s |
| Audio-disabled safe core, final pass | SUCCESS | 47,316 / 14.4% | 972,173 / 74.2% | 11.20 s |
| Offline audio bench, preceding matrix pass | SUCCESS | 22,424 / 6.8% | 377,681 / 28.8% | 9.22 s |
| Audio-disabled demo, preceding matrix pass | SUCCESS | 47,316 / 14.4% | 972,985 / 74.2% | 21.71 s |
| Offline core bench, preceding matrix pass | SUCCESS | 22,012 / 6.7% | 353,785 / 27.0% | 8.68 s |

Static RAM excludes runtime task stacks, TLS, WebSocket frames, JSON and queues. The firmware fits the partition; stable heap under real speech, concurrent tool requests and long sessions must be measured on a board. `M` logs microphone peaks and free heap. I2S runs separately from the main GPIO loop. API requests share a recursive mutex with large provider-frame reception to limit allocation overlap.

## Real Gemini wire verification

`pnpm smoke:esp32:live` passed using the actual server Live model/config and a one-use ephemeral token, with the same raw setup envelope and v1beta constrained endpoint as the firmware. It sent synthetic PCM16 mono 16 kHz input and received real PCM16 mono 24 kHz output: **15 audio chunks, largest message 41,263 bytes** on the passing run. Earlier responses reached 51,499 bytes, exposing the dependency's insufficient 15 KiB default. The full target now bounds frames at 64 KiB and applies a guarded patch to the pinned dependency definition.

The probe accesses Gemini only: no Supabase, patient data or door. It verifies auth/URL/setup and provider PCM format from the development PC; it does not execute the ESP32 I2S driver or prove embedded memory stability. Node WebSocket support is required for the development probe (tested Node 24.18.0).

## Other checks

- `pnpm lint`: passed without warnings after updating the wire probe.
- `pnpm typecheck`: passed.
- `pnpm test:device-door`: 7 passed, 0 failed. Authenticated status reads, physical success/failure, rejecting simulated success, pending timeout, cancellation, auth failure and malformed JSON.
- `node --check scripts/esp32-live-wire-smoke.mjs`: passed.
- Next.js production build passed for the existing kiosk implementation before native firmware was added. Native work changed package scripts and firmware/docs, not web/backend routes.
- Launcher diagnostics run in PowerShell 7 and Windows PowerShell 5.1. Only Intel SOL COM3 was present; it is correctly excluded from USB board selection.
- Trusted root discovery previously verified against public vercel.com in both PowerShell versions. This tests the helper, not ROMI's eventual deployment.
- The earlier build matrix used synthetic settings; the later preloaded-settings builds below use the real deployment header. No Gemini/Supabase server secret is embedded in firmware. Current server env files, caches and local mode flags stay ignored; previously published keys remain in history.

## Implemented versus still unfinished

**Implemented:** millis button/servo/LED state handling, Wi-Fi/NTP, bounded HTTPS worker, command expiry/duplicate checks, ACK/retry/backoff, native I2S mic/speaker, fresh UUID session creation from GPIO33, direct ephemeral Live WebSocket, current tool APIs, read-only physical door confirmation, cancellation/silence timeout, token cleanup and usage reporting. Phone browser voice is a fallback, not a PC microphone assumption.

**Stub:** production `doorOpenFeedback()` returns false until a physical sensor is integrated. Timed demo servo verification is explicit and logs its assumption. Audio-disabled core has a local session stub; it cannot remotely start phone voice.

**Needs real hardware:** I2S channel ordering/gain/output levels, microphone/speaker quality, half duplex operation, power/current spikes, servo angles, GPIO behavior under network stalls, embedded TLS/free heap, reconnect/brownout/reset and a complete physical button-to-voice-to-door cycle. No ESP32 USB board is available here; nothing was flashed.

**Deployment update — 2026-10-02:** all seven full external protocol groups now pass at https://romi-deci.vercel.app after the owner applied migration 0007 and updated the Gemini key. Earlier provisioning and door-retry failures, their reproductions and subsequent successful retests are recorded in [actual deployment results](../../docs/deployment-device-tests.md). The test uses real API-issued sessions/provider audio and synthetic ACKs; physical hardware remains unverified.

**Other limits:** different ESP32 families/components need board/pin/driver review. Native audio has no echo cancellation and pauses capture during playback. API response bound is 32 KiB, so long availability ranges can fail explicitly. The backend does not redeliver claimed `sent` commands after restart. Native firmware work did not change backend routes or authentication; later deployment testing added the narrowly scoped SQL fix described above.

## Changed files

**Latest full deployment test — 2026-10-02:** with the updated Gemini key, `pnpm smoke:esp32:deployed` passed all seven groups (exit 0), including real API-issued ephemeral sessions, constrained raw Live WebSocket, 16 PCM24k chunks (largest message 46,392 bytes), usage/idempotency and the complete synthetic door lifecycle. This supersedes the earlier provider/migration blockers. No physical motion or ESP32 audio is proven.

**Preloaded-settings builds — 2026-10-02:** using the real deployed origin/device token/validated GlobalSign root and a temporary synthetic Wi-Fi name/password (removed/restored afterward), full build SUCCESS in 22.39 s: RAM 47,792 / 14.6%, flash 1,048,313 / 80.0%. Audio-disabled safe core SUCCESS in 12.00 s: RAM 47,316 / 14.4%, flash 973,405 / 74.3%. Only Wi-Fi placeholders remain in the tracked settings; the launcher replaces them interactively at first network flash. Wi-Fi-only setup passed PowerShell 7 and Windows PowerShell 5.1 checks for preserving URL/token/CA, escaping $, quotes/backslashes, and rejecting blank SSID without saving. Local mode flags were restored. No board was flashed.

**Post-migration deployment retest — 2026-10-02:** after the owner applied migration 0007, six door-only deployed protocol groups passed (exit 0), including retry reservation, positive ACK → checked_in, duplicate ACK and consumed-code rejection. Seeded sessions isolate this check from Gemini. Provisioning/voice and physical hardware remain unverified by this run. The earlier remote-migration blocker is resolved.

Added: `include/romi_audio.h`, `romi_audio_io.h`, `romi_live_protocol.h`, `romi_gemini_ca.h`; `src/romi_audio_io.cpp`, `romi_live.cpp`; `scripts/websocket_limits.py`; `STANDALONE.md`; repository `scripts/esp32-live-wire-smoke.mjs`.

Updated: `src/main.cpp`, `romi_http.cpp`; `include/romi_config.h`, `romi_http.h`, `romi_secrets.example.h`; `platformio.ini`, `romi.ps1`; package scripts; firmware README/HACKATHON/this record; root README and API/architecture/ESP32/system-design docs. The separate earlier owner-requested configuration commit contains `.env.local`, `ROMI.zip` and ignore changes.

Follow [the plain Arabic steps](STANDALONE.md) and [recovery guide](HACKATHON.md).
