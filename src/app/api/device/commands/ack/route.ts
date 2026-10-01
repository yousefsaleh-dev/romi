import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorizedDevice } from "@/lib/auth/device";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

const acknowledgement = z.object({
  command_id: z.string().uuid(),
  opened: z.boolean(),
  error_code: z.string().max(80).optional(),
});

export async function POST(request: NextRequest) {
  if (!isAuthorizedDevice(request)) return NextResponse.json({ error: "غير مصرح." }, { status: 401 });

  const parsedBody = acknowledgement.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) return NextResponse.json({ error: "تأكيد الباب غير صحيح." }, { status: 400 });

  const supabase = createSupabaseServiceClient();
  const { data, error } = await supabase.rpc("acknowledge_door_command", {
    command_id: parsedBody.data.command_id,
    opened: parsedBody.data.opened,
    failure_code: parsedBody.data.error_code ?? null,
  });

  if (error) return NextResponse.json({ error: "تعذّر حفظ تأكيد الباب." }, { status: 500 });
  if (!data?.id) return NextResponse.json({ error: "الأمر منتهي أو تم تأكيده من قبل." }, { status: 409 });
  return NextResponse.json({ command: data });
}
