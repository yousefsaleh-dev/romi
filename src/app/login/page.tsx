import { redirect } from "next/navigation";
import Image from "next/image";
import { LoginForm } from "@/components/login-form";
import { getAdminSupabase } from "@/lib/auth/admin";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export default async function LoginPage() {
  const configured = isSupabaseConfigured() && Boolean(process.env.ADMIN_EMAIL?.trim());

  if (configured) {
    const adminContext = await getAdminSupabase();
    if (adminContext) redirect("/dashboard");
  }

  return (
    <main className="login-page" dir="rtl">
      <section className="login-story" aria-label="عن ROMI">
        <div className="brand">
          <div className="brand-mark"><Image src="/logo.png" alt="شعار ROMI" fill sizes="56px" priority /></div>
          <div><div className="brand-name">ROMI</div><div className="brand-sub">Hospital access</div></div>
        </div>
        <div className="story-copy">
          <p className="eyebrow">نظام الاستقبال الذكي</p>
          <h1>دخول منظم.<br />رعاية أسرع.</h1>
          <p>إدارة حجوزات التحقق وسجل فتح الباب من لوحة واحدة.</p>
        </div>
        <div className="story-foot">Robotic Medical Intelligence</div>
      </section>
      <section className="login-panel">
        <div className="login-box">
          <p className="eyebrow">بوابة الإدارة</p>
          <h2>أهلًا بعودتك</h2>
          <p>سجّل الدخول بحساب مسؤول المستشفى لمتابعة ROMI.</p>
          <LoginForm configured={configured} />
        </div>
      </section>
    </main>
  );
}
