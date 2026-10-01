# ROMI ESP32 core firmware

PlatformIO target: `romi-devkit-v1` (`esp32dev`, classic ESP32 / ESP-WROOM-32). The core controls one SG90 servo, one active-low button, two LEDs, Wi-Fi, and the existing device command API. Audio is disabled by default. The browser simulator remains the microphone, speaker, and Gemini Live client for the safe fallback.

## Configure and build

1. Copy `include/romi_secrets.example.h` to the Git-ignored `include/romi_secrets.h`. Enter `ROMI_WIFI_SSID`, `ROMI_WIFI_PASSWORD`, the deployed HTTPS `ROMI_API_BASE_URL`, and `ROMI_DEVICE_TOKEN`. The token must match the server's device token. Put the app host's trusted root CA PEM in `ROMI_ROOT_CA_BUNDLE`. The example header compiles but fails closed at runtime.
2. Set all pins, angles, timings, and demo flags in `include/romi_config.h`.
3. Run `python -m platformio run -d firmware/esp32-romi -e romi-devkit-v1` from the repo root. Upload with `python -m platformio run -d firmware/esp32-romi -e romi-devkit-v1 -t upload` and monitor at 115200 baud.

`ROMI_ALLOW_INSECURE_TLS_FOR_DEMO=0` is the default. Only set it to `1` on a controlled demo network if a valid CA cannot be configured; Serial announces the loss of certificate validation. HTTPS is required in either case. The firmware waits for NTP before HTTPS and before evaluating command expiry. No Gemini or Supabase server secret belongs on the board.

## Wiring

| Part | ESP32 pin | Power |
| --- | --- | --- |
| SG90 signal | GPIO23 | External 5 V, common GND |
| Button to GND | GPIO33, `INPUT_PULLUP` | ESP32 input only |
| Red LED through 330 Ω | GPIO25 | LED cathode to GND |
| Green LED through 330 Ω | GPIO26 | LED cathode to GND |
| INMP441 BCLK / WS / SD | GPIO14 / GPIO27 / GPIO32 | 3.3 V only, common GND |
| MAX98357A BCLK / LRC / DIN | GPIO14 / GPIO27 / GPIO22 | External 5 V, common GND |

The audio parts are optional and are not driven by this build. GPIO14 and GPIO27 are intentionally shared clock lines; microphone and amplifier data pins are separate. Connect the speaker across MAX98357A `+` and `-`, never to ground. Use a common ground for ESP32, external supply, servo, amplifier, and microphone. A 1000 µF capacitor (at least 10 V rated) may go across the external 5 V rail. Do not feed that rail into the USB-powered ESP32, and do not power the servo from a GPIO. Wokwi audio chips are visual wiring placeholders, not an audio test.

## Behavior and verification

The single debounced GPIO33 button toggles a **local** session state: idle press starts it, active press cancels it. It never opens the door. Because there is no ESP32 Gemini Live client yet, this button does not create an `/api/ai/session` token or remotely start/stop a separate browser. Start the browser voice simulator manually in fallback mode. The session interface is separate from door polling.

The firmware polls `GET /api/device/commands`, honors `retry_after_ms`, validates UUID and expiry, and does nothing for a null or malformed command. Before moving the servo it persists the command ID in NVS to prevent a repeat after reboot. It opens, holds, closes, then sends `POST /api/device/commands/ack`. HTTP failures back off; an ACK is retried only while the server's command expiry still permits it. If the board resets after the server has claimed a command, the current server contract does not redeliver that `sent` command; manual reconciliation may be needed.

`ROMI_DEMO_ASSUME_SERVO_MOVED=0` is the safe default. The servo cycle still runs, but without a real door-position sensor the ACK is `opened:false` with `DOOR_FEEDBACK_UNAVAILABLE`. Set it to `1` **only for the hackathon demo** to report `opened:true` after the timed servo cycle. Serial prints `[DEMO]` for this assumption. A timed servo command does not prove a production door opened. A production build needs a physical sensor in `doorOpenFeedback()` and a tested failure path.

`ROMI_HACKATHON_DEBUG_MODE=1` enables Serial `O` (open), `C` (close), `T` (timed servo cycle without API ACK), `S` (state), and `P` (poll). Leave it `0` for normal operation. Debug `O` and `C` are manual bench commands and never send an API ACK.

`ROMI_ENABLE_AUDIO=0` builds without audio libraries. Setting it to `1` currently gives an explicit compile error until an I2S/Gemini module is implemented and verified on actual parts. Keep browser audio as the fallback. No microphone, amplifier, speaker, WebSocket, or session token handling is claimed by this firmware.

## Hackathon bench sequence

1. Confirm the actual ESP32 model and check the pin table before wiring. Verify common ground and external 5 V polarity with a meter. Keep the servo disconnected from a real door.
2. Flash the core with real secrets and a trusted CA. Confirm `[WIFI] Connected`, `[TIME] Synchronized`, idle green LED, button toggle, and no 401 errors.
3. Set debug mode for a disconnected servo/LED bench test. Use `O`, `C`, `T`, `S`, then disable debug for the demo flash.
4. On a staging backend, run `pnpm smoke:device:external` first. Use its gated door-cycle probe only with an isolated database. For the physical demo, set `ROMI_DEMO_ASSUME_SERVO_MOVED=1`, create an authorized door command through the existing browser/API flow, and verify one servo cycle plus one ACK in Serial and the dashboard.
5. Check Wi-Fi disconnect/reconnect, invalid token, expired command, duplicate command, and supply brownout behavior. Reflash with adjusted pins/angles if the organizer's kit differs.
