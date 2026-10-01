import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSupabase } from "@/lib/auth/admin";
import { isAuthorizedDevice } from "@/lib/auth/device";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

const requestIdSchema = z.string().uuid();

export async function GET(request: NextRequest) {
  const device = isAuthorizedDevice(request);
  const admin = device ? null : await getAdminSupabase();
  if (!device && !admin) return NextResponse.json({ error: "غير مصرح." }, { status: 401 });

  const requestId = requestIdSchema.safeParse(request.nextUrl.searchParams.get("request_id"));
  if (!requestId.success) return NextResponse.json({ error: "معرّف الجلسة غير صحيح." }, { status: 400 });
  const supabase = createSupabaseServiceClient();
  const source = device ? "kiosk" : "simulation";
  const { data: action, error: actionError } = await supabase.from("ai_actions")
    .select("id, source").eq("request_id", requestId.data).maybeSingle();
  if (actionError) return NextResponse.json({ error: "تعذّر قراءة حالة الجلسة." }, { status: 500 });
  if (!action || action.source !== source) return NextResponse.json({ error: "جلسة ROMI غير موجودة." }, { status: 404 });

  const { data: command, error } = await supabase.from("door_commands")
    .select("status, simulated, opened_at, error_code")
    .eq("ai_action_id", action.id).maybeSingle();
  if (error) return NextResponse.json({ error: "تعذّر قراءة حالة الباب." }, { status: 500 });
  return NextResponse.json({ command: command ?? null });
}
