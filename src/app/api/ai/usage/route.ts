import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSupabase } from "@/lib/auth/admin";
import { isAuthorizedDevice } from "@/lib/auth/device";
import { estimateLiveCostUsd } from "@/lib/ai/live";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

const usageSchema = z.object({
  request_id: z.string().uuid(),
  text_input_tokens: z.number().int().nonnegative().max(2_000_000),
  text_output_tokens: z.number().int().nonnegative().max(2_000_000),
  audio_input_tokens: z.number().int().nonnegative().max(2_000_000),
  audio_output_tokens: z.number().int().nonnegative().max(2_000_000),
  latency_ms: z.number().int().nonnegative().max(900_000).nullable(),
  outcome: z.enum(["missing_code", "provider_error", "completed"]).optional(),
});

export async function POST(request: NextRequest) {
  const device = isAuthorizedDevice(request);
  const admin = device ? null : await getAdminSupabase();
  if (!device && !admin) return NextResponse.json({ error: "غير مصرح." }, { status: 401 });
  const parsed = usageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "بيانات الاستخدام غير صحيحة." }, { status: 400 });
  const supabase = createSupabaseServiceClient();
  const { data: action } = await supabase.from("ai_actions").select("id, source, outcome, usage_finalized").eq("request_id", parsed.data.request_id).maybeSingle();
  if (!action || action.source !== (device ? "kiosk" : "simulation")) return NextResponse.json({ error: "الجلسة غير موجودة." }, { status: 404 });
  if (action.usage_finalized) return NextResponse.json({ saved: true, duplicate: true });
  const { outcome } = parsed.data;
  const usage = {
    text_input_tokens: parsed.data.text_input_tokens,
    text_output_tokens: parsed.data.text_output_tokens,
    audio_input_tokens: parsed.data.audio_input_tokens,
    audio_output_tokens: parsed.data.audio_output_tokens,
    latency_ms: parsed.data.latency_ms,
  };
  const estimated_cost_usd = estimateLiveCostUsd({ textInput: usage.text_input_tokens, textOutput: usage.text_output_tokens, audioInput: usage.audio_input_tokens, audioOutput: usage.audio_output_tokens });
  const update = { ...usage, estimated_cost_usd, usage_finalized: true, ...(action.outcome === "in_progress" && outcome ? { outcome } : {}) };
  const { error } = await supabase.from("ai_actions").update(update).eq("id", action.id).eq("usage_finalized", false);
  if (error) return NextResponse.json({ error: "تعذّر حفظ الاستهلاك." }, { status: 500 });
  return NextResponse.json({ saved: true, estimated_cost_usd });
}
