import { redirect } from "next/navigation";
import { getAdminSupabase } from "@/lib/auth/admin";

const outcomeLabels: Record<string, string> = {
  accepted: "الحجز صحيح",
  rejected: "الحجز مرفوض",
  missing_code: "الكود غير واضح",
  provider_error: "تعذّر طلب AI",
};
const reasonLabels: Record<string, string> = {
  not_found: "الكود مش موجود",
  already_used: "الكود اتستخدم قبل كده",
  expired: "فترة الدخول انتهت",
  too_early: "لسه بدري على الموعد",
  cancelled: "الحجز ملغي",
  door_pending: "أمر الباب قيد التنفيذ",
  valid: "الحجز صالح",
  door_failed: "الجهاز ما أكدش فتح الباب",
  booking_created: "اتعمل حجز جديد",
};

export default async function ActivityPage() {
  const adminContext = await getAdminSupabase();
  if (!adminContext) redirect("/login");

  const { data, error } = await adminContext.supabase
    .from("ai_actions")
    .select("id, source, booking_code, outcome, decision_reason, attempt_count, text_input_tokens, text_output_tokens, audio_input_tokens, audio_output_tokens, estimated_cost_usd, billing_tier, latency_ms, created_at, door_commands(status, opened_at, simulated, error_code)")
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <div>
      <div className="page-head">
        <div><p className="eyebrow">المراجعة</p><h1>سجل النشاط</h1><p className="page-description">محاولات التحقق واستهلاك الذكاء الاصطناعي وتأكيد الباب.</p></div>
      </div>
      {error && <div className="notice">تعذّر تحميل السجل. تأكد من تطبيق migration قاعدة البيانات.</div>}
      <section className="panel">
        <div className="panel-head"><span className="panel-title">محاولات ROMI</span><span className="panel-meta">آخر ١٠٠ طلب · لا يُحفظ الصوت أو نص المحادثة</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>الوقت</th><th>كود الحجز</th><th>نتيجة AI</th><th>الباب</th><th>التوكنز</th><th>التكلفة</th><th>الاستجابة</th></tr></thead>
            <tbody>
              {(data ?? []).map((action) => {
                const command = Array.isArray(action.door_commands) ? action.door_commands[0] : action.door_commands;
                const opened = command?.status === "opened";
                return (
                  <tr key={action.id}>
                    <td>{new Intl.DateTimeFormat("ar-EG", { timeZone: "Africa/Cairo", dateStyle: "short", timeStyle: "short" }).format(new Date(action.created_at))}</td>
                    <td>{action.booking_code ? <span className="code-chip">{action.booking_code}</span> : "—"}</td>
                    <td><span className={`badge${action.outcome === "rejected" || action.outcome === "provider_error" ? " red" : action.outcome === "missing_code" ? " muted" : ""}`}><span className="badge-dot" />{reasonLabels[action.decision_reason] ?? outcomeLabels[action.outcome] ?? action.outcome}</span>{action.attempt_count > 0 ? ` · ${action.attempt_count} محاولات` : ""}</td>
                    <td>{opened ? `${command?.simulated ? "فُتح · محاكاة" : "فُتح"} ${new Intl.DateTimeFormat("ar-EG", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" }).format(new Date(command.opened_at))}` : command?.status === "failed" ? "تعذّر الفتح" : command?.status === "pending" || command?.status === "sent" ? "بانتظار الجهاز" : action.source === "simulation" && action.outcome === "accepted" ? "لا يوجد فتح" : "لم يصدر أمر"}</td>
                    <td>{action.text_input_tokens + action.text_output_tokens + action.audio_input_tokens + action.audio_output_tokens}</td>
                    <td>{action.billing_tier === "free" ? "مجاني · Free Tier" : action.billing_tier === "paid" && action.estimated_cost_usd !== null ? `$${Number(action.estimated_cost_usd).toFixed(5)}` : "غير معروف"}</td>
                    <td>{action.latency_ms === null ? "—" : `${action.latency_ms} ms`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!error && (data?.length ?? 0) === 0 && <div className="empty-state"><strong>سجل النشاط فارغ</strong>ستظهر هنا محاولات التحقق ونتيجة فتح الباب.</div>}
        </div>
      </section>
    </div>
  );
}
