import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminSupabase } from "@/lib/auth/admin";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

const schema = z.object({ command_id: z.string().uuid() });

export async function POST(request: Request) {
  if (!await getAdminSupabase()) return NextResponse.json({ error: "غير مصرح." }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "أمر المحاكاة غير صحيح." }, { status: 400 });
  const supabase = createSupabaseServiceClient();
  const { data: existing, error: lookupError } = await supabase.from("door_commands")
    .select("id, status, opened_at, simulated").eq("id", parsed.data.command_id).eq("simulated", true).maybeSingle();
  if (lookupError) return NextResponse.json({ error: "تعذّر فحص أمر المحاكاة." }, { status: 500 });
  if (existing?.status === "opened") return NextResponse.json({ command: existing, duplicate: true });
  const { data, error } = await supabase.rpc("complete_simulation_door_command", { command_id: parsed.data.command_id });
  if (error) return NextResponse.json({ error: "تعذّر تسجيل حدث المحاكاة." }, { status: 500 });
  if (!data?.id) return NextResponse.json({ error: "أمر المحاكاة غير موجود أو نُفذ سابقًا." }, { status: 409 });
  return NextResponse.json({ command: data });
}
