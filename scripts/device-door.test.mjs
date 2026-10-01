import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";

const source = await readFile(new URL("../src/lib/ai/device-door.ts", import.meta.url), "utf8");
const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } });
const { waitForDeviceDoor } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

const requestId = "a984223c-deb5-4b43-9729-5d9f4fa829ce";
const headers = { Authorization: "Bearer synthetic-test-token" };

test("physical status polling carries device auth and never acknowledges a command", async (context) => {
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({ command: { simulated: false, status: "opened" } });
  });
  assert.equal(await waitForDeviceDoor(requestId, headers, new AbortController().signal), "door_opened");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/ai/door-status?request_id=${requestId}`);
  assert.equal(calls[0].options.headers.Authorization, headers.Authorization);
  assert.equal(calls[0].options.method, undefined);
});

test("a failed physical command never becomes opened", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({ command: { simulated: false, status: "failed" } }));
  assert.equal(await waitForDeviceDoor(requestId, headers, new AbortController().signal), "door_failed");
});

test("an opened simulation command cannot confirm the physical door", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({ command: { simulated: true, status: "opened" } }));
  await assert.rejects(waitForDeviceDoor(requestId, headers, new AbortController().signal), /ليس لأمر باب فعلي/u);
});

test("unacknowledged commands remain pending after the wait limit", async (context) => {
  let clock = 0;
  context.mock.method(Date, "now", () => clock);
  context.mock.method(globalThis, "fetch", async () => {
    clock = 19000;
    return Response.json({ command: { simulated: false, status: "sent" } });
  });
  assert.equal(await waitForDeviceDoor(requestId, headers, new AbortController().signal), "door_pending");
});

test("cancelled visitors do not continue polling", async (context) => {
  const controller = new AbortController();
  controller.abort();
  const fetch = context.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  assert.equal(await waitForDeviceDoor(requestId, headers, controller.signal), "door_pending");
  assert.equal(fetch.mock.callCount(), 0);
});

test("authentication errors are reported rather than treated as door success", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({ error: "denied" }, { status: 401 }));
  await assert.rejects(waitForDeviceDoor(requestId, headers, new AbortController().signal), /توكن/u);
});

test("malformed JSON cannot confirm opening", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response("broken JSON"));
  await assert.rejects(waitForDeviceDoor(requestId, headers, new AbortController().signal), SyntaxError);
});
