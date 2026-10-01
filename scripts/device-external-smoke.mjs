import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const baseUrl = process.env.ROMI_TEST_BASE_URL?.replace(/\/$/, "");
const deviceToken = process.env.ROMI_DEVICE_TOKEN;
assert.ok(baseUrl?.startsWith("https://"), "ROMI_TEST_BASE_URL must be an HTTPS deployment URL");
assert.ok(deviceToken, "ROMI_DEVICE_TOKEN is required");

const headers = { Authorization: `Bearer ${deviceToken}`, "Content-Type": "application/json" };
async function call(path, { method = "GET", body, authenticated = true } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: authenticated ? headers : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { nonJsonResponse: true }; }
  return { status: response.status, payload };
}

function cairoDate(daysFromNow) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(Date.now() + daysFromNow * 86_400_000));
}

const denied = await call("/api/device/commands", { authenticated: false });
assert.equal(denied.status, 401, "Unauthenticated device poll must fail");
const invalidAck = await call("/api/device/commands/ack", {
  method: "POST", body: { command_id: "invalid", opened: true },
});
assert.equal(invalidAck.status, 400, "Malformed ACK must fail");
const unknownAck = await call("/api/device/commands/ack", {
  method: "POST", body: { command_id: randomUUID(), opened: true },
});
assert.equal(unknownAck.status, 409, "Unknown command ACK must fail");
const invalidSession = await call("/api/ai/session", {
  method: "POST", body: { request_id: "invalid" },
});
assert.equal(invalidSession.status, 400, "Malformed session ID must fail");
process.stdout.write("PASS: deployed device authentication and rejection contracts.\n");

if (process.env.ROMI_TEST_ALLOW_DOOR_COMMAND !== "YES") {
  process.stdout.write("Door-cycle probe skipped. Set ROMI_TEST_ALLOW_DOOR_COMMAND=YES on an isolated staging database.\n");
  process.exit(0);
}
assert.equal(process.env.ROMI_TEST_ISOLATED_DB, "YES", "Door-cycle probe requires an isolated staging database");
assert.ok(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SECRET_KEY,
  "Staging Supabase URL and service key are required for isolated cleanup");

const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data: pending, error: pendingError } = await service.from("door_commands")
  .select("id").in("status", ["pending", "sent"]).eq("simulated", false).limit(1);
assert.ifError(pendingError);
assert.equal(pending.length, 0, "Staging physical command queue must be empty before the probe");

const requestId = randomUUID();
let appointmentId;
let actionId;
try {
  const session = await call("/api/ai/session", { method: "POST", body: { request_id: requestId } });
  assert.equal(session.status, 200, `Session creation failed: ${JSON.stringify(session.payload)}`);
  assert.equal(session.payload.request_id, requestId);
  assert.ok(session.payload.token && session.payload.model && session.payload.config);
  const { data: action, error: actionError } = await service.from("ai_actions")
    .select("id").eq("request_id", requestId).single();
  assert.ifError(actionError);
  actionId = action.id;

  let selected;
  for (const department of ["general", "internal_medicine", "pediatrics", "orthopedics"]) {
    const availability = await call("/api/ai/availability", {
      method: "POST",
      body: { request_id: requestId, department_slug: department,
        date_from: cairoDate(0), date_to: cairoDate(1) },
    });
    assert.equal(availability.status, 200, `Availability failed: ${JSON.stringify(availability.payload)}`);
    const slot = availability.payload.slots.find((item) => {
      const minutesAway = (Date.parse(item.starts_at) - Date.now()) / 60000;
      return item.can_enter_now === true && item.remaining_capacity > 0 &&
        minutesAway > 4 && minutesAway < 60;
    });
    if (slot) { selected = { department, slot }; break; }
  }
  assert.ok(selected, "No free near-term slot for the isolated door probe");

  const bookingResponse = await call("/api/ai/create-booking", {
    method: "POST",
    body: { request_id: requestId, patient_name: "ROMI staging device probe",
      department_slug: selected.department, appointment_at: selected.slot.starts_at,
      open_door_now: true },
  });
  assert.equal(bookingResponse.status, 200, `Booking failed: ${JSON.stringify(bookingResponse.payload)}`);
  const booking = bookingResponse.payload.booking;
  appointmentId = booking.appointment_id;
  assert.equal(booking.can_enter_now, true);
  assert.ok(booking.door_command_id, "Booking did not create a physical door command");

  const poll = await call("/api/device/commands");
  assert.equal(poll.status, 200, `Device poll failed: ${JSON.stringify(poll.payload)}`);
  assert.equal(poll.payload.command?.id, booking.door_command_id);
  assert.ok(Date.parse(poll.payload.command.expires_at) > Date.now());
  assert.ok(Number.isInteger(poll.payload.retry_after_ms) && poll.payload.retry_after_ms > 0);

  // This ACK is a synthetic device response. It must never be run against a real door queue.
  const ackBody = { command_id: booking.door_command_id, opened: true };
  const ack = await call("/api/device/commands/ack", { method: "POST", body: ackBody });
  assert.equal(ack.status, 200, `ACK failed: ${JSON.stringify(ack.payload)}`);
  assert.equal(ack.payload.command?.status, "opened");
  const duplicateAck = await call("/api/device/commands/ack", { method: "POST", body: ackBody });
  assert.equal(duplicateAck.status, 409, "Duplicate ACK must fail");

  const { data: appointment, error: appointmentError } = await service.from("appointments")
    .select("status").eq("id", appointmentId).single();
  assert.ifError(appointmentError);
  assert.equal(appointment.status, "checked_in");
  process.stdout.write("PASS: deployed session, availability, booking, physical command claim, ACK, duplicate rejection, and checked-in transition.\n");
} finally {
  if (actionId) {
    const { error: appointmentCleanupError } = await service.from("appointments")
      .delete().eq("creation_action_id", actionId);
    assert.ifError(appointmentCleanupError);
  }
  const { error } = await service.from("ai_actions").delete().eq("request_id", requestId);
  assert.ifError(error);
}
