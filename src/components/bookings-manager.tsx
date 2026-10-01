"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, Copy, LoaderCircle, Plus, Trash2 } from "lucide-react";

type Booking = {
  id: string;
  booking_code: string;
  patient_name: string | null;
  department_slug: string | null;
  department_name: string | null;
  appointment_at: string;
  status: "scheduled" | "entry_pending" | "checked_in" | "cancelled" | "expired";
};
type Department = { slug: string; name: string };
type Slot = { starts_at: string; duration_minutes: 30; remaining_capacity: 1 };

const statusLabels: Record<Booking["status"], string> = {
  scheduled: "بانتظار الوصول",
  entry_pending: "الباب قيد الفتح",
  checked_in: "تم تسجيل الوصول",
  cancelled: "ملغي",
  expired: "انتهت صلاحيته",
};

function cairoDate(value: string) {
  return new Intl.DateTimeFormat("ar-EG", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function todayInCairo() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function BookingsManager() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [departmentSlug, setDepartmentSlug] = useState("");
  const [selectedDate, setSelectedDate] = useState(todayInCairo);
  const [selectedStart, setSelectedStart] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [bookingPage, setBookingPage] = useState(0);
  const [hasMoreBookings, setHasMoreBookings] = useState(false);
  const [bookingTotal, setBookingTotal] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");

  const loadBookings = useCallback(async (page = 0) => {
    const response = await fetch(`/api/bookings?page=${page}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "تعذّر تحميل الحجوزات.");
    const nextBookings = payload.bookings as Booking[];
    setBookings((current) => page === 0 ? nextBookings : [...current, ...nextBookings.filter((booking) => !current.some((existing) => existing.id === booking.id))]);
    setBookingPage(page);
    setHasMoreBookings(payload.has_more === true);
    setBookingTotal(payload.total as number);
  }, []);

  const loadAvailability = useCallback(async () => {
    if (!departmentSlug || !selectedDate) return;
    const query = new URLSearchParams({ department_slug: departmentSlug, date_from: selectedDate, date_to: selectedDate });
    const response = await fetch(`/api/availability?${query}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "تعذّر تحميل الفترات المتاحة.");
    setDepartments(payload.departments as Department[]);
    const available = payload.slots as Slot[];
    setSlots(available);
    setSelectedStart(available[0]?.starts_at ?? "");
  }, [departmentSlug, selectedDate]);

  useEffect(() => {
    // Load server-owned records after mount; the state updates happen after the fetch resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadBookings().catch((error: Error) => setMessage(error.message)).finally(() => setIsLoading(false));
  }, [loadBookings]);

  useEffect(() => {
    // Fetch the times that remain free for the selected department and Cairo date.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAvailability().catch((error: Error) => setMessage(error.message));
  }, [loadAvailability]);

  useEffect(() => {
    fetch("/api/availability", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "تعذّر تحميل الأقسام.");
      const nextDepartments = payload.departments as Department[];
      setDepartments(nextDepartments);
      setDepartmentSlug((current) => current || nextDepartments[0]?.slug || "");
    }).catch((error: Error) => setMessage(error.message));
  }, []);

  async function addBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setIsSaving(true);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const response = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patient_name: String(form.get("patient_name")),
          booking_code: String(form.get("booking_code")),
          department_slug: String(form.get("department_slug")),
          appointment_at: String(form.get("appointment_at")),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "تعذّر إنشاء الحجز.");
      formElement.reset();
      setMessage("تم تسجيل الحجز لمدة نصف ساعة.");
      await loadBookings();
      await loadAvailability();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذّر إنشاء الحجز.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteBooking(booking: Booking) {
    if (!window.confirm(`حذف الحجز ${booking.booking_code} نهائيًا؟ لا يمكن التراجع عن الحذف.`)) return;
    setMessage("");
    try {
      const response = await fetch(`/api/bookings/${booking.id}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "تعذّر حذف الحجز نهائيًا.");
      setMessage("تم حذف الحجز نهائيًا.");
      await loadBookings();
      await loadAvailability();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذّر حذف الحجز نهائيًا.");
    }
  }

  async function loadMoreBookings() {
    setIsLoadingMore(true);
    try {
      await loadBookings(bookingPage + 1);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذّر تحميل المزيد من الحجوزات.");
    } finally {
      setIsLoadingMore(false);
    }
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setMessage(`اتنسخ كود الحجز ${code}.`);
    } catch {
      setMessage("ماقدرتش أنسخ الكود من المتصفح.");
    }
  }

  return (
    <div>
      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head"><span className="panel-title">إضافة حجز يدوي</span><span className="panel-meta">الدخول: ساعة قبل الموعد إلى ساعتين بعده</span></div>
        <form className="form-grid" onSubmit={addBooking}>
          <label className="field" htmlFor="booking-patient-name">اسم صاحب الحجز
            <input id="booking-patient-name" name="patient_name" minLength={2} maxLength={120} autoComplete="name" required />
          </label>
          <label className="field" htmlFor="booking-code">كود الحجز
            <input id="booking-code" name="booking_code" inputMode="numeric" pattern="[0-9]{4}" minLength={4} maxLength={4} placeholder="مثال: 4821" required />
          </label>
          <label className="field" htmlFor="booking-department">القسم
            <select id="booking-department" name="department_slug" value={departmentSlug} onChange={(event) => setDepartmentSlug(event.target.value)} required>
              {departments.map((department) => <option key={department.slug} value={department.slug}>{department.name}</option>)}
            </select>
          </label>
          <label className="field" htmlFor="booking-date">اليوم · بتوقيت القاهرة
            <input id="booking-date" type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} required />
          </label>
          <label className="field" htmlFor="booking-start">موعد متاح · مدة الحجز ٣٠ دقيقة
            <select id="booking-start" name="appointment_at" value={selectedStart} onChange={(event) => setSelectedStart(event.target.value)} required disabled={slots.length === 0}>
              {slots.length === 0 && <option value="">مفيش فترات فاضية في اليوم ده</option>}
              {slots.map((slot) => <option key={slot.starts_at} value={slot.starts_at}>{cairoDate(slot.starts_at)}</option>)}
            </select>
          </label>
          <button className="button" type="submit" disabled={isSaving || slots.length === 0}><Plus aria-hidden="true" />{isSaving ? "جاري الحفظ" : "إضافة الحجز"}</button>
        </form>
        <p className="page-description" style={{ padding: "0 19px 16px" }}>المستشفى متاحة ٢٤ ساعة. المواعيد تتولد تلقائيًا كل نصف ساعة، ولكل قسم حجز واحد في الفترة؛ الاسم للتسجيل فقط والكود والوقت للتحقق.</p>
      </section>
      {message && <div className="notice" role="status">{message}</div>}
      <section className="panel">
        <div className="panel-head"><span className="panel-title">الحجوزات</span><span className="panel-meta">{bookingTotal} حجز</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>صاحب الحجز</th><th>الكود</th><th>القسم</th><th>الموعد</th><th>الحالة</th><th>الإجراءات</th></tr></thead>
            <tbody>
              {bookings.map((booking) => (
                <tr key={booking.id}>
                  <td>{booking.patient_name ?? "اسم غير مسجل"}</td>
                  <td><span className="code-chip">{booking.booking_code}</span></td>
                  <td>{booking.department_name ?? "—"}</td>
                  <td>{cairoDate(booking.appointment_at)}</td>
                  <td><span className={`badge${booking.status === "expired" || booking.status === "cancelled" ? " muted" : booking.status === "entry_pending" ? " red" : ""}`}><span className="badge-dot" />{statusLabels[booking.status]}</span></td>
                  <td>
                    <div className="table-action-buttons">
                      <button className="button secondary" onClick={() => copyCode(booking.booking_code)} type="button" aria-label={`نسخ كود الحجز ${booking.booking_code}`}><Copy aria-hidden="true" /> نسخ الكود</button>
                      <button className="button secondary" onClick={() => deleteBooking(booking)} type="button"><Trash2 aria-hidden="true" /> حذف نهائي</button>
                      {booking.status === "checked_in" && <span className="activity-label"><Check aria-hidden="true" /> اكتمل</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {isLoading && <div className="empty-state"><LoaderCircle aria-hidden="true" /></div>}
          {!isLoading && bookings.length === 0 && <div className="empty-state"><strong>مفيش حجوزات لسه</strong>الحجوزات متاحة طول اليوم، ورومي تقدر تحجز أول فترة فاضية في القسم.</div>}
        </div>
        {hasMoreBookings && <button className="button secondary" type="button" disabled={isLoadingMore} onClick={() => void loadMoreBookings()} style={{ margin: 16 }}>{isLoadingMore ? "جاري التحميل" : "عرض حجوزات أقدم"}</button>}
      </section>
    </div>
  );
}
