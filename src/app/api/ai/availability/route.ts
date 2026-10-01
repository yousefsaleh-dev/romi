import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSupabase } from "@/lib/auth/admin";
import { isAuthorizedDevice } from "@/lib/auth/device";
import { getAppointmentEntryWindow } from "@/lib/time/entry-window";
import { cairoDateRangeToUtc } from "@/lib/time/cairo";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

const availabilityRequest = z.object({
  request_id: z.string().uuid(),
  department_slug: z.enum(["general", "internal_medicine", "pediatrics", "orthopedics"]),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function POST(request: NextRequest) {
  const device = isAuthorizedDevice(request);
  const admin = device ? null : await getAdminSupabase();
  if (!device && !admin) return NextResponse.json({ error: "غير مصرح." }, { status: 401 });

  const parsed = availabilityRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "حدد القسم والفترة المطلوبة." }, { status: 400 });
  const range = cairoDateRangeToUtc(parsed.data.date_from, parsed.data.date_to);
  if (!range) return NextResponse.json({ error: "الفترة أو التاريخ غير صحيح." }, { status: 400 });
  if (Date.parse(range.endsAt) - Date.parse(range.startsAt) > 32 * 24 * 60 * 60_000) {
    return NextResponse.json({ error: "اختار فترة لا تتجاوز ٣١ يومًا." }, { status: 400 });
  }

  const supabase = createSupabaseServiceClient();
  const source = device ? "kiosk" : "simulation";
  const { data: action, error: actionError } = await supabase.from("ai_actions")
    .select("id, source, outcome").eq("request_id", parsed.data.request_id).maybeSingle();
  if (actionError) return NextResponse.json({ error: "تعذّر التحقق من جلسة ROMI." }, { status: 500 });
  if (!action || action.source !== source || action.outcome !== "in_progress") {
    return NextResponse.json({ error: "جلسة ROMI غير متاحة للبحث عن موعد." }, { status: 409 });
  }

  const { data: slots, error } = await supabase.rpc("find_available_appointment_slots", {
    department_slug_input: parsed.data.department_slug,
    starts_at_input: range.startsAt,
    ends_at_input: range.endsAt,
  });
  if (error) return NextResponse.json({ error: "تعذّر البحث عن المواعيد." }, { status: 500 });
  const checkedAt = Date.now();
  const enrichedSlots = ((slots ?? []) as {
    department_slug: string;
    department_name: string;
    starts_at: string;
    duration_minutes: number;
    remaining_capacity: number;
  }[]).map((slot) => {
    const entryWindow = getAppointmentEntryWindow(slot.starts_at, checkedAt);
    return {
      ...slot,
      can_enter_now: entryWindow.canEnterNow,
      entry_window_opens_at: entryWindow.opensAt,
      entry_window_closes_at: entryWindow.closesAt,
      checked_at: new Date(checkedAt).toISOString(),
    };
  });
  return NextResponse.json({ slots: enrichedSlots });
}
