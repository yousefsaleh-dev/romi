import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSupabase } from "@/lib/auth/admin";
import { isAuthorizedDevice } from "@/lib/auth/device";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

const checkInRequest = z.object({ request_id: z.string().uuid(), booking_code: z.string().min(4).max(8) });

function normalizeBookingCode(code: string) {
  return code
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x6f0));
}

export async function POST(request: NextRequest) {
  const device = isAuthorizedDevice(request);
  const admin = device ? null : await getAdminSupabase();
  if (!device && !admin) return NextResponse.json({ error: "غير مصرح." }, { status: 401 });

  const parsed = checkInRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "أحتاج كود حجز مكوّنًا من أربعة أرقام." }, { status: 400 });
  const bookingCode = normalizeBookingCode(parsed.data.booking_code);
  if (!/^\d{4}$/.test(bookingCode)) return NextResponse.json({ error: "أحتاج كود حجز مكوّنًا من أربعة أرقام." }, { status: 400 });

  const supabase = createSupabaseServiceClient();
  const source = device ? "kiosk" : "simulation";
  const { data: action, error: actionError } = await supabase.from("ai_actions")
    .select("id, source, outcome").eq("request_id", parsed.data.request_id).maybeSingle();
  if (actionError) return NextResponse.json({ error: "تعذّر التحقق من جلسة ROMI." }, { status: 500 });
  if (!action || action.source !== source) return NextResponse.json({ error: "جلسة ROMI غير موجودة." }, { status: 404 });

  const { data: attempt, error } = await supabase.rpc("attempt_booking_checkin", {
    action_uuid: action.id,
    code: bookingCode,
  });
  if (error) return NextResponse.json({ error: "تعذّر فحص الحجز." }, { status: 500 });
  return NextResponse.json({ attempt });
}
