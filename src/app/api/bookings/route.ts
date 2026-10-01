import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSupabase } from "@/lib/auth/admin";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

const bookingInput = z.object({
  booking_code: z.string().regex(/^\d{4}$/, "اكتب كودًا من ٤ أرقام."),
  patient_name: z.string().trim().min(2, "اكتب اسم صاحب الحجز.").max(120),
  department_slug: z.enum(["general", "internal_medicine", "pediatrics", "orthopedics"]),
  appointment_at: z.string().datetime({ offset: true }),
});

export async function GET(request: NextRequest) {
  const admin = await getAdminSupabase();
  if (!admin) return NextResponse.json({ error: "غير مصرح." }, { status: 401 });

  const page = z.coerce.number().int().min(0).safeParse(request.nextUrl.searchParams.get("page") ?? "0");
  if (!page.success) return NextResponse.json({ error: "رقم الصفحة غير صحيح." }, { status: 400 });
  const pageSize = 100;

  const service = createSupabaseServiceClient();
  const { error: expiryError } = await service.rpc("expire_old_appointments");
  if (expiryError) return NextResponse.json({ error: "تعذّر تحديث حالات الحجوزات." }, { status: 500 });

  const [{ data, error, count }, { data: departments, error: departmentError }] = await Promise.all([
    admin.supabase.from("appointments")
      .select("id, booking_code, patient_name, department_slug, appointment_at, status, created_at", { count: "exact" })
      .order("appointment_at", { ascending: false }).order("id", { ascending: false })
      .range(page.data * pageSize, (page.data + 1) * pageSize - 1),
    admin.supabase.from("departments").select("slug, name"),
  ]);
  if (error || departmentError) return NextResponse.json({ error: "تعذّر تحميل الحجوزات." }, { status: 500 });
  const departmentNames = new Map((departments ?? []).map((department) => [department.slug, department.name]));
  const bookings = (data ?? []).map((booking) => ({
    ...booking,
    department_name: booking.department_slug ? departmentNames.get(booking.department_slug) ?? null : null,
  }));
  return NextResponse.json({ bookings, total: count ?? 0, has_more: (page.data + 1) * pageSize < (count ?? 0) });
}

export async function POST(request: NextRequest) {
  const admin = await getAdminSupabase();
  if (!admin) return NextResponse.json({ error: "غير مصرح." }, { status: 401 });

  const parsedBody = bookingInput.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json({ error: parsedBody.error.issues[0]?.message ?? "بيانات الحجز غير صحيحة." }, { status: 400 });
  }

  const service = createSupabaseServiceClient();
  const { data: booking, error } = await service.rpc("create_admin_booking", {
    booking_code_input: parsedBody.data.booking_code,
    patient_name_input: parsedBody.data.patient_name,
    department_slug_input: parsedBody.data.department_slug,
    appointment_at_input: parsedBody.data.appointment_at,
  });
  if (error) return NextResponse.json({ error: "تعذّر حفظ الحجز." }, { status: 500 });
  if (!booking?.ok) {
    const messages: Record<string, string> = {
      slot_unavailable: "الموعد اتقفل أو مش موجود.",
      slot_in_past: "لا يمكن تسجيل حجز في موعد بدأ بالفعل.",
      slot_full: "الفترة اتحجزت للتو في القسم؛ اختار وقتًا تاني.",
      code_in_use: "الكود مستخدم في حجز نشط. اختَر كودًا آخر.",
    };
    return NextResponse.json({ error: messages[booking?.reason] ?? "تعذّر إنشاء الحجز." }, { status: 409 });
  }
  return NextResponse.json({ booking }, { status: 201 });
}
