import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { probeLiveSession } from "./lib/live-wire-probe.mjs";

const origin = process.env.ROMI_TEST_BASE_URL?.replace(/\/$/, "");
assert.ok(origin?.startsWith("https://"), "Set ROMI_TEST_BASE_URL to the deployed HTTPS origin");
assert.ok(process.env.ROMI_DEVICE_TOKEN, "Device token is required");
assert.equal(process.env.ROMI_TEST_ALLOW_SYNTHETIC_DEVICE, "YES",
  "This test creates synthetic bookings and reports synthetic door ACKs. Explicit opt-in required; no physical actuator may be connected.");
const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });
const visits = [];
const report = [];
const doorOnly = process.argv.includes("--door-only");
if (doorOnly) console.log("PARTIAL TEST: seeded synthetic session fixtures; Gemini/session creation is NOT verified.");

function passed(name) { report.push(name); console.log(`PASS: ${name}`); }
async function request(path, { body, token = process.env.ROMI_DEVICE_TOKEN } = {}) {
  const startedAt = Date.now();
  const response = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST", redirect: "manual",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  const bytes = Buffer.byteLength(text);
  assert.ok(bytes <= (path.startsWith("/api/device/") ? 2047 : 32768), `${path}: response exceeds firmware body bound (${bytes} bytes)`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${path}: expected JSON, HTTP ${response.status}; check Deployment Protection/origin`); }
  console.log(`HTTP ${response.status} ${path.split("?")[0]} ${Date.now() - startedAt}ms ${bytes}bytes`);
  return { status: response.status, json, serverTimeMs: Date.parse(response.headers.get("date")) };
}

async function session() {
  const requestId = randomUUID();
  visits.push(requestId); // Track even a partially failed server creation for cleanup.
  if (doorOnly) {
    const { error } = await service.from("ai_actions").insert({
      request_id: requestId, source: "kiosk", outcome: "in_progress",
      model: process.env.GEMINI_MODEL ?? "gemini-3.8-live", billing_tier: "unknown",
    });
    assert.ifError(error);
    return { request_id: requestId };
  }
  const response = await request("/api/ai/session", { body: { request_id: requestId } });
  assert.equal(response.status, 200, "Device session must be created");
  assert.equal(response.json.request_id, requestId);
  assert.ok(response.json.token?.startsWith("auth_tokens/"));
  assert.equal(response.json.config.speechConfig.voiceConfig.voice, "ar-eg-concierge-7");
  return response.json;
}

async function queueEmpty() {
  const { data: queued, error } = await service.from("door_commands").select("id")
    .eq("simulated", false).in("status", ["pending", "sent"]);
  assert.ifError(error);
  const ownedActions = await service.from("ai_actions").select("id").in("request_id", visits.length ? visits : [randomUUID()]);
  assert.ifError(ownedActions.error);
  if (queued.length) {
    assert.ok(ownedActions.data.length, "Another physical command exists; refusing to consume it");
    const own = await service.from("door_commands").select("id").in("ai_action_id", ownedActions.data.map((visit) => visit.id));
    assert.ifError(own.error);
    const ids = new Set(own.data.map((command) => command.id));
    assert.ok(queued.every((command) => ids.has(command.id)), "Another physical command exists; refusing to consume it");
  }
}

async function poll(expectedId = null) {
  await queueEmpty();
  const response = await request("/api/device/commands");
  assert.equal(response.status, 200);
  assert.equal(response.json.command?.id ?? null, expectedId);
  assert.ok(Number.isInteger(response.json.retry_after_ms) && response.json.retry_after_ms > 0);
  if (expectedId) {
    assert.ok(Number.isFinite(response.serverTimeMs), "Expected server Date header");
    assert.ok(Date.parse(response.json.command.expires_at) > response.serverTimeMs);
    return { ...response.json.command, receivedServerTimeMs: response.serverTimeMs };
  }
  return null;
}

async function doorStatus(requestId, expected) {
  const response = await request(`/api/ai/door-status?request_id=${requestId}`);
  assert.equal(response.status, 200);
  assert.equal(response.json.command?.status ?? null, expected);
  if (expected) assert.equal(response.json.command.simulated, false);
}

function cairoDate(days) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Date.now() + days * 86400000));
}

async function available(visit, days) {
  const date = cairoDate(days);
  for (const department of ["general", "internal_medicine", "pediatrics", "orthopedics"]) {
    const response = await request("/api/ai/availability", { body: {
      request_id: visit.request_id, department_slug: department, date_from: date, date_to: date,
    } });
    assert.equal(response.status, 200);
    const slot = response.json.slots.find((candidate) => candidate.remaining_capacity > 0 &&
      (days ? !candidate.can_enter_now : candidate.can_enter_now && Date.parse(candidate.starts_at) - Date.now() > 240000));
    if (slot) return { department, slot };
  }
  throw new Error("No suitable synthetic test slot available; no existing booking was modified");
}

async function book(visit, selected) {
  const response = await request("/api/ai/create-booking", { body: {
    request_id: visit.request_id, patient_name: "ROMI synthetic ESP32 protocol test",
    department_slug: selected.department, appointment_at: selected.slot.starts_at, open_door_now: true,
  } });
  assert.equal(response.status, 200);
  const booking = response.json.booking;
  assert.ok(booking.appointment_id && /^\d{4}$/.test(booking.booking_code));
  return booking;
}

async function appointmentStatus(id, expected) {
  const { data: booking, error } = await service.from("appointments").select("status").eq("id", id).single();
  assert.ifError(error);
  assert.equal(booking.status, expected);
}

async function checkIn(visit, booking, allowed = true) {
  const response = await request("/api/ai/check-in", { body: { request_id: visit.request_id, booking_code: booking.booking_code } });
  assert.equal(response.status, 200);
  assert.equal(response.json.attempt.ok, allowed);
  return response.json.attempt;
}

try {
  await queueEmpty();
  assert.equal((await request("/api/device/commands", { token: null })).status, 401);
  assert.equal((await request("/api/device/commands", { token: "synthetic-invalid-token" })).status, 401);
  assert.equal((await request("/api/device/commands/ack", { body: { command_id: "invalid", opened: true } })).status, 400);
  assert.equal((await request("/api/device/commands/ack", { body: { command_id: randomUUID(), opened: true } })).status, 409);
  assert.equal((await request("/api/ai/session", { body: { request_id: "invalid" } })).status, 400);
  passed("Bearer authentication and malformed/unknown command rejection");
  await poll();
  passed("Idle poll returns null and valid retry_after_ms");

  if (!doorOnly) {
    const voiceVisit = await session();
    assert.equal((await request("/api/ai/session", { body: { request_id: voiceVisit.request_id } })).status, 409);
    const wire = await probeLiveSession(voiceVisit);
    voiceVisit.token = null;
    console.log(`LIVE: ${wire.audioChunks} PCM24k chunks; largest frame ${wire.largestMessage} bytes`);
    const usage = { request_id: voiceVisit.request_id, text_input_tokens: wire.textInput, text_output_tokens: wire.textOutput,
      audio_input_tokens: wire.audioInput, audio_output_tokens: wire.audioOutput, latency_ms: wire.latencyMs, outcome: "completed" };
    assert.equal((await request("/api/ai/usage", { body: usage })).status, 200);
    const duplicateUsage = await request("/api/ai/usage", { body: usage });
    assert.equal(duplicateUsage.status, 200);
    assert.equal(duplicateUsage.json.duplicate, true);
    passed("Deployed ephemeral session, fresh UUID, raw Live setup/PCM, usage and duplicate usage");
  } else {
    console.log("SKIP: Gemini provisioning, WebSocket, PCM and usage; use the full test after fixing provider authentication.");
  }

  const futureVisit = await session();
  const futureBooking = await book(futureVisit, await available(futureVisit, 7));
  assert.equal(futureBooking.door_command_id, null);
  assert.equal(futureBooking.can_enter_now, false);
  const entry = await request("/api/ai/entry-status", { body: { request_id: futureVisit.request_id, appointment_id: futureBooking.appointment_id } });
  assert.equal(entry.status, 200);
  assert.equal(entry.json.reason, "too_early");
  const earlyVisit = await session();
  assert.equal((await checkIn(earlyVisit, futureBooking, false)).reason, "too_early");
  await poll();
  passed("Future booking consent cannot open door; early check-in and read-only entry guard");

  const doorVisit = await session();
  const doorBooking = await book(doorVisit, await available(doorVisit, 0));
  const commandId = doorBooking.door_command_id;
  assert.ok(commandId);
  await doorStatus(doorVisit.request_id, "pending");
  assert.equal((await request("/api/device/commands/ack", { body: { command_id: commandId, opened: true } })).status, 409);
  await poll(commandId);
  await poll();
  const failed = await request("/api/device/commands/ack", { body: { command_id: commandId, opened: false, error_code: "DOOR_FEEDBACK_UNAVAILABLE" } });
  assert.equal(failed.status, 200);
  assert.equal(failed.json.command.status, "failed");
  assert.equal(failed.json.command.error_code, "DOOR_FEEDBACK_UNAVAILABLE");
  await appointmentStatus(doorBooking.appointment_id, "scheduled");
  await doorStatus(doorVisit.request_id, "failed");
  passed("Claim once, no duplicate delivery, failure ACK and booking restored");

  const expiryVisit = await session();
  const expiryAttempt = await checkIn(expiryVisit, doorBooking);
  const expiringCommand = await poll(expiryAttempt.door_command_id);
  // Use the server clock; a development PC can be seconds ahead of Vercel/NTP.
  // HTTP Date has one-second precision, so wait past its rounding boundary too.
  const waitMs = Math.max(0, Date.parse(expiringCommand.expires_at) - expiringCommand.receivedServerTimeMs + 1500);
  assert.ok(waitMs <= 23000, "Expected server command TTL of approximately 20 seconds");
  console.log(`WAIT: real command expiry (${waitMs}ms), no actuator present`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  assert.equal((await request("/api/device/commands/ack", { body: { command_id: expiringCommand.id, opened: true } })).status, 409);
  await poll();
  await doorStatus(expiryVisit.request_id, "expired");
  await appointmentStatus(doorBooking.appointment_id, "scheduled");
  passed("Real TTL expiry rejects late positive ACK and restores booking");

  const successVisit = await session();
  const successAttempt = await checkIn(successVisit, doorBooking);
  await poll(successAttempt.door_command_id);
  await appointmentStatus(doorBooking.appointment_id, "entry_pending");
  // This is an explicit network simulation, not physical door verification.
  const ackBody = { command_id: successAttempt.door_command_id, opened: true };
  const opened = await request("/api/device/commands/ack", { body: ackBody });
  assert.equal(opened.status, 200);
  assert.equal(opened.json.command.id, ackBody.command_id);
  assert.equal(opened.json.command.status, "opened");
  assert.equal((await request("/api/device/commands/ack", { body: ackBody })).status, 409);
  await doorStatus(successVisit.request_id, "opened");
  await appointmentStatus(doorBooking.appointment_id, "checked_in");
  const usedVisit = await session();
  assert.equal((await checkIn(usedVisit, doorBooking, false)).reason, "already_used");
  await poll();
  passed("Synthetic positive ACK, duplicate rejection, checked-in transition and consumed-code rejection");
  console.log(`COMPLETE: ${report.length} ${doorOnly ? "door-only (seeded sessions)" : "full"} deployed protocol groups passed. Hardware/I2S/servo movement remain unverified.`);
} finally {
  const owned = await service.from("ai_actions").select("id").in("request_id", visits.length ? visits : [randomUUID()]);
  assert.ifError(owned.error);
  for (const visit of owned.data) {
    const removed = await service.from("appointments").delete().eq("creation_action_id", visit.id);
    assert.ifError(removed.error);
  }
  for (const requestId of visits) {
    const removed = await service.from("ai_actions").delete().eq("request_id", requestId);
    assert.ifError(removed.error);
  }
  console.log("CLEANUP: removed only this run's synthetic visitors/bookings/commands");
}
