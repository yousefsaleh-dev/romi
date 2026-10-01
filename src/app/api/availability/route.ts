import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSupabase } from "@/lib/auth/admin";
import { cairoDateRangeToUtc } from "@/lib/time/cairo";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

const departmentSchema = z.enum(["general", "internal_medicine", "pediatrics", "orthopedics"]);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function GET(request: NextRequest) {
  const admin = await getAdminSupabase();
  if (!admin) return NextResponse.json({ error: "غير مصرح." }, { status: 401 });

  const params = request.nextUrl.searchParams;
  const department = departmentSchema.safeParse(params.get("department_slug"));
  const dateFrom = dateSchema.safeParse(params.get("date_from"));
  const dateTo = dateSchema.safeParse(params.get("date_to"));
  const service = createSupabaseServiceClient();
  const [{ data: departments, error: departmentError }, { error: expiryError }] = await Promise.all([
    admin.supabase.from("departments").select("slug, name").eq("active", true).order("name"),
    service.rpc("expire_old_appointments"),
  ]);
  if (departmentError || expiryError) return NextResponse.json({ error: "تعذّر تحميل الأقسام والحجوزات." }, { status: 500 });

  const anyDateFilter = params.has("date_from") || params.has("date_to") || params.has("department_slug");
  if (!anyDateFilter) return NextResponse.json({ departments: departments ?? [], slots: [] });
  if (!department.success || !dateFrom.success || !dateTo.success) {
    return NextResponse.json({ error: "حدد القسم واليوم أو الفترة المطلوبة." }, { status: 400 });
  }
  const range = cairoDateRangeToUtc(dateFrom.data, dateTo.data);
  if (!range || Date.parse(range.endsAt) - Date.parse(range.startsAt) > 32 * 24 * 60 * 60_000) {
    return NextResponse.json({ error: "الفترة غير صحيحة؛ الحد الأقصى ٣١ يومًا." }, { status: 400 });
  }
  const { data: slots, error } = await service.rpc("find_available_appointment_slots", {
    department_slug_input: department.data,
    starts_at_input: range.startsAt,
    ends_at_input: range.endsAt,
  });
  if (error) return NextResponse.json({ error: "تعذّر تحميل الفترات المتاحة." }, { status: 500 });
  return NextResponse.json({ departments: departments ?? [], slots: slots ?? [] });
}

export async function POST() {
  return NextResponse.json({ error: "الفترات تتولد تلقائيًا كل نصف ساعة على مدار ٢٤ ساعة." }, { status: 405 });
}
