import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedDevice } from "@/lib/auth/device";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

export async function GET(request: NextRequest) {
  if (!isAuthorizedDevice(request)) return NextResponse.json({ error: "غير مصرح." }, { status: 401 });

  const supabase = createSupabaseServiceClient();
  const { data, error } = await supabase.rpc("claim_next_door_command");
  if (error) return NextResponse.json({ error: "تعذّر قراءة أوامر الباب." }, { status: 500 });

  const [command] = data ?? [];
  return NextResponse.json({
    command: command ? { id: command.id, expires_at: command.expires_at } : null,
    retry_after_ms: 1500,
  });
}
