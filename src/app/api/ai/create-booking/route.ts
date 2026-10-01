import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSupabase } from "@/lib/auth/admin";
import { isAuthorizedDevice } from "@/lib/auth/device";
import { describeEntryStatus, getAppointmentEntryWindow } from "@/lib/time/entry-window";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

const createBookingRequest = z.object({
  request_id: z.string().uuid(),
  patient_name: z.string().trim().min(2).max(120),
  department_slug: z.enum(["general", "internal_medicine", "pediatrics", "orthopedics"]),
  appointment_at: z.string().datetime({ offset: true }),
  open_door_now: z.boolean().default(false),
});

export async function POST(request: NextRequest) {
  const device = isAuthorizedDevice(request);
  const admin = device ? null : await getAdminSupabase();
  if (!device && !admin) return NextResponse.json({ error: "غير مصرح." }, { status: 401 });

  const parsed = createBookingRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "بيانات الحجز ناقصة أو غير صحيحة." }, { status: 400 });
  const supabase = createSupabaseServiceClient();
  const source = device ? "kiosk" : "simulation";
  const { data: action, error: actionError } = await supabase.from("ai_actions")
    .select("id, source, outcome").eq("request_id", parsed.data.request_id).maybeSingle();
  if (actionError) return NextResponse.json({ error: "تعذّر التحقق من جلسة ROMI." }, { status: 500 });
  if (!action || action.source !== source) return NextResponse.json({ error: "جلسة ROMI غير موجودة." }, { status: 404 });

  const checkedAt = Date.now();
  const entryWindow = getAppointmentEntryWindow(parsed.data.appointment_at, checkedAt);
  const openDoorNow = parsed.data.open_door_now && entryWindow.canEnterNow;
  const { data: booking, error } = await supabase.rpc("create_ai_booking", {
    action_uuid: action.id,
    department_slug_input: parsed.data.department_slug,
    appointment_at_input: parsed.data.appointment_at,
    patient_name_input: parsed.data.patient_name,
    open_door_now_input: openDoorNow,
  });
  if (error) return NextResponse.json({ error: "تعذّر إنشاء الحجز." }, { status: 500 });
  if (!booking?.ok) return NextResponse.json({ booking }, { status: 409 });
  const databaseDeniedReason = booking.door_open_skipped_reason;
  const canEnterNow = entryWindow.canEnterNow && databaseDeniedReason !== "too_early" && databaseDeniedReason !== "expired";
  return NextResponse.json({ booking: {
    ...booking,
    can_enter_now: canEnterNow,
    checked_at: new Date(checkedAt).toISOString(),
    entry_window_opens_at: entryWindow.opensAt,
    entry_window_closes_at: entryWindow.closesAt,
    door_open_skipped_reason: entryWindow.canEnterNow ? databaseDeniedReason : entryWindow.reason,
    entry_message_ar: describeEntryStatus(parsed.data.appointment_at, checkedAt, booking.door_command_id ? "entry_pending" : "scheduled"),
  } });
}
