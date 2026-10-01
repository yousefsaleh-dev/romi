# ROMI system design

## Scope

ROMI is an MVP for one hospital, one entrance/door, and one administrator account. The hospital and departments are demonstration data, not an official Assiut University Hospitals integration. There are no patient accounts, public booking portal, multiple hospitals, medical records, or medical advice.

The project provides a Next.js admin dashboard and voice simulator, authenticated API routes, Supabase Auth/Postgres, and Gemini Live speech-to-speech. The `firmware/esp32-romi` directory now contains an ESP32 DevKit V1 core firmware target and provisional pin map. Its audio codec path and physical actuator have not been verified on hardware.

## Architecture

```text
Admin browser simulator ── short-lived Live token ──► Gemini Live
          │                       ▲                      │
          └── admin API tools ────┴── function calls ───┘
                         │
                         ▼
                  Next.js API routes
                   │             │
                   ▼             ▼
              Supabase DB     ESP32 command API
                                 │ polling + ack
                                 ▼
                            ESP32 core firmware
```

The browser and (future) kiosk connect directly to Gemini Live using a one-use, short-lived token minted by `POST /api/ai/session`. The long-lived Gemini API key stays on the server. Gemini tools do not have direct database or actuator access: tool calls go through authenticated Next.js routes, which validate the session and use the server-only Supabase service key. Door opening requires a server-created command; the ESP32 cannot decide booking eligibility.

## Main data

- `departments`: active demonstration departments (`general`, `internal_medicine`, `pediatrics`, `orthopedics`).
- `appointments`: four-digit code, recorded visitor name, department, UTC appointment start, state, and optional source AI action. The visitor name is descriptive, never an authorization factor.
- `ai_actions`: one row per fresh AI session/request, source (`simulation` or `kiosk`), model, outcome, booking decision, token counts by modality, latency, estimated cost, billing tier, and usage-finalized flag. Raw audio and full transcripts are not persisted.
- `door_commands`: one queued door action tied to an AI action and appointment, with claim/expiry/open/failure state. Simulation commands are marked and isolated from physical-device polling.

## Booking rules

- Hospital is treated as open 24/7. Appointment starts are generated at `:00` and `:30`, each appointment is 30 minutes.
- At most one active appointment may occupy one department at the same exact start. Different departments can each have one at the same time (up to the four configured departments).
- The database enforces the capacity and serializes competing creates with a transaction-scoped advisory lock. Availability is advisory; the create transaction is authoritative and may return `slot_full` if another request wins the race.
- Dates from users are Cairo-local `YYYY-MM-DD`; database instants are UTC. Server calculations use `Africa/Cairo` and handle local-day boundaries.
- Entry window is `[appointment start - 1 hour, appointment start + 2 hours)`. Before it: `too_early`; at/after the exclusive end: `expired`. The four-digit code, database state, and server clock decide check-in; name spelling never does.
- A new booking never opens the door by default. ROMI may request immediate entry only after explaining that the code will be consumed and receiving explicit visitor consent. The server independently checks consent and the same entry window. An out-of-window appointment may still be booked, but it produces no door command.
- Successful check-in consumes the booking. A door command becomes “opened” / appointment checked-in only after a positive device acknowledgement; a simulation can acknowledge only a `simulated=true` command.

## AI session and tool flow

1. The browser requests microphone permission and creates a fresh UUID `request_id` for every new conversation.
2. An admin session or authorized kiosk asks `POST /api/ai/session` for a one-use, short-lived Gemini token. The API registers the request, its source/model/billing tier, and adds a Cairo-local current timestamp to that session's system instructions.
3. The client connects directly to Gemini Live with audio input/output, the pinned Egyptian female concierge voice (`ar-eg-concierge-7`), Egyptian Arabic instructions, and the function declarations. Each session is new; ROMI does not carry transcript/context to the next one.
4. Gemini may call `check_in_booking`, `find_available_slots`, `create_booking`, or `end_conversation`. The client forwards business operations to authenticated API routes; the server returns authoritative results to Gemini. Name is saved on a booking but never used for check-in.
5. A device session polls for a physical command, actuates only the configured demo mechanism, and acknowledges success/failure. The simulator uses a separate admin-only completion route.
6. After 20 seconds with no visitor/audio activity, the client closes the Live session. If Gemini invokes `end_conversation`, ROMI waits for the short farewell audio to finish, then closes the connection and finalizes usage as `completed`.
7. Client-reported token counts, latency, and outcome are written once to the matching action. This is an estimate, not provider billing data; Free Tier sessions are labeled separately.

### Tool intent

| Gemini tool | Purpose | Server source of truth |
| --- | --- | --- |
| `check_in_booking(booking_code)` | Check a four-digit code and record the attempt | `POST /api/ai/check-in` + `attempt_booking_checkin` transaction |
| `find_available_slots(department_slug, date_from, date_to)` | Offer slots within a Cairo-local date range | `POST /api/ai/availability` + `find_available_appointment_slots` |
| `create_booking(patient_name, department_slug, appointment_at, open_door_now)` | Create selected slot; door consent is explicit and defaults false | `POST /api/ai/create-booking` + `create_ai_booking` transaction |
| `end_conversation()` | Say a brief goodbye and then close this visitor's session | Client lifecycle; usage is finalized by `POST /api/ai/usage` |

## Security and operational limits

- Dashboard access is limited to the one configured admin identity; public sign-up must be disabled.
- Device routes require `Authorization: Bearer <ROMI_DEVICE_TOKEN>`. The token must be high entropy and stored as a firmware secret; it is not the Gemini key or Supabase key. It is still extractable from physical firmware, so rotate it if the board is lost and use per-device credentials for a real deployment.
- `SUPABASE_SECRET_KEY` and `GEMINI_API_KEY` are server-only. `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is public by design and subject to RLS.
- Free Gemini tier may apply different data-use terms than paid tier. Use synthetic demo data only.
- This is not production access-control hardware. Add emergency egress, physical override, actuator feedback, power-loss behavior, watchdogs, rate limits, monitoring, and a threat/safety review before any real door.

## Time and cost

System time is supplied to every fresh prompt in Cairo time and 12-hour formatting. Gemini is told both the exact entry-window rule and a relative-time example; server/database calculations remain decisive. The dashboard records per-modality token counts and estimates paid-tier cost using `.env.local` rates. A configured `GEMINI_BILLING_TIER=free` means estimated cost is $0 by configuration; it does not independently verify a provider invoice or quota.

## Current verification boundary

Web/API/database behavior can be checked with lint, TypeScript, build, database lint, and controlled HTTP/Live smoke tests. None of those proves the competition's eventual ESP32, microphone, speaker, amplifier, power supply, relay/servo, wiring, network quality, or door sensor. Board-level verification starts only after the supplied parts and wiring are known.
