import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { GoogleGenAI } from "@google/genai";
import { probeLiveSession } from "./lib/live-wire-probe.mjs";

// Use the real server config without changing routes or involving a database/door.
const source = await readFile(new URL("../src/lib/ai/live.ts", import.meta.url), "utf8");
const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } });
const resolved = outputText.replace('from "@google/genai"', `from "${import.meta.resolve("@google/genai")}"`);
const { liveConfig, liveModel } = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString("base64")}`);
assert.ok(process.env.GEMINI_API_KEY, "GEMINI_API_KEY is required on this development PC only");
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: "v1beta" } });
const token = await ai.authTokens.create({ config: {
  uses: 1,
  expireTime: new Date(Date.now() + 120000).toISOString(),
  newSessionExpireTime: new Date(Date.now() + 60000).toISOString(),
  liveConnectConstraints: { model: liveModel, config: liveConfig },
} });
assert.ok(token.name?.startsWith("auth_tokens/"), "Missing ephemeral token");
const metrics = await probeLiveSession({ token: token.name, model: liveModel, config: liveConfig });
console.log(`PASS: ephemeral v1beta raw WebSocket, real ROMI setup, PCM16k input accepted, PCM24k output chunks=${metrics.audioChunks}, largest message=${metrics.largestMessage} bytes. No DB or door accessed.`);
