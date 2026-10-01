# ROMI ESP32 firmware

Classic ESP32 DevKit V1 / ESP-WROOM-32, PlatformIO `esp32dev`.

**Plan A is standalone voice:** the GPIO33 button creates an authenticated ROMI session, connects directly to Gemini Live, captures INMP441 audio and plays responses through MAX98357A. It needs power, Wi-Fi and the deployed APIs. A PC is used for configuration, flashing and diagnosis. Read [the Arabic standalone steps](STANDALONE.md), [troubleshooting and fallback](HACKATHON.md), and [the verification record](VERIFICATION.md).

## Windows commands

Run from the repository root:

```powershell
.\firmware\esp32-romi\romi.ps1 prepare
.\firmware\esp32-romi\romi.ps1 test -Mode audio-bench
.\firmware\esp32-romi\romi.ps1 flash -Mode full
.\firmware\esp32-romi\romi.ps1 monitor
```

`romi_secrets.h` is preloaded with the deployed URL, verified device token and a trusted root CA. First network flash asks only for the competition Wi-Fi name/password. Menu 2 or `romi.ps1 wifi` changes Wi-Fi while preserving server settings.

`prepare` installs/caches PlatformIO and builds the profiles. `configure` asks for Wi-Fi 2.4 GHz, password, ROMI HTTPS origin, device token and a root CA. Enter at the CA prompt discovers a root using Windows-validated TLS; a PEM file can also be supplied. Keep the prepared PC/cache available for flashing. Changing compiled settings needs another flash. Serial Monitor is 115200 baud; Ctrl+C exits. `doctor` and `ports` inspect tools/ports and reject Intel SOL as a USB board. Add `-Port COM7` after identifying the actual board.

| Launcher mode | Audio | Network | Door verification |
| --- | --- | --- | --- |
| `full` | Native mic, speaker and Live | ROMI + Gemini | Explicit hackathon timed-servo assumption |
| `full-safe` | Native mic, speaker and Live | ROMI + Gemini | Real sensor required |
| `audio-bench` | Local levels/tone | Disabled | Manual tests, no ACK |
| `demo` | Disabled; phone fallback | ROMI commands | Explicit hackathon timed-servo assumption |
| `safe` (default) | Disabled | ROMI commands | Real sensor required |
| `bench` | Disabled | Disabled | Manual tests, no ACK |

`test -Mode audio-bench` uploads the audio bench and opens logs; plain `test` does the core bench. `-InsecureTls` is explicit and allowed only for `full`/`demo`: it bypasses the ROMI host certificate only. Gemini always uses trusted Google roots. Normal profiles validate HTTPS and wait for NTP. No Gemini API key, Supabase secret or admin credentials belong on the ESP32.

`romi_secrets.h` contains the preloaded device settings requested by the owner. Gemini/Supabase server env files are ignored and belong locally/on Vercel. The launcher never prints credentials. Generated mode flags in `romi_local.h` remain ignored. Pins, angles, gains, rates and timings are centralized in `include/romi_config.h`.

## Build targets and modules

`romi-devkit-v1` forces `ROMI_ENABLE_AUDIO=0` and ignores WebSockets: the core has no mandatory audio dependency. `romi-full-devkit-v1` enables audio and adds WebSockets 2.7.3. Example settings compile and fail closed at runtime until provisioned.

```powershell
python -m platformio run -d firmware/esp32-romi -e romi-devkit-v1
python -m platformio run -d firmware/esp32-romi -e romi-full-devkit-v1
```

- `main.cpp`: GPIO, millis debounce, LEDs, Wi-Fi/NTP, door states and persistent duplicate protection.
- `romi_http.cpp`: bounded command/ACK HTTP worker; GPIO timing continues during network waits.
- `romi_audio_io.cpp`: one full duplex I2S driver with shared 48 kHz stereo/32-bit clocks; input downsampled to PCM16 mono 16 kHz, output PCM16 mono 24 kHz repeated onto both slots. Bounded queues and incremental playback.
- `romi_live.cpp`: ephemeral session creation, validated TLS WebSocket, tool/API calls, physical ACK status, cancellation, inactivity timeout, cleanup and usage. Each button start creates a fresh UUID/context.
- `romi_live_protocol.h`: converts the actual server SDK config into the raw Live setup envelope.
- `scripts/websocket_limits.py`: guards the pinned dependency's ESP32 frame-size definition so the configured 64 KiB limit takes effect. Real provider responses exceeded its original 15 KiB limit.

Voice is half duplex: mic capture pauses while ROMI speaks, avoiding speaker echo; interrupt with the button. There is no acoustic echo cancellation. API bodies are bounded at 32 KiB and availability offered to the model is limited to eight returned slots; oversized responses fail explicitly. Long date ranges may exceed that bound.

## Wiring and door behavior

Servo23, button33 to GND (`INPUT_PULLUP`), red25/green26 through 330 ohm. I2S BCLK14/LRCLK27 intentionally shared; mic SD32, amp DIN22. INMP441 is 3.3 V only, L/R to GND. Servo and amp use external 5 V, all grounds common. ESP32 uses USB: do not connect external +5 V to a USB-powered board. Speaker connects across amplifier +/minus, never speaker minus to GND. Add the correctly polarized 1000 uF/10 V capacitor across external 5 V. Wokwi audio chips are visual placeholders.

Only a validated, unexpired server command moves the door. Polling honors `retry_after_ms`; null/invalid/expired replies do nothing. Sixteen normalized UUIDs are persisted in NVS before actuation. Servo opens, holds, closes, then ACKs; bounded retries stop at expiry. ACK responses must match ID/outcome. The server does not redeliver already-claimed `sent` commands after reset.

`ROMI_DEMO_ASSUME_SERVO_MOVED=1` logs `[DEMO]` and treats timed servo completion as provisional success. With it off, `doorOpenFeedback()` must be implemented with a real sensor; currently it returns false, producing `DOOR_FEEDBACK_UNAVAILABLE`. `servo.write()` never proves production movement.

Debug modes enable `O`/`C` manual positions, `T` timed bench cycle, `S` state, `P` poll, plus audio `M` mic peaks/heap and `A` short speaker tone. Manual tests never ACK. With audio disabled, the button has a local session stub; it does not remotely start a phone. Phone `/dashboard/kiosk` is Plan B and starts from its screen; `/dashboard/simulation` creates simulated commands only.

## Verification boundary

Core/full builds and a real raw-protocol Gemini exchange are verified; actual I2S audio, device heap/TLS stability, wiring, servo movement and power remain unverified without hardware. The full external protocol test passed on romi-deci.vercel.app after the Gemini key update and SQL migration 0007. Physical button-to-door tests still require hardware. See docs/deployment-device-tests.md for network results.
