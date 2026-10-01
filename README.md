# ROMI

ROMI is a single-hospital MVP for voice-guided appointment booking/check-in and one demonstration door. Gemini Live handles Egyptian Arabic speech-to-speech; server-side API routes validate bookings and are the only path to the door-command queue. The project contains the web/API, database implementation, and ESP32 core firmware. The physical board and audio path still require hardware verification.

## Project map

- `src/` — Next.js admin dashboard and server API routes.
- `supabase/migrations/` — schema, access policies, and device command queue.
- `firmware/esp32-romi/` — ESP32 firmware workspace.
- `firmware/esp32-romi/HACKATHON.md` — Arabic standalone setup, wiring, commands, troubleshooting and fallback guide.
- `docs/reference/` — original presentation, diagrams, and wireframe.
- `docs/system-design.md` — architecture, data model, business rules, and AI flow.
- `docs/api.md` — HTTP API contracts and authentication.
- `docs/esp32-integration.md` — firmware-facing protocol, safety rules, and test status.

## Local setup

1. Install Node.js 20.9 or newer and pnpm.
2. Run `pnpm install`.
3. Copy `.env.example` to `.env.local` and fill in the Supabase project values.
4. Link the Supabase CLI to the project, then run `supabase db push` to apply all migrations. Booking periods are generated every 30 minutes, 24/7; no one needs to open time slots manually. Migration 0006 adds explicit consent before a newly created booking may open the door and records the billing tier.
5. Create one Auth user, set its `app_metadata.role` to `admin`, and set `ADMIN_EMAIL` to that user's email. Disable public sign-ups.
6. Add a Gemini API key to `GEMINI_API_KEY` and a high-entropy `ROMI_DEVICE_TOKEN` before enabling kiosk routes.
7. Run `pnpm dev`.

AI transcripts and audio are not stored. AI request counts, modality-separated token usage, latency, billing tier, and estimated USD cost are logged in `ai_actions`. `GEMINI_BILLING_TIER=free` records a free-tier estimate of $0; the dashboard labels this as “Free Tier” instead of implying a paid charge. Free-tier data handling is subject to Google's current terms; do not use real patient data for demos. Provider billing remains the source of truth. The browser simulator uses a short-lived Gemini token issued by an authenticated API route; the browser connects its Live WebSocket directly to Gemini for low latency. Tool calls and usage reports return through authenticated API routes. Simulated door openings are separately tagged and never enter the ESP32 command queue.

## Deployment

Deploy the Next.js app to Vercel or another Node.js host and add the same server environment variables there. Apply migrations to the Supabase project first. Keep secret keys out of Git and out of ESP32 firmware. Physical door opening requires firmware to claim commands and acknowledge the actuator result. The firmware's demo flag may treat timed servo movement as success; real access control requires a door-position sensor. See [the device integration checklist](docs/esp32-integration.md) before wiring.

Run `pnpm lint`, `pnpm typecheck`, and `pnpm build` before a demo. `pnpm smoke:live` checks Gemini Live with a synthetic greeting and the `end_conversation` tool. With a running local server on port 3100 and a nonempty `ROMI_DEVICE_TOKEN`, `pnpm smoke:api` checks the device HTTP contract with a synthetic future booking and deletes that test booking afterward. Do not run the API smoke test against production without reviewing its synthetic database writes.

After deploying an isolated staging instance to Vercel, set `ROMI_TEST_BASE_URL` to its HTTPS URL and run `pnpm smoke:device:external` for device auth and rejection contracts. The full synthetic command claim/ACK probe requires `ROMI_TEST_ALLOW_DOOR_COMMAND=YES` and `ROMI_TEST_ISOLATED_DB=YES`; it creates and cleans up a staging booking and must not run against a real door queue.

## Browser voice with the physical ESP32 door

Use `/dashboard/kiosk` after admin login and enter the same device token provisioned on the ESP32. It creates device-authenticated AI sessions through the existing routes and waits for the board's physical command ACK. The token is held in page memory only. `/dashboard/simulation` remains a simulated door flow and cannot operate the physical queue. The physical button currently toggles a local firmware state; start/stop browser voice using the page controls.

On Windows, run `./firmware/esp32-romi/romi.ps1 prepare` on the competition laptop before the event, then follow [the independent field guide](firmware/esp32-romi/HACKATHON.md). `pnpm test:device-door` verifies browser status handling rejects simulated/failed/malformed confirmations. These tests and successful builds do not prove hardware motion or a deployed API exchange.
