import { redirect } from "next/navigation";
import Link from "next/link";
import { Activity, AudioLines, BadgeCheck, CalendarDays, DoorOpen, Sparkles } from "lucide-react";
import { getAdminSupabase } from "@/lib/auth/admin";

function countLabel(count: number | null) {
  return count === null ? "—" : new Intl.NumberFormat("ar-EG").format(count);
}

function timeLabel(value?: string | null) {
  if (!value) return "لم يُسجّل فتح بعد";
  return new Intl.DateTimeFormat("ar-EG", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }).format(new Date(value));
}

function moneyLabel(amount: number | null) {
  if (amount === null) return "غير محسوبة";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(amount);
}

function formatMoment(value: string) {
  return new Intl.DateTimeFormat("ar-EG", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }).format(new Date(value));
}

export default async function DashboardPage() {
  const adminContext = await getAdminSupabase();
  if (!adminContext) redirect("/login");
  const { supabase } = adminContext;
  // This is a server-rendered snapshot window, not client render state.
  // eslint-disable-next-line react-hooks/purity
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [bookingCount, aiRows, aiUsage, openDoor] = await Promise.all([
    supabase.from("appointments").select("id", { count: "exact", head: true }).eq("status", "scheduled"),
    supabase.from("ai_actions").select("id, booking_code, outcome, decision_reason, reply_text, text_input_tokens, text_output_tokens, audio_input_tokens, audio_output_tokens, estimated_cost_usd, billing_tier, source, created_at").gte("created_at", dayAgo).order("created_at", { ascending: false }).limit(8),
    supabase.from("ai_actions").select("outcome, source, text_input_tokens, text_output_tokens, audio_input_tokens, audio_output_tokens, estimated_cost_usd, billing_tier").gte("created_at", dayAgo),
    supabase.from("door_commands").select("opened_at, simulated").eq("status", "opened").order("opened_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const queryFailed = Boolean(bookingCount.error || aiRows.error || aiUsage.error || openDoor.error);
  const recentActions = aiRows.data ?? [];
  const usageRows = aiUsage.data ?? [];
  const estimatedCost = usageRows.reduce((sum, action) => sum + Number(action.estimated_cost_usd ?? 0), 0);
  const costKnown = usageRows.length === 0 || usageRows.every((action) => action.billing_tier === "free" || (action.billing_tier === "paid" && action.estimated_cost_usd !== null));
  const allFree = usageRows.length > 0 && usageRows.every((action) => action.billing_tier === "free");
  const checkedIns = usageRows.filter((action) => action.outcome === "accepted" && action.source === "kiosk").length;
  const requestCount = aiUsage.error ? null : usageRows.length;
  const tokenCount = usageRows.reduce((sum, action) => sum + action.text_input_tokens + action.text_output_tokens + action.audio_input_tokens + action.audio_output_tokens, 0);

  return (
    <div>
      <div className="page-head">
        <div><p className="eyebrow">مركز تشغيل البوابة</p><h1>نظرة عامة</h1><p className="page-description">حالة المحطة، التحقق من الحجوزات، واستخدام ROMI خلال اليوم.</p></div>
        <div className="dashboard-head-actions">
          <Link className="button dashboard-simulation-link" href="/dashboard/simulation"><AudioLines aria-hidden="true" /> افتح المحاكاة الصوتية</Link>
          <div className="dashboard-period"><span>آخر ٢٤ ساعة</span><time className="date-stamp">{new Intl.DateTimeFormat("ar-EG", { timeZone: "Africa/Cairo", dateStyle: "medium" }).format(new Date())}</time></div>
        </div>
      </div>
      {queryFailed && <div className="notice">تعذّر تحميل جزء من البيانات. تأكد من تطبيق migration قاعدة البيانات ثم أعد تحميل الصفحة.</div>}
      <section className="door-banner" aria-label="حالة الباب">
        <div>
          <div className="door-status-label"><span className="door-status-light" /> بوابة ROMI · نقطة استقبال المستشفى</div>
          <h2>بوابة استقبال المستشفى</h2>
          <p>يتم التحقق من كود الحجز على الخادم قبل تسجيل محاولة الفتح.</p>
        </div>
        <div className="door-open-time"><span>آخر فتح مسجل</span><strong>{timeLabel(openDoor.data?.opened_at)}</strong></div>
      </section>
      <section className="metrics" aria-label="ملخص الأرقام">
        <Metric icon={<CalendarDaysIcon />} label="حجوزات بانتظار الوصول" value={countLabel(bookingCount.count)} hint="أكواد صالحة للتحقق" />
        <Metric icon={<Activity />} label="طلبات الذكاء الاصطناعي" value={countLabel(requestCount)} hint="خلال آخر ٢٤ ساعة" />
        <Metric icon={<BadgeCheck />} label="دخول تم التحقق منه" value={countLabel(aiUsage.data ? checkedIns : null)} hint="نتيجة تحقق مقبولة" />
        <Metric icon={<Sparkles />} label="تكلفة AI التقديرية" value={allFree ? "مجاني" : costKnown ? moneyLabel(estimatedCost) : "—"} hint={allFree ? "Free Tier · آخر ٢٤ ساعة" : costKnown ? "للبيانات المعروضة" : "إعداد الفوترة غير معروف"} />
      </section>
      <div className="two-col">
        <section className="panel">
          <div className="panel-head"><span className="panel-title">آخر قرارات ROMI</span><span className="panel-meta">أحدث ٨ محاولات</span></div>
          <div className="panel-body">
            {recentActions.length === 0 ? <div className="empty-state"><strong>لسه مفيش محاولات</strong>هيظهر هنا كل طلب تحقق جديد.</div> : recentActions.map((action) => (
              <div className="activity-row" key={action.id}>
                <span className={`activity-icon${action.outcome === "rejected" || action.outcome === "provider_error" ? " denied" : ""}`}>
                  {action.outcome === "accepted" ? <DoorOpen aria-hidden="true" /> : <AudioLines aria-hidden="true" />}
                </span>
                <div className="activity-main">
                  <div className="activity-label">{action.reply_text ?? labelDecision(action.decision_reason, action.outcome)}</div>
                  <div className="activity-detail">{action.booking_code ? `كود ${action.booking_code}` : "بدون كود"} · {labelOutcome(action.outcome)}{action.source === "simulation" ? " · محاكاة" : ""}</div>
                </div>
                <time className="activity-time" dateTime={action.created_at}>{formatMoment(action.created_at)}</time>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><span className="panel-title">استهلاك الذكاء الاصطناعي</span><span className="panel-meta">آخر ٢٤ ساعة</span></div>
          <div className="usage-summary">
            <div className="usage-number">{countLabel(requestCount)}</div>
            <div className="usage-sub">طلب مسجل على Gemini</div>
            <div className="usage-divider" />
            <div className="usage-line"><span>التوكنز المستخدمة</span><strong>{countLabel(aiRows.data ? tokenCount : null)}</strong></div>
            <div className="usage-line"><span>التكلفة التقديرية</span><strong>{costKnown ? moneyLabel(estimatedCost) : "بانتظار ضبط الأسعار"}</strong></div>
            <p className="usage-note">الحساب تقديري من بيانات الاستخدام وسعر التوكن المضبوط في السيرفر؛ راجع Google AI Studio للفوترة الفعلية.</p>
          </div>
        </section>
      </div>
    </div>
  );
}

function CalendarDaysIcon() {
  return <CalendarDays aria-hidden="true" />;
}

function Metric({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint: string }) {
  return (
    <article className="metric-card">
      <div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div>
      <div className="metric-value">{value}</div>
      <div className="metric-hint">{hint}</div>
    </article>
  );
}

function labelOutcome(outcome: string) {
  const labels: Record<string, string> = {
    accepted: "تم قبول الحجز",
    rejected: "كود الحجز غير صالح",
    missing_code: "لم يتم التقاط كود",
    provider_error: "تعذّر الاتصال بالذكاء الاصطناعي",
  };
  return labels[outcome] ?? "محاولة تحقق";
}

function labelDecision(reason: string | null, outcome: string) {
  if (reason === "booking_created") return "تم إنشاء حجز جديد";
  return labelOutcome(outcome);
}
