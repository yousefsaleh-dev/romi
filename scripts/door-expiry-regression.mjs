import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "../.tools/sql-test/node_modules/@electric-sql/pglite/dist/index.js";

// Execute the repository's real PL/pgSQL against a disposable local PostgreSQL.
const database = new PGlite();
const original = await readFile(new URL("../supabase/migrations/0002_booking_assistant.sql", import.meta.url), "utf8");
const correction = await readFile(new URL("../supabase/migrations/0007_preserve_active_door_retry.sql", import.meta.url), "utf8");
function functionSql(name) {
  const start = original.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0);
  return original.slice(start, original.indexOf("$$;", start) + 3);
}
await database.exec(`
  create table appointments (id uuid primary key, appointment_at timestamptz, status text);
  create table door_commands (id uuid primary key, appointment_id uuid references appointments,
    status text, simulated boolean default false, expires_at timestamptz,
    acknowledged_at timestamptz, opened_at timestamptz, error_code text);
`);
await database.exec(functionSql("appointment_window_reason"));
await database.exec(functionSql("acknowledge_door_command"));
await database.exec(functionSql("expire_old_appointments"));

async function fixture({ retryStatus, appointmentStatus = "entry_pending", appointmentOffset = "5 minutes", retryOffset = "20 seconds" } = {}) {
  const appointmentId = randomUUID();
  const retryId = randomUUID();
  await database.query("insert into appointments values ($1, now() + $2::interval, $3)", [appointmentId, appointmentOffset, appointmentStatus]);
  await database.query("insert into door_commands (id, appointment_id, status, expires_at) values ($1, $2, 'expired', now() - interval '30 seconds')", [randomUUID(), appointmentId]);
  if (retryStatus) await database.query("insert into door_commands (id, appointment_id, status, expires_at) values ($1, $2, $3, now() + $4::interval)", [retryId, appointmentId, retryStatus, retryOffset]);
  return { appointmentId, retryId };
}
async function status(id) {
  return (await database.query("select status from appointments where id=$1", [id])).rows[0].status;
}

try {
  const broken = await fixture({ retryStatus: "sent" });
  await database.exec("select expire_old_appointments()");
  assert.equal(await status(broken.appointmentId), "scheduled");
  await database.query("select acknowledge_door_command($1,true,null)", [broken.retryId]);
  assert.equal(await status(broken.appointmentId), "scheduled");
  console.log("REPRODUCED: original expiry function loses retry reservation and positive ACK cannot consume booking");

  await database.exec(correction);
  for (const retryStatus of ["pending", "sent"]) {
    const active = await fixture({ retryStatus });
    await database.exec("select expire_old_appointments(); select expire_old_appointments()");
    assert.equal(await status(active.appointmentId), "entry_pending");
    if (retryStatus === "sent") {
      await database.query("select acknowledge_door_command($1,true,null)", [active.retryId]);
      assert.equal(await status(active.appointmentId), "checked_in");
    }
  }
  for (const scenario of [
    { expected: "scheduled" },
    { retryStatus: "sent", retryOffset: "-1 second", expected: "scheduled" },
    { appointmentOffset: "-3 hours", expected: "expired" },
    { appointmentStatus: "checked_in", expected: "checked_in" },
    { appointmentStatus: "cancelled", expected: "cancelled" },
  ]) {
    const visit = await fixture(scenario);
    await database.exec("select expire_old_appointments()");
    assert.equal(await status(visit.appointmentId), scenario.expected);
  }
  console.log("PASS: migration 0007 preserves pending/sent retries, positive ACK consumes booking, expired-only releases, expired windows and terminal states remain correct");
} finally {
  await database.close();
}
