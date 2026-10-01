# ESP32 integration and verification plan

New to hardware? Start with [the Arabic first-time guide](hardware-first-time.md): what the terminal menu is, where to type Wi-Fi/token settings, USB flashing, standalone power, and the complete phone fallback if audio parts are absent.

## What is ready

The server-side contracts exist for session creation, check-in, availability, booking creation, door-command polling, acknowledgement, door status, and usage finalization. Device routes use a server-side bearer token. The database owns booking state, conflict prevention, entry-window decisions, and command state. The PlatformIO core firmware targets ESP32 DevKit V1 and implements GPIO, Wi-Fi, HTTPS command polling, servo timing, and ACK handling. Both core and full audio profiles build; a real Gemini raw-protocol probe passed. Neither has been flashed or tested on hardware. Pin assignments remain provisional until the competition kit is confirmed. See [firmware setup](../firmware/esp32-romi/README.md).

## What firmware must do

Plan A is the native ESP32 full profile, started by GPIO33; see [standalone steps](../firmware/esp32-romi/STANDALONE.md). For the phone browser fallback, use `/dashboard/kiosk` after admin login and enter the device token. It uses the existing device-authenticated session/tool routes and waits for the ESP32 ACK through `/api/ai/door-status`; it never calls the simulation completion route. `/dashboard/simulation` cannot send a physical command. See the [Arabic independent operator guide](../firmware/esp32-romi/HACKATHON.md) for cached tools, offline bench mode, wiring and recovery.

1. Store Wi-Fi credentials, `ROMI_DEVICE_TOKEN`, and the app base URL in device settings (`romi_secrets.h`; owner requested repository storage); never store `GEMINI_API_KEY`, Supabase secret/publishable keys, admin credentials, or real patient data.
2. Use the single GPIO33 button as the MVP start/cancel control: a debounced idle press starts, and an active press cancels. The full profile creates a new UUID, calls `POST /api/ai/session`, and keeps the one-use token only in RAM. Audio-disabled core retains a local button stub. The fallback browser starts and ends its own voice session; the physical button cannot remotely control that browser with the current APIs.
3. Connect to Gemini Live over a direct TLS WebSocket using the returned model/config/token. Send an initial short text instruction to greet the visitor in Egyptian Arabic (the server connection alone does not start the greeting). Then capture mono microphone frames, encode exactly as the negotiated Live API requires, receive audio output, and play it. All function calls go back to the corresponding `/api/ai/*` route with the same request ID and device bearer token.
4. Track visitor speech/activity and close the Live context after 20 seconds of silence (count only while ROMI is not speaking), after ROMI calls the local `end_conversation` tool, or when the same physical button is pressed again. The end tool is a local lifecycle signal: do not send a tool response that starts another model turn. Cut microphone capture immediately; let already-received farewell audio finish, close Live, post usage once, erase token/audio/transcript/context from RAM, then return to idle. The next start gets a new UUID and a clean context; never mix visitors or reuse session state.
5. Run a separate door-command poll loop using `GET /api/device/commands`. If command is null, do nothing. If an ID arrives, validate expiry, actuate once, verify a physical sensor/feedback signal, then POST the acknowledgement. Report specific safe error codes on failure.
6. Bound memory/queue sizes, use TLS certificate validation, watchdog/reconnect/backoff, network timeouts, and prevent repeated actuation if the same command ID is delivered again. Keep the door physically safe on brownout/reset and provide manual/emergency override.

The current core uses a separate FreeRTOS HTTP worker, one outstanding request, a 2048-byte response bound and a 16-ID persistent duplicate history. GPIO and servo timing continue while HTTP waits. `romi.ps1` selects core bench/demo/safe or native audio-bench/full/full-safe. Full and demo explicitly assume timed movement succeeded; safe profiles require real sensor feedback. Certificate bypass is explicit for ROMI only in full/demo. Gemini always validates Google roots. HTTP allocations and large WebSocket receives share a recursive mutex; GPIO and I2S run separately.

## Expected exchange

```text
ESP32 → POST /api/ai/session (device bearer + fresh request_id)
ESP32 ← 200 { token, model, request_id, config }
ESP32 ⇄ Gemini Live WebSocket (audio + tool calls; token only in RAM)
ESP32 → POST /api/ai/check-in | availability | create-booking (same request_id)
ESP32 → GET /api/device/commands (poll; command is physical only)
ESP32 → POST /api/device/commands/ack (after sensor confirms result)
ESP32 → POST /api/ai/usage (once when closing session)
```

## Session state machine

```text
IDLE --call button--> CONNECTING --Live connected--> ACTIVE
ACTIVE --ROMI end tool / stop button / 20s silence--> CLOSING --cleanup done--> IDLE
CONNECTING --timeout/error/cancel--> CLOSING
```

Only one visitor session runs at a time. The one physical button is the local start/cancel control; do not leave Gemini listening continuously, and do not infer a new visitor merely from sound or motion. While ROMI is speaking, do not count speaker playback as visitor activity or as silence. In `CLOSING`, disable the microphone first so the departing visitor or nearby chatter cannot leak into another turn; then drain only audio already received, close the socket, report usage, erase volatile session data, and show/indicate idle. A new person starts a new context only with a new button press and request ID. The full profile implements this lifecycle; audio-disabled core does not. Audio is half duplex: capture pauses during playback; there is no acoustic echo cancellation.

The planned pins are servo GPIO23, button GPIO33, red LED GPIO25, green LED GPIO26, shared I2S BCLK GPIO14 and LRCLK GPIO27, microphone data GPIO32, amplifier data GPIO22. Audio is disabled by default and the Wokwi audio chips are visual placeholders. Full uses the v1beta constrained WebSocket with the URL-encoded ephemeral access_token, no subprotocol, and setupComplete before input. PCM input is mono16/16kHz in 20ms frames; output is mono16/24kHz. One 48kHz stereo32 I2S driver shares BCLK/LRCLK. WebSocket frames are bounded at 64KiB because real responses exceeded the dependency default. Mic slot/gain, speaker level, runtime heap, power and a production door sensor still require actual hardware testing. Do not connect a motor/relay/solenoid directly to an ESP32 GPIO.

## Safe validation sequence

1. Apply migrations and verify `supabase db lint --linked --schema public --fail-on error`.
2. Run `pnpm lint`, `pnpm typecheck`, `pnpm build`.
3. Use `pnpm smoke:esp32:live` for the raw ESP32 wire format (actual server config, synthetic PCM input and real PCM output), or `pnpm smoke:live` to verify a short real-key, synthetic Egyptian Arabic Live exchange and the `end_conversation` tool handshake. This call is to Gemini, may consume quota/cost depending on configured provider tier, and does not touch Supabase or a door.
4. For HTTP integration, set a high-entropy `ROMI_DEVICE_TOKEN` in local server config, run the local server on port 3100, then run `pnpm smoke:api` with a disposable test environment. It checks bearer authentication, session/token creation, availability, a future booking with `open_door_now=true` rejected by the entry guard, early check-in rejection, read-only entry status, no door command, and acknowledgement rejection for an unknown command. It deletes the synthetic booking afterward. Do not run command polling against a production DB unless you intend to claim a real pending command.
5. When hardware arrives, first test in a disconnected bench setup with LED/load simulator and door sensor stub; then test Wi-Fi loss, token rejection, expired/duplicate command, actuator jam, brownout and reset. Only then connect the actual demo actuator.

## Live API smoke test

The script sends one synthetic instruction: greet in natural Egyptian Arabic, then call `end_conversation`. It reports only whether audio/text/tool call and round-trip completed; it does not print the key, save audio, contact Supabase, or open a door. It is a provider/key/SDK smoke test, not proof that an ESP32 can stream audio or drive hardware. Test on Gemini's configured Free Tier only if the key is entitled to that tier; quotas and pricing can change.

ROMI is deployed at [romi-deci.vercel.app](https://romi-deci.vercel.app). External auth/rejection tests passed, but session creation currently fails due to Google rejecting the configured key. Door testing also exposed an expired-command/retry reservation bug; migration 0007 is prepared and locally tested, but not yet applied remotely. Read [the actual results and required fixes](deployment-device-tests.md) before hardware testing. A historical passing provider probe does not validate the current key. Native audio did not require new backend routes.
