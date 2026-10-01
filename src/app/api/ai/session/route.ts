import { GoogleGenAI } from "@google/genai";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSupabase } from "@/lib/auth/admin";
import { isAuthorizedDevice } from "@/lib/auth/device";
import { liveConfig, liveModel } from "@/lib/ai/live";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

const requestSchema = z.object({ request_id: z.string().uuid() });

export async function POST(request: NextRequest) {
  const device = isAuthorizedDevice(request);
  const admin = device ? null : await getAdminSupabase();
  if (!device && !admin) return NextResponse.json({ error: "غير مصرح." }, { status: 401 });
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "معرّف الجلسة غير صحيح." }, { status: 400 });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "أضف GEMINI_API_KEY إلى .env.local لتشغيل الاتصال الصوتي." }, { status: 503 });

  const supabase = createSupabaseServiceClient();
  const source = device ? "kiosk" : "simulation";
  const { data: prior } = await supabase.from("ai_actions").select("id, source, outcome").eq("request_id", parsed.data.request_id).maybeSingle();
  if (prior) return NextResponse.json({ error: "معرّف الجلسة مستخدم بالفعل." }, { status: 409 });
  const billingTier = process.env.GEMINI_BILLING_TIER === "free" ? "free" : process.env.GEMINI_BILLING_TIER === "paid" ? "paid" : "unknown";
  const { error: insertError } = await supabase.from("ai_actions").insert({ request_id: parsed.data.request_id, outcome: "in_progress", source, model: liveModel, billing_tier: billingTier });
  if (insertError) return NextResponse.json({ error: "تعذّر تسجيل جلسة الذكاء الاصطناعي." }, { status: 500 });

  const requestTime = new Date();
  const currentCairoTime = new Intl.DateTimeFormat("ar-EG", {
    timeZone: "Africa/Cairo", dateStyle: "full", timeStyle: "short", hour12: true,
  }).format(requestTime);
  const cairoParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(requestTime).map(({ type, value }) => [type, value]));
  const currentCairoIso = `${cairoParts.year}-${cairoParts.month}-${cairoParts.day}T${cairoParts.hour}:${cairoParts.minute}:${cairoParts.second}`;
  const config = {
    ...liveConfig,
    systemInstruction: `${liveConfig.systemInstruction}\n\nتاريخ ووقت الخادم الحالي في مصر (Africa/Cairo): ${currentCairoTime}؛ وبصيغة محلية دقيقة: ${currentCairoIso} Africa/Cairo. استخدمي هذا السياق لفهم النهارده وبكرة والفترات التي يطلبها الزائر. لا تعتمدي على تقديرك أو موافقة الزائر لتحديد الدخول: نتيجة can_enter_now والسبب ووقت الفحص ونافذة الدخول التي يرجعها الخادم هي المرجع.`,
  };

  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1beta" } });
    const now = Date.now();
    const token = await ai.authTokens.create({ config: {
      uses: 1,
      expireTime: new Date(now + 15 * 60_000).toISOString(),
      newSessionExpireTime: new Date(now + 60_000).toISOString(),
      liveConnectConstraints: { model: liveModel, config },
    } });
    if (!token.name) throw new Error("Missing ephemeral token");
    return NextResponse.json({ token: token.name, model: liveModel, request_id: parsed.data.request_id, config });
  } catch {
    await supabase.from("ai_actions").update({ outcome: "provider_error", reply_text: "تعذّر بدء جلسة الصوت." }).eq("request_id", parsed.data.request_id);
    return NextResponse.json({ error: "تعذّر بدء جلسة الصوت مع Gemini Live." }, { status: 502 });
  }
}
