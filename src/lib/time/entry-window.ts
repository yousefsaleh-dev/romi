const EARLY_ENTRY_MS = 60 * 60 * 1000;
const ENTRY_EXPIRY_MS = 2 * 60 * 60 * 1000;

export function getAppointmentEntryWindow(appointmentAt: string, checkedAt = Date.now()) {
  const appointmentTime = Date.parse(appointmentAt);
  if (!Number.isFinite(appointmentTime)) throw new Error("Invalid appointment timestamp.");

  const opensAtTime = appointmentTime - EARLY_ENTRY_MS;
  const closesAtTime = appointmentTime + ENTRY_EXPIRY_MS;
  const reason = checkedAt < opensAtTime ? "too_early" : checkedAt >= closesAtTime ? "expired" : "valid";

  return {
    canEnterNow: reason === "valid",
    opensAt: new Date(opensAtTime).toISOString(),
    closesAt: new Date(closesAtTime).toISOString(),
    reason,
  } as const;
}

export function describeEntryStatus(appointmentAt: string, checkedAt = Date.now(), status = "scheduled") {
  const window = getAppointmentEntryWindow(appointmentAt, checkedAt);
  const format = (value: string) => new Intl.DateTimeFormat("ar-EG", {
    timeZone: "Africa/Cairo", dateStyle: "full", timeStyle: "short",
  }).format(new Date(value));
  if (status === "checked_in") return "تم تسجيل الوصول للحجز بالفعل. ما فيش فتح باب جديد تلقائيًا.";
  if (status === "cancelled") return "الحجز ملغي، والدخول غير متاح.";
  if (window.reason === "too_early") return `الدخول غير متاح دلوقتي. موعد الحجز ${format(appointmentAt)}، وتقدر تسجل وصولك من ${format(window.opensAt)}. الباب لم يُفتح.`;
  if (window.reason === "expired" || status === "expired") return "فترة الدخول للحجز انتهت، والدخول غير متاح دلوقتي. الباب لم يُفتح.";
  if (status === "entry_pending") return "طلب فتح الباب قيد التنفيذ؛ استنى تأكيد الجهاز قبل الدخول.";
  return `تقدر تسجل وصولك دلوقتي، وفترة الدخول مستمرة لحد ${format(window.closesAt)}. الباب لم يُفتح بعد؛ لازم تأكيد تسجيل الوصول.`;
}
