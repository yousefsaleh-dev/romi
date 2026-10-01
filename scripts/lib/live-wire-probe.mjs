import assert from "node:assert/strict";

// Exercise the raw ESP32 wire format; no microphone, speaker or I2S is simulated here.
export async function probeLiveSession({ token, model, config }) {
  assert.ok(token?.startsWith("auth_tokens/"), "Expected a one-use ephemeral token");
  const socket = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`);
  const startedAt = Date.now();
  const metrics = { setupConfirmed: false, audioChunks: 0, largestMessage: 0, latencyMs: null,
    textInput: 0, textOutput: 0, audioInput: 0, audioOutput: 0 };
  await new Promise((resolve, reject) => {
    let settled = false;
    let incoming = Promise.resolve();
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(new Error("Gemini wire probe timed out")), 30000);
    socket.onopen = () => socket.send(JSON.stringify({ setup: {
      model: model.startsWith("models/") ? model : `models/${model}`,
      generationConfig: { responseModalities: config.responseModalities, speechConfig: config.speechConfig },
      systemInstruction: { parts: [{ text: config.systemInstruction }] },
      tools: config.tools, inputAudioTranscription: config.inputAudioTranscription,
      outputAudioTranscription: config.outputAudioTranscription,
    } }));
    socket.onerror = () => finish(new Error("Gemini connection failed; credentials withheld"));
    socket.onclose = (event) => {
      if (!settled) finish(new Error(`Gemini disconnected before completion: ${event.code}`));
    };
    socket.onmessage = (event) => {
      incoming = incoming.then(async () => {
        if (settled) return;
        const json = event.data instanceof Blob ? await event.data.text() : event.data;
        const bytes = Buffer.byteLength(json);
        assert.ok(bytes <= 65536, `Provider frame exceeds firmware limit: ${bytes}`);
        metrics.largestMessage = Math.max(metrics.largestMessage, bytes);
        const message = JSON.parse(json);
        assert.ok(!message.error, `Gemini rejected setup: code=${message.error?.code ?? "unknown"}`);
        if (message.setupComplete) {
          metrics.setupConfirmed = true;
          socket.send(JSON.stringify({ realtimeInput: { audio: {
            mimeType: "audio/pcm;rate=16000", data: Buffer.alloc(640).toString("base64"),
          } } }));
          socket.send(JSON.stringify({ realtimeInput: { text: "دي تجربة تقنية صناعية فقط. قولي أهلاً باختصار ثم نفذي end_conversation. لا تنشئي حجزًا ولا تستدعي أي أداة أخرى." } }));
        }
        for (const detail of message.usageMetadata?.promptTokensDetails ?? []) {
          metrics[detail.modality === "AUDIO" ? "audioInput" : "textInput"] += detail.tokenCount ?? 0;
        }
        for (const detail of message.usageMetadata?.responseTokensDetails ?? []) {
          metrics[detail.modality === "AUDIO" ? "audioOutput" : "textOutput"] += detail.tokenCount ?? 0;
        }
        for (const part of message.serverContent?.modelTurn?.parts ?? []) {
          if (!part.inlineData?.data) continue;
          assert.match(part.inlineData.mimeType, /^audio\/pcm;rate=24000$/);
          assert.equal(Buffer.from(part.inlineData.data, "base64").length % 2, 0);
          metrics.audioChunks++;
          metrics.latencyMs ??= Date.now() - startedAt;
        }
        const calls = message.toolCall?.functionCalls ?? [];
        assert.ok(calls.every((call) => call.name === "end_conversation"), "Synthetic voice probe must not perform business operations");
        if (metrics.audioChunks && (message.serverContent?.turnComplete || calls.length)) finish();
      }).catch(finish);
    };
  });
  assert.ok(metrics.setupConfirmed && metrics.audioChunks, "Expected setupComplete and PCM audio output");
  return metrics;
}
