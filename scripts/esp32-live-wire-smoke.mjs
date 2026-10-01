import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { GoogleGenAI } from "@google/genai";

// Use the real server config without changing routes or involving a database/door.
const source = await readFile(new URL("../src/lib/ai/live.ts", import.meta.url), "utf8");
const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } });
const resolved = outputText.replace('from "@google/genai"', `from "${import.meta.resolve("@google/genai")}"`);
const { liveConfig, liveModel } = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString("base64")}`);
assert.ok(process.env.GEMINI_API_KEY, "GEMINI_API_KEY is required on this development PC only");
const version = process.env.ROMI_WIRE_API_VERSION ?? "v1beta";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: "v1beta" } });
const token = await ai.authTokens.create({ config: {
  uses: 1,
  expireTime: new Date(Date.now() + 120000).toISOString(),
  newSessionExpireTime: new Date(Date.now() + 60000).toISOString(),
  liveConnectConstraints: { model: liveModel, config: liveConfig },
} });
assert.ok(token.name?.startsWith("auth_tokens/"), "Missing ephemeral token");
const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${version}.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token.name)}`;
const socket = new WebSocket(url);
let setupConfirmed = false, chunks = 0, maximumMessage = 0;
await new Promise((resolve, reject) => {
  let settled = false;
  const timeout = setTimeout(() => finish(new Error("Raw ESP32 protocol probe timed out")), 30000);
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    socket.close();
    if (error) reject(error);
    else resolve();
  };
  socket.onopen = () => socket.send(JSON.stringify({ setup: {
    model: liveModel.startsWith("models/") ? liveModel : `models/${liveModel}`,
    generationConfig: { responseModalities: liveConfig.responseModalities, speechConfig: liveConfig.speechConfig },
    systemInstruction: { parts: [{ text: liveConfig.systemInstruction }] },
    tools: liveConfig.tools,
    inputAudioTranscription: liveConfig.inputAudioTranscription,
    outputAudioTranscription: liveConfig.outputAudioTranscription,
  } }));
  socket.onerror = () => finish(new Error("Raw WebSocket connection failed (credentials withheld)"));
  socket.onclose = (event) => { if (!setupConfirmed || !chunks) finish(new Error(`Provider closed before audio: code=${event.code}`)); };
  socket.onmessage = async (event) => {
    try {
      const json = event.data instanceof Blob ? await event.data.text() : event.data;
      const message = JSON.parse(json);
      maximumMessage = Math.max(maximumMessage, Buffer.byteLength(json));
      if (message.error) throw new Error(`Provider rejected raw setup: code=${message.error.code ?? "unknown"}`);
      if (message.setupComplete) {
        setupConfirmed = true;
        socket.send(JSON.stringify({ realtimeInput: { audio: {
          mimeType: "audio/pcm;rate=16000", data: Buffer.alloc(640).toString("base64"),
        } } }));
        socket.send(JSON.stringify({ realtimeInput: { text: "دي تجربة تقنية صناعية فقط. قولي أهلاً باختصار ثم نفذي end_conversation. لا تنشئي حجزًا ولا تستدعي أي أداة أخرى." } }));
      }
      for (const part of message.serverContent?.modelTurn?.parts ?? []) {
        if (!part.inlineData?.data) continue;
        assert.match(part.inlineData.mimeType, /^audio\/pcm;rate=24000$/);
        assert.equal(Buffer.from(part.inlineData.data, "base64").length % 2, 0);
        chunks++;
      }
      if (chunks && (message.serverContent?.turnComplete || message.toolCall?.functionCalls?.some((call) => call.name === "end_conversation"))) finish();
    } catch (error) { finish(error); }
  };
}).catch((error) => { socket.close(); throw error; });
assert.ok(setupConfirmed && chunks);
assert.ok(maximumMessage <= 65536, `Provider frame exceeds the ESP32 limit: ${maximumMessage} bytes`);
console.log(`PASS: ephemeral ${version} raw WebSocket, real ROMI setup, PCM16k input accepted, PCM24k output chunks=${chunks}, largest message=${maximumMessage} bytes. No DB or door accessed.`);
