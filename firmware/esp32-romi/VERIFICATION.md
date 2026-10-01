# Verification record — 2026-10-01

## Passed in this workspace

Target: classic ESP32 (`esp32dev`), PlatformIO Core 6.2.0, `espressif32@6.12.0`, Arduino ESP32 2.0.17, ArduinoJson 7.4.3, ESP32Servo 3.2.1. Audio disabled throughout.

The network profiles were compiled with a temporary synthetic credentials header to ensure their network paths were included. This header contained no live credentials, used `https://romi.invalid`, and was removed after compilation. Its dummy CA was for compilation only; it cannot authenticate a server.

| Profile | Result | Static RAM | Flash | Build time |
| --- | --- | --- | --- | --- |
| Offline bench | SUCCESS | 22,012 bytes / 6.7% | 353,785 bytes / 27.0% | 20.20 s |
| Demo, certificate validation enabled | SUCCESS | 47,316 bytes / 14.4% | 972,917 bytes / 74.2% | 11.00 s |
| Safe, certificate validation enabled | SUCCESS | 47,316 bytes / 14.4% | 972,109 bytes / 74.2% | 11.16 s |
| Demo, explicit insecure TLS | SUCCESS | 47,316 bytes / 14.4% | 972,889 bytes / 74.2% | 11.25 s |
| Safe, example settings restored | SUCCESS | 45,496 bytes / 13.9% | 813,929 bytes / 62.1% | 21.09 s |

Static RAM excludes runtime allocations, including TLS, task stacks and queues; hardware testing must check actual free memory and stability. The smaller example build fails closed when private settings are absent and must not be mistaken for a provisioned network build.

- `pnpm lint`: passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed; includes `/dashboard/kiosk`.
- `pnpm test:device-door`: 7 passed, 0 failed. Covers authenticated status reads, physical success, physical failure, rejecting simulated success, pending timeout, cancellation, auth failure and malformed JSON.
- Launcher parser/diagnostics tested in PowerShell 7 and Windows PowerShell 5.1. Fixed JSON port enumeration for 5.1.
- Trusted root discovery tested against public `https://vercel.com` in both PowerShell versions. This verifies the discovery helper, not a ROMI deployment.
- Offline upload with no board correctly refused instead of selecting Intel SOL COM3. No flash was attempted.
- Private settings, local mode overrides, tool caches and environment files are Git-ignored. Local mode was restored to safe.

## Pending physical/deployment verification

No ESP32 USB board is present in this workspace. GPIO, servo movement, power stability, button debounce under network load, reconnect behavior and memory use on a live device remain unverified.

ROMI is not yet deployed to Vercel. `smoke:device:external` is prepared but its live deployment checks and isolated synthetic command/ACK cycle remain unexecuted. Follow [HACKATHON.md](HACKATHON.md) after deployment and before the event.

The browser physical fallback is implemented and typechecked, but a live browser/Gemini/ESP32 end-to-end exchange still needs testing. No backend routes, auth rules or database migrations were changed for this fallback.

## Explicitly unfinished capabilities

- ESP32 Gemini session creation, I2S capture/playback and Live WebSocket transport. `ROMI_ENABLE_AUDIO=1` fails explicitly; there is no tested standalone audio mode.
- Physical button control of the browser. The button currently toggles local firmware session state; browser controls start/stop voice.
- Production door feedback. The verification hook returns failure without a sensor; demo alone may assume timed movement succeeded.
- Different ESP32 families. S3/C3 require board selection, pin review and verification; this classic target is not a universal image.
- Recovery/redelivery of already claimed commands after a reset. The existing server marks a polled command `sent` and does not redeliver it; see the field guide before retrying a demonstration.

## Files changed for the independent operator kit

Added `romi.ps1`, `include/romi_http.h`, `src/romi_http.cpp`, this record, `src/app/dashboard/kiosk/page.tsx`, `src/lib/ai/device-door.ts` and `scripts/device-door.test.mjs`.

Updated core/config/PlatformIO, `.gitignore`, the browser voice component and dashboard navigation, package scripts, the firmware README/Arabic guide, root README and the four integration/design/API docs. Earlier core firmware and external smoke scripts remain in the repository.
