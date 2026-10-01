import { GoogleGenAI, Modality, Type } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL ?? "gemini-3.8-live";
if (!apiKey) {
  console.error("GEMINI_API_KEY is not set. Load .env.local without printing its values.");
  process.exit(2);
}

const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1beta" } });
let session;
let turnCompleted = false;
let toolCalled = false;
let audioChunks = 0;
let transcript = "";
let settled = false;

const timeout = setTimeout(() => finish(new Error("Gemini Live smoke test timed out after 30 seconds.")), 30_000);

function finish(error) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  session?.close();
  if (error) {
    console.error(`Gemini Live smoke test failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Gemini Live connected to ${model}.`);
  console.log(`Audio chunks received: ${audioChunks}; transcript received: ${transcript ? "yes" : "no"}; end_conversation tool round-trip: ${toolCalled && turnCompleted ? "yes" : "no"}.`);
}

try {
  session = await ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.AUDIO],
      outputAudioTranscription: {},
      speechConfig: { voiceConfig: { voice: "ar-eg-concierge-7" } },
      systemInstruction: "إنتِ رومي موظفة استقبال مصرية ودودة. قولي تحية قصيرة جدًا بالمصري الطبيعي الأول بصوتك، وبعدها استخدمي أداة end_conversation. لا تطلبي أو تذكري أي بيانات شخصية.",
      tools: [{ functionDeclarations: [{
        name: "end_conversation",
        description: "إنهاء المحادثة التجريبية بعد التحية.",
        parameters: { type: Type.OBJECT, properties: {}, required: [] },
      }] }],
    },
    callbacks: {
      onerror: (event) => finish(new Error(event.message || "provider websocket error")),
      onclose: (event) => {
        if (!settled && !event.wasClean) finish(new Error(event.reason || "provider websocket closed unexpectedly"));
      },
      onmessage: (message) => {
        const server = message.serverContent;
        if (server?.outputTranscription?.text) transcript += server.outputTranscription.text;
        for (const part of server?.modelTurn?.parts ?? []) {
          if (part.inlineData?.data) audioChunks++;
        }
        const calls = message.toolCall?.functionCalls ?? [];
        if (calls.length) {
          const responses = calls.map((call) => {
            if (call.name !== "end_conversation") throw new Error(`Unexpected tool call: ${call.name}`);
            toolCalled = true;
            return { id: call.id, name: call.name, response: { result: "closed" } };
          });
          session.sendToolResponse({ functionResponses: responses });
        }
        if (server?.turnComplete) {
          if (toolCalled) {
            turnCompleted = true;
            finish();
          } else {
            session.sendRealtimeInput({ text: "دلوقتي نفذي أداة end_conversation بعد ما قلتي التحية." });
          }
        }
      },
    },
  });
  session.sendRealtimeInput({ text: "ابدئي التحية دلوقتي." });
} catch (error) {
  finish(error instanceof Error ? error : new Error("connection failed"));
}
