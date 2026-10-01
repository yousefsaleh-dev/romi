# ROMI API reference

All endpoints are same-origin Next.js routes. JSON errors use `{ "error": "..." }`. Use HTTPS outside local development. Never send Gemini/Supabase server secrets from the browser or firmware.

## Authentication

- Admin routes: authenticated Supabase session for the one configured admin email/role. Dashboard requests use the browser's Supabase session cookies.
- Device routes: `Authorization: Bearer <ROMI_DEVICE_TOKEN>`; comparison is timing-safe. The ESP32 token is separate from all provider/database keys.
- AI routes accept either an admin session (simulator) or device bearer token (kiosk); each `request_id` is bound to source `simulation` or `kiosk` so one cannot use the other's request.

The browser page `/dashboard/kiosk` uses an operator-entered device token in page memory with these existing routes, providing browser voice for the physical ESP32 queue. It reads `/api/ai/door-status`; it does not claim or acknowledge physical commands. `/dashboard/simulation` continues to use the admin simulation flow.
- Do not expose the Supabase service key. API handlers use it server-side to run privileged database transactions.

## AI routes

### `POST /api/ai/session`

Start a fresh session. Request: `{ "request_id": "<uuid>" }`. Returns `{ token, model, request_id, config }`; `token` is one-use and short-lived. Registers the session and current Cairo time (12-hour format) in the AI instruction context. Duplicate IDs return `409`; missing API key returns `503`; provider token errors return `502`.

### `POST /api/ai/check-in`

Request: `{ "request_id": "<uuid>", "booking_code": "1234" }`. Arabic and Persian digits are normalized. Returns `{ attempt }`, where the authoritative attempt includes success/reason/remaining attempts and, on acceptance, an optional `door_command_id`. Typical reasons: `not_found`, `already_used`, `expired`, `too_early`, `cancelled`, `door_pending`, `accepted`. Name is deliberately absent.

### `POST /api/ai/availability`

Request: `{ "request_id": "<uuid>", "department_slug": "general", "date_from": "2026-09-25", "date_to": "2026-09-25" }`. Dates mean Cairo-local calendar dates; max range 31 days. Returns `{ slots: [...] }`; each slot includes the database start instant and remaining capacity, plus server-calculated `can_enter_now`, `entry_window_opens_at`, `entry_window_closes_at`, and `checked_at`. Entry is allowed starting one hour before the appointment (inclusive) until two hours after it (exclusive). This is an eligibility check only: the visitor decides whether to enter now or wait. Slots are generated every 30 minutes, 24/7. `400` for invalid date/range, `409` for a missing/finished/wrong-source session.

### `POST /api/ai/create-booking`

Request:

```json
{
  "request_id": "<uuid>",
  "patient_name": "اسم صاحب الحجز",
  "department_slug": "general",
  "appointment_at": "2026-09-25T10:00:00.000Z",
  "open_door_now": false
}
```

`appointment_at` must be copied exactly from an available slot; `open_door_now` is boolean and defaults to false. Returns `{ booking }`, including `appointment_id`, the generated four-digit code, UTC appointment time, `can_enter_now`, `checked_at`, entry window times, `entry_message_ar`, and an optional door command. A stale/full slot is `409` with `booking.reason`; the SQL transaction ensures no double booking. Immediate opening is accepted only when the user consent flag is true and the appointment is in the entry window. A future booking never creates a door command, even if a caller sends `open_door_now: true`.

### `POST /api/ai/entry-status`

Request: `{ "request_id": "<uuid>", "appointment_id": "<uuid>" }`. Refreshes entry eligibility for a booking created in this same AI session. Returns `can_enter_now`, `reason`, `checked_at`, entry window times, status, and a ready-to-say `entry_message_ar`. Use this before later statements about whether the visitor can enter now. Another session's appointment returns `404`.

### `GET /api/ai/door-status?request_id=<uuid>`

Read the command attached to this AI session: `{ command: null | { status, simulated, opened_at, error_code } }`. An issued command does not prove the door opened; only `status=opened` after acknowledgement does.

### `POST /api/ai/usage`

Finalize token and latency reporting once per session. Request fields: `request_id`, `text_input_tokens`, `text_output_tokens`, `audio_input_tokens`, `audio_output_tokens` (non-negative integers), `latency_ms` (integer or null), and optional `outcome` (`missing_code`, `provider_error`, `completed`). A repeated report returns `{ saved: true, duplicate: true }`. Cost is an estimate from configured tier/rates; provider billing is authoritative.

## ESP32 command routes

### `GET /api/device/commands`

Requires device bearer token. Atomically claims the next physical pending command, if any. Returns `{ command: null, retry_after_ms: 1500 }` or `{ command: { id, expires_at }, retry_after_ms: 1500 }`. Poll at the suggested interval, use backoff on network errors, and never actuate for a null command. Simulation commands are excluded from this queue.

### `POST /api/device/commands/ack`

Requires device bearer token. Request: `{ "command_id": "<uuid>", "opened": true }`, or `{ "command_id": "<uuid>", "opened": false, "error_code": "ACTUATOR_TIMEOUT" }`. Returns `{ command }` on first valid acknowledgement. Invalid payload is `400`; expired/already-acknowledged command is `409`. Ack only after actuator feedback, not merely after sending a GPIO pulse. `opened=true` changes the associated appointment to checked-in; failures retain an explicit error state.

### Device session startup

The device may request `POST /api/ai/session` with the same request body and bearer header. The route returns an ephemeral Gemini credential/config; keep it only in RAM, connect once, and discard it at conversation end. No firmware currently implements this handshake or the Gemini Live WebSocket protocol.

## Admin and simulation routes

| Method and route | Auth | Behavior |
| --- | --- | --- |
| `GET /api/bookings?page=0` | Admin | List bookings 100 per page, with `total` and `has_more`; expires old records first. |
| `POST /api/bookings` | Admin | Create a four-digit-code booking with name, department, exact future half-hour `appointment_at`; returns `201`. |
| `PATCH /api/bookings/:id` | Admin | Not supported; appointments are not rescheduled in this MVP (`405`). Cancel and create a new slot instead. |
| `DELETE /api/bookings/:id` | Admin | Permanently delete any booking status; pending door commands are marked failed first. |
| `GET /api/availability?department_slug=…&date_from=…&date_to=…` | Admin | List generated available periods; no date filter returns departments. |
| `POST /api/availability` | Admin endpoint | Deliberately returns `405`; periods are generated, not manually opened. |
| `POST /api/simulation/door-open` | Admin | Complete a `simulated=true` command only. Never called by the ESP32. |

## Device implementation contract

The final audio-capable control loop is: visitor presses the one physical GPIO33 button → create a fresh `request_id` → `POST /api/ai/session` → direct Live WebSocket → execute validated function calls by calling the AI routes → play returned audio. The same button cancels an active visitor session; it never opens the door. End also when ROMI invokes local `end_conversation` or after 20 seconds of visitor silence (not while ROMI is speaking). At end, stop microphone capture immediately, close the Live WebSocket, post usage once, clear the one-use token and all conversation/audio buffers from RAM, then return to idle. The next start creates a new UUID and entirely fresh model context. Independently poll `/api/device/commands` for door commands → actuate/verify → POST acknowledgement. Current ESP32 core firmware implements the door loop and a local button state only. The ESP32 `/api/ai/session` handshake, audio and Live WebSocket are not implemented; in fallback mode the browser starts its own voice session. See [ESP32 integration](esp32-integration.md).
