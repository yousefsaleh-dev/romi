import { NextResponse, type NextRequest } from "next/server";
import { getAdminSupabase } from "@/lib/auth/admin";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { z } from "zod";

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const admin = await getAdminSupabase();
  if (!admin) return NextResponse.json({ error: "غير مصرح." }, { status: 401 });

  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "معرّف الحجز غير صحيح." }, { status: 400 });
  const service = createSupabaseServiceClient();
  const { error: commandError } = await service.from("door_commands")
    .update({ status: "failed", acknowledged_at: new Date().toISOString(), error_code: "booking_deleted" })
    .eq("appointment_id", id).in("status", ["pending", "sent"]);
  if (commandError) return NextResponse.json({ error: "تعذّر إلغاء أمر الباب المرتبط بالحجز." }, { status: 500 });

  const { count, error } = await service.from("appointments")
    .delete({ count: "exact" }).eq("id", id);
  if (error) return NextResponse.json({ error: "تعذّر حذف الحجز نهائيًا." }, { status: 500 });
  if (!count) return NextResponse.json({ error: "الحجز غير موجود." }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
