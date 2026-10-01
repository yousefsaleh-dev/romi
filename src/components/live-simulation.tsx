"use client";

import { GoogleGenAI } from "@google/genai";
import { AudioLines, CircleStop, DoorOpen, Mic, Radio, ShieldCheck, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { waitForDeviceDoor, type DeviceDoorResult } from "@/lib/ai/device-door";

type Phase = "idle" | "connecting" | "listening" | "speaking" | "checking" | "closing" | "error";
type TranscriptSpeaker = "patient" | "romi";
type FrequencyBins = Uint8Array<ArrayBuffer>;
type AudioAnalyzers = { microphone: AnalyserNode; romi: AnalyserNode } | null;
type SpectrumDrawing = { drawing: CanvasRenderingContext2D; centerX: number; centerY: number; radius: number; bins: FrequencyBins | null; color: string };
type WaveformFrame = { canvas: HTMLCanvasElement; drawing: CanvasRenderingContext2D; analyser?: AnalyserNode; bins: FrequencyBins | null; romiSpeaking: boolean };
type LogItem = { id: string; label: string; detail: string; kind: "info" | "tool" | "success" | "error" };
type SessionInfo = { token: string; model: string; request_id: string; config: Record<string, unknown> };
type GeminiFunctionCall = { id?: string; name?: string; args?: Record<string, unknown> };

const phaseLabels: Record<Phase, string> = {
  idle: "جاهز للتجربة", connecting: "جاري الاتصال", listening: "رومي بتسمعك", speaking: "رومي بترد عليك", checking: "جاري فحص كود الحجز", closing: "جاري إنهاء الجلسة", error: "حصلت مشكلة",
};

function cairoDateTime(value: string) {
  return new Intl.DateTimeFormat("ar-EG", { timeZone: "Africa/Cairo", dateStyle: "full", timeStyle: "short" }).format(new Date(value));
}

function isFarewellTranscript(transcript: string) {
  const normalized = transcript.normalize("NFKC").replace(/[\u064B-\u065F\u0670]/g, "");
  return /(?:مع السلامة|في أمان الله|يومك سعيد|نهارك سعيد)/u.test(normalized);
}

async function confirmSimulatedDoorOpening(commandId: string, requestId: string) {
  const openingResponse = await fetch("/api/simulation/door-open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command_id: commandId }),
  });
  if (!openingResponse.ok) return false;
  const statusResponse = await fetch(`/api/ai/door-status?${new URLSearchParams({ request_id: requestId })}`, { cache: "no-store" });
  if (!statusResponse.ok) return false;
  const statusPayload = await statusResponse.json();
  return statusPayload.command?.status === "opened";
}

export function LiveSimulation({ configured, mode = "simulation" }: { configured: boolean; mode?: "simulation" | "device" }) {
  const router = useRouter();
  const physicalDoor = mode === "device";
  const [deviceToken, setDeviceToken] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [caption, setCaption] = useState("");
  const [captionSpeaker, setCaptionSpeaker] = useState<TranscriptSpeaker | null>(null);
  const [captionSequence, setCaptionSequence] = useState(0);
  const [audioAnalyzers, setAudioAnalyzers] = useState<AudioAnalyzers>(null);
  const [items, setItems] = useState<LogItem[]>([]);
  const [error, setError] = useState("");
  const sessionRef = useRef<Awaited<ReturnType<GoogleGenAI["live"]["connect"]>> | null>(null);
  const apiHeadersRef = useRef<Record<string, string>>({ "Content-Type": "application/json" });
  const requestsRef = useRef<AbortController | null>(null);
  const closingRef = useRef(false);
  const startingRef = useRef(false);
  const lifecycleRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const playbackRef = useRef(0);
  const maxDurationRef = useRef<number | null>(null);
  const silenceCheckRef = useRef<number | null>(null);
  const lastActivityAtRef = useRef(0);
  const audioSourcesRef = useRef(new Set<AudioBufferSourceNode>());
  const requestIdRef = useRef<string | null>(null);
  const connectedAtRef = useRef(0);
  const firstResponseLatencyRef = useRef<number | null>(null);
  const usageRef = useRef({ textInput: 0, textOutput: 0, audioInput: 0, audioOutput: 0 });
  const busyRef = useRef(false);
  const outcomeRef = useRef<"missing_code" | "provider_error" | "completed">("missing_code");
  const closeAfterFarewellRef = useRef(false);
  const farewellTurnCompleteRef = useRef(false);
  const captionSpeakerRef = useRef<TranscriptSpeaker | null>(null);
  const captionTextRef = useRef("");
  const captionSequenceRef = useRef(0);
  const addItem = useCallback((item: Omit<LogItem, "id">) => setItems((current) => [{ ...item, id: crypto.randomUUID() }, ...current].slice(0, 4)), []);

  function replaceCaption(speaker: TranscriptSpeaker, text: string) {
    const transcript = text.trim().slice(-500);
    if (!transcript) return;
    if (captionSpeakerRef.current !== speaker) {
      captionSpeakerRef.current = speaker;
      captionSequenceRef.current += 1;
      setCaptionSequence(captionSequenceRef.current);
    }
    captionTextRef.current = transcript;
    setCaptionSpeaker(speaker);
    setCaption(transcript);
  }

  function appendCaption(speaker: TranscriptSpeaker, text: string) {
    const fragment = text.trim();
    if (!fragment) return;
    if (captionSpeakerRef.current !== speaker) {
      replaceCaption(speaker, fragment);
      return;
    }
    captionTextRef.current = `${captionTextRef.current} ${fragment}`.trim().slice(-500);
    setCaption(captionTextRef.current);
  }

  const stop = useCallback(async (finalPhase: Phase = "idle") => {
    if (closingRef.current) return;
    closingRef.current = true;
    lifecycleRef.current += 1;
    setPhase("closing");
    requestsRef.current?.abort();
    const requestId = requestIdRef.current;
    requestIdRef.current = null;
    const apiHeaders = apiHeadersRef.current;
    apiHeadersRef.current = { "Content-Type": "application/json" };
    sessionRef.current?.close();
    sessionRef.current = null;
    if (maxDurationRef.current) window.clearTimeout(maxDurationRef.current);
    maxDurationRef.current = null;
    if (silenceCheckRef.current) window.clearInterval(silenceCheckRef.current);
    silenceCheckRef.current = null;
    audioSourcesRef.current.forEach((source) => source.stop());
    audioSourcesRef.current.clear();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const context = audioContextRef.current;
    if (context) await context.close().catch(() => undefined);
    audioContextRef.current = null;
    setAudioAnalyzers(null);
    if (requestId) {
      const usage = usageRef.current;
      const response = await fetch("/api/ai/usage", { method: "POST", headers: apiHeaders, signal: AbortSignal.timeout(5000), body: JSON.stringify({
        request_id: requestId, text_input_tokens: usage.textInput, text_output_tokens: usage.textOutput,
        audio_input_tokens: usage.audioInput, audio_output_tokens: usage.audioOutput,
        latency_ms: firstResponseLatencyRef.current,
        outcome: finalPhase === "error" ? "provider_error" : outcomeRef.current,
      }) }).catch(() => null);
      if (response?.ok) router.refresh();
      else addItem({ label: "الاستخدام لم يُحفظ", detail: "تعذّر تسجيل تكلفة الجلسة؛ جرّب تحديث الصفحة", kind: "error" });
    }
    closeAfterFarewellRef.current = false;
    farewellTurnCompleteRef.current = false;
    busyRef.current = false;
    closingRef.current = false;
    setPhase(finalPhase);
  }, [addItem, router]);

  useEffect(() => () => {
    lifecycleRef.current += 1;
    requestsRef.current?.abort();
    if (maxDurationRef.current) window.clearTimeout(maxDurationRef.current);
    if (silenceCheckRef.current) window.clearInterval(silenceCheckRef.current);
    audioSourcesRef.current.forEach((source) => source.stop());
    audioSourcesRef.current.clear();
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    void audioContextRef.current?.close();
  }, []);

  async function start() {
    if (startingRef.current || closingRef.current || sessionRef.current) return;
    if (physicalDoor && !deviceToken.trim()) { setError("أدخل توكن جهاز الاستقبال أولًا."); return; }
    startingRef.current = true;
    const generation = ++lifecycleRef.current;
    const requests = new AbortController();
    requestsRef.current = requests;
    const apiHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (physicalDoor) apiHeaders.Authorization = `Bearer ${deviceToken.trim()}`;
    apiHeadersRef.current = apiHeaders;
    setError(""); setCaption(""); setCaptionSpeaker(null); setCaptionSequence(0); setItems([]); setPhase("connecting");
    captionSpeakerRef.current = null;
    captionTextRef.current = "";
    captionSequenceRef.current = 0;
    setAudioAnalyzers(null);
    connectedAtRef.current = 0;
    lastActivityAtRef.current = Date.now();
    firstResponseLatencyRef.current = null;
    usageRef.current = { textInput: 0, textOutput: 0, audioInput: 0, audioOutput: 0 };
    outcomeRef.current = "missing_code";
    closeAfterFarewellRef.current = false;
    farewellTurnCompleteRef.current = false;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("افتح الموقع على localhost أو HTTPS واسمح باستخدام الميكروفون.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (lifecycleRef.current !== generation) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      const requestId = crypto.randomUUID();
      const sessionResponse = await fetch("/api/ai/session", { method: "POST", headers: apiHeaders, signal: requests.signal, body: JSON.stringify({ request_id: requestId }) });
      const sessionData = await sessionResponse.json() as SessionInfo & { error?: string };
      if (!sessionResponse.ok) throw new Error(sessionData.error ?? "تعذّر تجهيز جلسة AI.");
      if (lifecycleRef.current !== generation) return;
      requestIdRef.current = requestId;
      const confirmDoor = async (commandId: string): Promise<DeviceDoorResult> => {
        if (physicalDoor) return waitForDeviceDoor(requestId, apiHeaders, requests.signal);
        return await confirmSimulatedDoorOpening(commandId, requestId) ? "door_opened" : "door_failed";
      };
      const context = new AudioContext();
      audioContextRef.current = context;
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const microphoneAnalyser = context.createAnalyser();
      microphoneAnalyser.fftSize = 512;
      microphoneAnalyser.smoothingTimeConstant = 0.78;
      const romiAnalyser = context.createAnalyser();
      romiAnalyser.fftSize = 512;
      romiAnalyser.smoothingTimeConstant = 0.78;
      source.connect(microphoneAnalyser);
      romiAnalyser.connect(context.destination);
      setAudioAnalyzers({ microphone: microphoneAnalyser, romi: romiAnalyser });
      const processor = context.createScriptProcessor(4096, 1, 1);
      const muted = context.createGain(); muted.gain.value = 0;
      source.connect(processor); processor.connect(muted); muted.connect(context.destination);
      const ai = new GoogleGenAI({ apiKey: sessionData.token, httpOptions: { apiVersion: "v1beta" } });
      const session = await ai.live.connect({ model: sessionData.model, config: sessionData.config as never, callbacks: {
        onopen: () => { if (lifecycleRef.current !== generation) return; connectedAtRef.current = Date.now(); setPhase("listening"); addItem({ label: "اتصلت الجلسة الصوتية", detail: "Gemini Live · صوت مباشر", kind: "info" }); },
        onerror: (event) => { if (lifecycleRef.current !== generation) return; setError(event.message || "انقطع الاتصال بخدمة الصوت."); addItem({ label: "خطأ في الاتصال", detail: event.message || "تعذّر الاتصال بـ Gemini Live", kind: "error" }); void stop("error"); },
        onclose: (event) => {
          if (lifecycleRef.current !== generation) return;
          if (!sessionRef.current) return;
          const disconnected = !event.wasClean;
          if (disconnected) setError("انقطع اتصال Gemini Live.");
          addItem({ label: disconnected ? "انقطع الاتصال" : "انتهت الجلسة الصوتية", detail: disconnected ? event.reason || "تحقق من الشبكة ثم حاول مرة أخرى" : "تم إغلاق اتصال Gemini Live", kind: disconnected ? "error" : "info" });
          void stop(disconnected ? "error" : "idle");
        },
        onmessage: async (message) => {
          if (lifecycleRef.current !== generation) return;
          const usage = message.usageMetadata as { promptTokensDetails?: { modality?: string; tokenCount?: number }[]; responseTokensDetails?: { modality?: string; tokenCount?: number }[]; toolUsePromptTokensDetails?: { modality?: string; tokenCount?: number }[] } | undefined;
          for (const entry of [...(usage?.promptTokensDetails ?? []), ...(usage?.toolUsePromptTokensDetails ?? [])]) { if (entry.modality === "AUDIO") usageRef.current.audioInput += entry.tokenCount ?? 0; else usageRef.current.textInput += entry.tokenCount ?? 0; }
          for (const entry of usage?.responseTokensDetails ?? []) { if (entry.modality === "AUDIO") usageRef.current.audioOutput += entry.tokenCount ?? 0; else usageRef.current.textOutput += entry.tokenCount ?? 0; }
          const server = message.serverContent as { interrupted?: boolean; turnComplete?: boolean; interimInputTranscription?: { text?: string }; inputTranscription?: { text?: string }; outputTranscription?: { text?: string }; modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string }; text?: string }[] } } | undefined;
          if (server?.interrupted) {
            audioSourcesRef.current.forEach((source) => source.stop());
            audioSourcesRef.current.clear();
            playbackRef.current = audioContextRef.current?.currentTime ?? 0;
            setPhase("listening");
          }
          if (server?.interimInputTranscription?.text) { lastActivityAtRef.current = Date.now(); replaceCaption("patient", server.interimInputTranscription.text); }
          if (server?.inputTranscription?.text) { lastActivityAtRef.current = Date.now(); replaceCaption("patient", server.inputTranscription.text); }
          if (server?.outputTranscription?.text) {
            lastActivityAtRef.current = Date.now();
            firstResponseLatencyRef.current ??= Date.now() - connectedAtRef.current;
            appendCaption("romi", server.outputTranscription.text);
            setPhase("speaking");
            if (!closeAfterFarewellRef.current && isFarewellTranscript(captionTextRef.current)) {
              closeAfterFarewellRef.current = true;
              outcomeRef.current = "completed";
              streamRef.current?.getTracks().forEach((track) => track.stop());
              streamRef.current = null;
              addItem({ label: "انتهت المحادثة", detail: "", kind: "info" });
            }
          }
          const audioContext = audioContextRef.current;
          for (const part of server?.modelTurn?.parts ?? []) {
            if (part.inlineData?.data && audioContext) {
              lastActivityAtRef.current = Date.now();
              firstResponseLatencyRef.current ??= Date.now() - connectedAtRef.current;
              const bytes = Uint8Array.from(atob(part.inlineData.data), (char) => char.charCodeAt(0));
              const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
              const buffer = audioContext.createBuffer(1, pcm.length, 24_000);
              const channel = buffer.getChannelData(0);
              for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
              const player = audioContext.createBufferSource(); player.buffer = buffer; player.connect(romiAnalyser);
              audioSourcesRef.current.add(player);
              player.onended = () => {
                if (lifecycleRef.current !== generation) return;
                audioSourcesRef.current.delete(player);
                if (audioSourcesRef.current.size === 0 && !busyRef.current && sessionRef.current) setPhase("listening");
                if (audioSourcesRef.current.size === 0 && closeAfterFarewellRef.current && farewellTurnCompleteRef.current) {
                  closeAfterFarewellRef.current = false;
                  void stop();
                }
              };
              playbackRef.current = Math.max(playbackRef.current, audioContext.currentTime);
              player.start(playbackRef.current); playbackRef.current += buffer.duration; setPhase("speaking");
            }
          }
          const functionCalls = (message.toolCall as { functionCalls?: GeminiFunctionCall[] } | undefined)?.functionCalls ?? [];
          if (functionCalls.length && !busyRef.current) {
            busyRef.current = true; setPhase("checking");
            const responses: { id?: string; name?: string; response: Record<string, unknown> }[] = [];
            for (const call of functionCalls) {
              if (lifecycleRef.current !== generation) return;
              try {
                if (call.name === "check_in_booking" && typeof call.args?.booking_code === "string") {
                  const code = call.args.booking_code.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x6f0));
                  addItem({ label: "الأداة: فحص الحجز", detail: `الخادم يتحقق من ${code.replace(/\d/g, "•")}`, kind: "tool" });
                  const response = await fetch("/api/ai/check-in", { method: "POST", headers: apiHeaders, signal: requests.signal, body: JSON.stringify({ request_id: requestId, booking_code: code }) });
                  const payload = await response.json();
                  if (lifecycleRef.current !== generation) return;
                  if (!response.ok) throw new Error(payload.error ?? "تعذّر التحقق.");
                  const attempt = payload.attempt;
                  let doorResult = attempt.reason;
                  if (attempt.ok && attempt.door_command_id) {
                    doorResult = await confirmDoor(attempt.door_command_id);
                    if (lifecycleRef.current !== generation) return;
                    addItem({ label: doorResult === "door_opened" ? (physicalDoor ? "ESP32 أكد فتح الباب" : "الباب اتفتح · محاكاة")
                      : doorResult === "door_pending" ? "في انتظار تأكيد ESP32" : "الحجز صحيح · الباب لم يتأكد",
                      detail: "", kind: doorResult === "door_opened" ? "success" : doorResult === "door_pending" ? "info" : "error" });
                  } else if (!attempt.ok) {
                    addItem({ label: "تعذّر قبول الحجز", detail: `سبب القرار: ${attempt.reason}`, kind: "error" });
                  }
                  responses.push({ id: call.id, name: call.name, response: { result: doorResult, entry_allowed_now: attempt.ok === true, reason: attempt.reason, attempts_remaining: attempt.attempts_remaining } });
                } else if (call.name === "find_available_slots") {
                  const department = call.args?.department_slug;
                  const dateFrom = call.args?.date_from;
                  const dateTo = call.args?.date_to;
                  if (typeof department !== "string" || typeof dateFrom !== "string" || typeof dateTo !== "string") throw new Error("حدد القسم والفترة المطلوبة.");
                  addItem({ label: "الأداة: بحث عن مواعيد", detail: `${dateFrom} إلى ${dateTo}`, kind: "tool" });
                  const response = await fetch("/api/ai/availability", { method: "POST", headers: apiHeaders, signal: requests.signal, body: JSON.stringify({ request_id: requestId, department_slug: department, date_from: dateFrom, date_to: dateTo }) });
                  const payload = await response.json();
                  if (lifecycleRef.current !== generation) return;
                  if (!response.ok) throw new Error(payload.error ?? "تعذّر البحث عن المواعيد.");
                  const slots = (payload.slots ?? []).map((slot: { department_name: string; starts_at: string; duration_minutes: number; remaining_capacity: number; can_enter_now: boolean; entry_window_opens_at: string; entry_window_closes_at: string; checked_at: string }) => ({
                    appointment_at: slot.starts_at,
                    department: slot.department_name,
                    appointment_time: cairoDateTime(slot.starts_at),
                    duration_minutes: slot.duration_minutes,
                    remaining_capacity: slot.remaining_capacity,
                    can_enter_now: slot.can_enter_now,
                    entry_window_opens_at: slot.entry_window_opens_at,
                    entry_window_closes_at: slot.entry_window_closes_at,
                    checked_at: slot.checked_at,
                  }));
                  addItem({ label: slots.length ? "مواعيد متاحة" : "مفيش مواعيد في الفترة", detail: `${slots.length} اختيار رجع من قاعدة البيانات`, kind: slots.length ? "success" : "info" });
                  responses.push({ id: call.id, name: call.name, response: { result: slots.length ? "slots_found" : "no_slots", slots } });
                } else if (call.name === "create_booking") {
                  const patientName = call.args?.patient_name;
                  const department = call.args?.department_slug;
                  const appointmentAt = call.args?.appointment_at;
                  const openDoorNow = call.args?.open_door_now === true;
                  if (typeof patientName !== "string" || typeof department !== "string" || typeof appointmentAt !== "string") throw new Error("اسم صاحب الحجز والقسم والموعد المختار مطلوبين.");
                  addItem({ label: "رومي بتسجل الحجز", detail: "", kind: "tool" });
                  const response = await fetch("/api/ai/create-booking", { method: "POST", headers: apiHeaders, signal: requests.signal, body: JSON.stringify({ request_id: requestId, patient_name: patientName, department_slug: department, appointment_at: appointmentAt, open_door_now: openDoorNow }) });
                  const payload = await response.json();
                  if (lifecycleRef.current !== generation) return;
                  if (!response.ok && !payload.booking) throw new Error(payload.error ?? "تعذّر إنشاء الحجز.");
                  const booking = payload.booking;
                  let doorResult = booking.reason ?? "booking_created_future";
                  if (booking.ok && booking.door_command_id) {
                    doorResult = await confirmDoor(booking.door_command_id);
                    if (lifecycleRef.current !== generation) return;
                    addItem({ label: doorResult === "door_opened" ? (physicalDoor ? "ESP32 أكد فتح الباب" : "الباب اتفتح · محاكاة")
                      : doorResult === "door_pending" ? "في انتظار تأكيد ESP32" : "الحجز اتسجل · الباب لم يتأكد",
                      detail: "", kind: doorResult === "door_opened" ? "success" : doorResult === "door_pending" ? "info" : "error" });
                  } else if (booking.ok) {
                    addItem({ label: "الحجز اتسجل", detail: "موعد لاحق؛ لم يصدر أمر للباب", kind: "success" });
                  } else {
                    addItem({ label: "الموعد لم يعد متاحًا", detail: `سبب الخادم: ${booking.reason}`, kind: "error" });
                  }
                  responses.push({ id: call.id, name: call.name, response: {
                    result: doorResult,
                    appointment_id: booking.appointment_id,
                    booking_code: booking.booking_code,
                    appointment_time: booking.appointment_at ? cairoDateTime(booking.appointment_at) : undefined,
                    department_slug: booking.department_slug ?? department,
                    can_enter_now: booking.can_enter_now,
                    checked_at: booking.checked_at,
                    entry_window_opens_at: booking.entry_window_opens_at,
                    entry_window_closes_at: booking.entry_window_closes_at,
                    door_open_skipped_reason: booking.door_open_skipped_reason,
                    entry_message_ar: booking.entry_message_ar,
                  } });
                } else if (call.name === "get_booking_entry_status") {
                  const appointmentId = call.args?.appointment_id;
                  if (typeof appointmentId !== "string") throw new Error("معرّف الحجز مطلوب.");
                  const response = await fetch("/api/ai/entry-status", {
                    method: "POST", headers: apiHeaders, signal: requests.signal,
                    body: JSON.stringify({ request_id: requestId, appointment_id: appointmentId }),
                  });
                  const payload = await response.json();
                  if (lifecycleRef.current !== generation) return;
                  if (!response.ok) throw new Error(payload.error ?? "تعذّر فحص موعد الدخول.");
                  addItem({ label: "فحص موعد الدخول الحالي", detail: payload.entry_message_ar, kind: payload.can_enter_now ? "success" : "info" });
                  responses.push({ id: call.id, name: call.name, response: payload });
                } else if (call.name === "end_conversation") {
                  if (!closeAfterFarewellRef.current) addItem({ label: "انتهت المحادثة", detail: "", kind: "info" });
                  outcomeRef.current = "completed";
                  closeAfterFarewellRef.current = true;
                  farewellTurnCompleteRef.current = true;
                  streamRef.current?.getTracks().forEach((track) => track.stop());
                  streamRef.current = null;
                } else {
                  responses.push({ id: call.id, name: call.name, response: { result: "unsupported_tool" } });
                }
              } catch (toolError) {
                if (lifecycleRef.current !== generation) return;
                const errorText = toolError instanceof Error ? toolError.message : "فشل تنفيذ الطلب.";
                addItem({ label: "تعذّر تنفيذ الطلب", detail: errorText, kind: "error" });
                responses.push({ id: call.id, name: call.name, response: { result: "error", message: errorText } });
              }
            }
            if (lifecycleRef.current !== generation) return;
            lastActivityAtRef.current = Date.now();
            if (responses.length) sessionRef.current?.sendToolResponse({ functionResponses: responses as never });
            if (functionCalls.some((call) => call.name === "end_conversation")) {
              const closingSession = sessionRef.current;
              sessionRef.current = null;
              closingSession?.close();
            }
            busyRef.current = false; setPhase("listening");
          }
          if (server?.turnComplete && closeAfterFarewellRef.current) farewellTurnCompleteRef.current = true;
          if (closeAfterFarewellRef.current && farewellTurnCompleteRef.current && audioSourcesRef.current.size === 0 && !busyRef.current) {
            closeAfterFarewellRef.current = false;
            void stop();
          }
        },
      } });
      if (lifecycleRef.current !== generation) { session.close(); return; }
      sessionRef.current = session;
      session.sendRealtimeInput({ text: "ابدئي الكلام بتحية مصرية قصيرة، وعرّفي بنفسك باسم رومي." });
      maxDurationRef.current = window.setTimeout(() => {
        addItem({ label: "انتهى الحد الأقصى للجلسة", detail: "تم إيقافها بعد ١٢ دقيقة للتحكم في الاستخدام", kind: "info" });
        void stop();
      }, 12 * 60_000);
      processor.onaudioprocess = (event) => {
        if (lifecycleRef.current !== generation || !sessionRef.current) return;
        const input = event.inputBuffer.getChannelData(0);
        let energy = 0;
        for (const sample of input) energy += sample * sample;
        if (Math.sqrt(energy / input.length) > 0.018) lastActivityAtRef.current = Date.now();
        const ratio = context.sampleRate / 16_000;
        const length = Math.floor(input.length / ratio);
        const pcm = new Int16Array(length);
        for (let i = 0; i < length; i++) {
          const start = Math.floor(i * ratio);
          const end = Math.min(input.length, Math.floor((i + 1) * ratio));
          let total = 0;
          for (let sampleIndex = start; sampleIndex < end; sampleIndex++) total += input[sampleIndex];
          const sample = total / Math.max(1, end - start);
          pcm[i] = Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767);
        }
        const raw = new Uint8Array(pcm.buffer);
        let binary = ""; for (let i = 0; i < raw.length; i += 0x8000) binary += String.fromCharCode(...raw.subarray(i, i + 0x8000));
        sessionRef.current.sendRealtimeInput({ audio: { data: btoa(binary), mimeType: "audio/pcm;rate=16000" } });
      };
      addItem({ label: "الميكروفون شغال", detail: "الصوت يُرسل مباشرة إلى Gemini Live ولا يُحفظ", kind: "info" });
      silenceCheckRef.current = window.setInterval(() => {
        if (!sessionRef.current || busyRef.current || audioSourcesRef.current.size > 0) return;
        if (Date.now() - lastActivityAtRef.current < 20_000) return;
        addItem({ label: "انتهت الجلسة بسبب الصمت", detail: "مرّت ٢٠ ثانية من غير كلام من الزائر", kind: "info" });
        void stop();
      }, 500);
    } catch (startError) {
      if (lifecycleRef.current !== generation) return;
      const message = startError instanceof Error ? startError.message : "تعذّر تشغيل المحاكاة.";
      setError(message); setPhase("error"); addItem({ label: "تعذّر بدء المحاكاة", detail: message, kind: "error" });
      await stop("error");
    } finally {
      startingRef.current = false;
    }
  }

  return (
    <section className="simulation-workspace" aria-label="المحاكاة الصوتية" dir="rtl">
      <div className="simulation-conversation">
        <header className="conversation-heading">
          <span className="simulation-icon"><AudioLines aria-hidden="true" /></span>
          <div><p className="eyebrow">اتصال صوتي مباشر</p><h2>بوابة استقبال المستشفى</h2></div>
          <span className={`simulation-state ${phase !== "idle" && phase !== "error" ? "active" : ""}`}><i />{phaseLabels[phase]}</span>
        </header>
        <div className="live-caption" aria-live="polite" aria-atomic="false">
          <div className={`caption-speaker ${captionSpeaker ?? "waiting"}`}>
            <span />{captionSpeaker === "patient" ? "أنت بتقول" : captionSpeaker === "romi" ? "ROMI بترد" : "الكلام المباشر"}
          </div>
          {caption ? (
            <p className="caption-text" key={captionSequence}>
              {caption.split(/(\s+)/).map((word, index) => /^\s+$/.test(word) ? word : <span className="caption-word" style={{ "--word-delay": `${(index % 5) * 45}ms` } as React.CSSProperties} key={index}>{word}</span>)}
            </p>
          ) : (
            <p className="caption-placeholder">{phase === "idle" ? "ابدأ التجربة، واتكلم كأنك عند بوابة المستشفى." : phase === "connecting" ? "بنجهز الاتصال الصوتي…" : "سامعاك، اتفضل."}</p>
          )}
        </div>
        {physicalDoor && <div className="notice simulation-notice">
          <label className="field" htmlFor="device-token">توكن جهاز الاستقبال
            <input id="device-token" type="password" autoComplete="off" value={deviceToken}
              disabled={phase !== "idle" && phase !== "error"} onChange={(event) => setDeviceToken(event.target.value)} />
          </label>
          <p>أدخل نفس توكن ESP32. يظل في ذاكرة الصفحة فقط. هذه الجلسة يمكنها إصدار أمر للباب الفعلي.</p>
        </div>}
        {!configured && <div className="notice simulation-notice">مفتاح خدمة الصوت غير مُعدّ على الخادم.</div>}
        {error && <p className="simulation-error" role="alert">{error}</p>}
        <footer className="simulation-controls">
          {phase === "idle" || phase === "error" ? <button className="button simulation-start" type="button" disabled={!configured || (physicalDoor && !deviceToken.trim())} onClick={() => void start()}><Mic aria-hidden="true" />{physicalDoor ? "ابدأ الاستقبال" : "ابدأ المحاكاة"}</button> : <button className="button simulation-stop" type="button" disabled={phase === "closing"} onClick={() => void stop()}><CircleStop aria-hidden="true" />إنهاء الجلسة</button>}
        </footer>
      </div>
      <aside className="simulation-side-panel">
        <div className="wave-card">
          <div className="wave-card-heading"><span>موجة الصوت</span><small>{phase === "speaking" ? "صوت ROMI" : phase === "listening" ? "صوتك" : "جاهزة"}</small></div>
          <CircularWaveform analyzers={audioAnalyzers} phase={phase} />
          <p className="wave-card-caption">{phaseLabels[phase]}</p>
        </div>
        <div className="simulation-log">
          <div className="simulation-log-head"><span>آخر الأحداث</span></div>
          {items.length === 0 ? <div className="simulation-log-empty">هيظهر هنا آخر إجراء في المحادثة.</div> : items.map((item) => <div className={`simulation-log-item ${item.kind}`} key={item.id}><span className="simulation-log-mark">{item.kind === "tool" ? <Sparkles /> : item.kind === "success" ? <DoorOpen /> : item.kind === "error" ? <ShieldCheck /> : <Radio />}</span><span><strong>{item.label}</strong></span></div>)}
        </div>
      </aside>
    </section>
  );
}

function CircularWaveform({ analyzers, phase }: { analyzers: AudioAnalyzers; phase: Phase }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const drawing = canvas?.getContext("2d");
    if (!canvas || !drawing) return;

    const microphoneBins = analyzers ? new Uint8Array(analyzers.microphone.frequencyBinCount) : null;
    const romiBins = analyzers ? new Uint8Array(analyzers.romi.frequencyBinCount) : null;
    let frame = 0;

    const draw = () => {
      const romiSpeaking = phase === "speaking";
      paintWaveformFrame({ canvas, drawing, bins: romiSpeaking ? romiBins : microphoneBins, analyser: romiSpeaking ? analyzers?.romi : analyzers?.microphone, romiSpeaking });
      if (analyzers) frame = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(frame);
  }, [analyzers, phase]);

  return (
    <div className={`voice-visual ${phase === "speaking" ? "responding" : ""}`}>
      <div className="voice-orbit orbit-one" />
      <div className="voice-orbit orbit-two" />
      <canvas ref={canvasRef} aria-hidden="true" />
      <div className="voice-core"><AudioLines aria-hidden="true" /><span>{phase === "listening" ? "سامعاك" : phase === "speaking" ? "بترد" : phase === "checking" ? "بتتحقق" : "ROMI"}</span></div>
    </div>
  );
}

function paintWaveformFrame({ canvas, drawing, analyser, bins, romiSpeaking }: WaveformFrame) {
  const bounds = canvas.getBoundingClientRect();
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.round(bounds.width * pixelRatio);
  const height = Math.round(bounds.height * pixelRatio);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  drawing.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  drawing.clearRect(0, 0, bounds.width, bounds.height);
  if (bins && analyser) analyser.getByteFrequencyData(bins);
  const centerX = bounds.width / 2;
  const centerY = bounds.height / 2;
  const radius = Math.min(bounds.width, bounds.height) * 0.34;
  drawBackgroundRing(drawing, centerX, centerY, radius);
  drawRadialSpectrum({ drawing, centerX, centerY, radius, bins, color: romiSpeaking ? "rgba(225, 132, 103, .88)" : "rgba(27, 151, 128, .82)" });
}

function drawBackgroundRing(drawing: CanvasRenderingContext2D, centerX: number, centerY: number, radius: number) {
  drawing.beginPath();
  drawing.arc(centerX, centerY, radius - 6, 0, Math.PI * 2);
  drawing.strokeStyle = "rgba(86, 137, 136, .16)";
  drawing.lineWidth = 1;
  drawing.stroke();
}

function drawRadialSpectrum({ drawing, centerX, centerY, radius, bins, color }: SpectrumDrawing) {
  const barCount = 112;
  for (let index = 0; index < barCount; index++) {
    const angle = (index / barCount) * Math.PI * 2 - Math.PI / 2;
    const binIndex = Math.floor(Math.pow(index / (barCount - 1), 1.65) * ((bins?.length ?? 128) - 1));
    const energy = bins ? bins[binIndex] / 255 : 0;
    const innerRadius = radius + 3;
    const outerRadius = innerRadius + 3 + energy * radius * 0.6;
    drawing.beginPath();
    drawing.moveTo(centerX + Math.cos(angle) * innerRadius, centerY + Math.sin(angle) * innerRadius);
    drawing.lineTo(centerX + Math.cos(angle) * outerRadius, centerY + Math.sin(angle) * outerRadius);
    drawing.strokeStyle = color;
    drawing.lineWidth = 2.4;
    drawing.lineCap = "round";
    drawing.stroke();
  }
}
