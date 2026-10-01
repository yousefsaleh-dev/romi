import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const baseUrl = process.env.ROMI_TEST_BASE_URL ?? "http://localhost:3100";
const deviceToken = process.env.ROMI_DEVICE_TOKEN;
assert.ok(deviceToken, "ROMI_DEVICE_TOKEN is required");
const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const headers = { Authorization: `Bearer ${deviceToken}`, "Content-Type": "application/json" };

async function call(path, { method = "GET", body, authenticated = true } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: authenticated ? headers : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

function cairoDate(daysFromNow) {
  const value = new Date(Date.now() + daysFromNow * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(value);
}

let appointmentId;
try {
  const deniedPoll = await call("/api/device/commands", { authenticated: false });
  assert.equal(deniedPoll.status, 401);

  const invalidAck = await call("/api/device/commands/ack", { method: "POST", body: { command_id: "bad", opened: true } });
  assert.equal(invalidAck.status, 400);

  const unknownAck = await call("/api/device/commands/ack", { method: "POST", body: { command_id: randomUUID(), opened: true } });
  assert.equal(unknownAck.status, 409);

  const requestId = randomUUID();
  const session = await call("/api/ai/session", { method: "POST", body: { request_id: requestId } });
  assert.equal(session.status, 200, JSON.stringify(session.payload));
  assert.equal(session.payload.request_id, requestId);
  assert.ok(session.payload.token);
  assert.equal(session.payload.config.speechConfig.voiceConfig.voice, "ar-eg-concierge-7");

  const date = cairoDate(7);
  const availability = await call("/api/ai/availability", {
    method: "POST", body: { request_id: requestId, department_slug: "general", date_from: date, date_to: date },
  });
  assert.equal(availability.status, 200, JSON.stringify(availability.payload));
  const slot = availability.payload.slots.find((candidate) => candidate.can_enter_now === false && candidate.remaining_capacity > 0);
  assert.ok(slot, "A future available slot is required");

  const bookingResponse = await call("/api/ai/create-booking", {
    method: "POST",
    body: {
      request_id: requestId, patient_name: "اختبار تكامل رومي", department_slug: "general",
      appointment_at: slot.starts_at, open_door_now: true,
    },
  });
  assert.equal(bookingResponse.status, 200, JSON.stringify(bookingResponse.payload));
  const booking = bookingResponse.payload.booking;
  appointmentId = booking.appointment_id;
  assert.equal(booking.can_enter_now, false);
  assert.equal(booking.door_command_id, null);
  assert.equal(booking.door_open_skipped_reason, "too_early");
  assert.match(booking.entry_message_ar, /الدخول غير متاح دلوقتي/u);

  const entry = await call("/api/ai/entry-status", {
    method: "POST", body: { request_id: requestId, appointment_id: appointmentId },
  });
  assert.equal(entry.status, 200, JSON.stringify(entry.payload));
  assert.equal(entry.payload.can_enter_now, false);
  assert.equal(entry.payload.reason, "too_early");

  const checkInRequestId = randomUUID();
  const checkInSession = await call("/api/ai/session", { method: "POST", body: { request_id: checkInRequestId } });
  assert.equal(checkInSession.status, 200, JSON.stringify(checkInSession.payload));
  const earlyCheckIn = await call("/api/ai/check-in", {
    method: "POST", body: { request_id: checkInRequestId, booking_code: booking.booking_code },
  });
  assert.equal(earlyCheckIn.status, 200, JSON.stringify(earlyCheckIn.payload));
  assert.equal(earlyCheckIn.payload.attempt.ok, false);
  assert.equal(earlyCheckIn.payload.attempt.reason, "too_early");

  const { data: commands, error } = await service.from("door_commands")
    .select("id").eq("appointment_id", appointmentId);
  assert.ifError(error);
  assert.equal(commands.length, 0);

  const { error: statusError } = await service.from("appointments")
    .update({ status: "checked_in" }).eq("id", appointmentId);
  assert.ifError(statusError);
  process.stdout.write("PASS: device auth, ack contract, session token/voice, availability, early booking guard, early check-in, entry status, no door command, completed booking cleanup.\n");
} finally {
  if (appointmentId) {
    const { error, count } = await service.from("appointments").delete({ count: "exact" }).eq("id", appointmentId);
    assert.ifError(error);
    assert.equal(count, 1, "Synthetic booking cleanup failed");
  }
}
