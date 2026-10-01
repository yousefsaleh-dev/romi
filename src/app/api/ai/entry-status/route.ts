import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSupabase } from "@/lib/auth/admin";
import { isAuthorizedDevice } from "@/lib/auth/device";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { describeEntryStatus, getAppointmentEntryWindow } from "@/lib/time/entry-window";

const input = z.object({ request_id: z.string().uuid(), appointment_id: z.string().uuid() });

export async function POST(request: NextRequest) {
  const device = isAuthorizedDevice(request);
  const admin = device ? null : await getAdminSupabase();
  if (!device && !admin) return NextResponse.json({ error: "غير مصرح." }, { status: 401 });
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "بيانات الحجز غير صحيحة." }, { status: 400 });

  const service = createSupabaseServiceClient();
  const source = device ? "kiosk" : "simulation";
  const { data: action, error: actionError } = await service.from("ai_actions")
    .select("id, source").eq("request_id", parsed.data.request_id).maybeSingle();
  if (actionError) return NextResponse.json({ error: "تعذّر التحقق من الجلسة." }, { status: 500 });
  if (!action || action.source !== source) return NextResponse.json({ error: "جلسة ROMI غير موجودة." }, { status: 404 });

  const { data: booking, error } = await service.from("appointments")
    .select("id, appointment_at, status")
    .eq("id", parsed.data.appointment_id).eq("creation_action_id", action.id).maybeSingle();
  if (error) return NextResponse.json({ error: "تعذّر فحص موعد الدخول." }, { status: 500 });
  if (!booking) return NextResponse.json({ error: "الحجز غير موجود في هذه الجلسة." }, { status: 404 });

  const checkedAt = Date.now();
  const window = getAppointmentEntryWindow(booking.appointment_at, checkedAt);
  const canEnterNow = booking.status === "scheduled" && window.canEnterNow;
  return NextResponse.json({
    appointment_id: booking.id,
    status: booking.status,
    appointment_at: booking.appointment_at,
    can_enter_now: canEnterNow,
    reason: canEnterNow ? "valid" : booking.status === "scheduled" ? window.reason : booking.status,
    checked_at: new Date(checkedAt).toISOString(),
    entry_window_opens_at: window.opensAt,
    entry_window_closes_at: window.closesAt,
    entry_message_ar: describeEntryStatus(booking.appointment_at, checkedAt, booking.status),
  });
}
