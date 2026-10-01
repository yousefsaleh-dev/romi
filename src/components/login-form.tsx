"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export function LoginForm({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage("");
    setIsSubmitting(true);

    try {
      const form = new FormData(event.currentTarget);
      const email = String(form.get("email")).trim();
      const password = String(form.get("password"));
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithPassword({ email, password });

      if (error) {
        setErrorMessage("البريد الإلكتروني أو كلمة المرور غير صحيحة.");
        return;
      }

      router.replace("/dashboard");
    } catch {
      setErrorMessage("تعذّر الاتصال بخدمة تسجيل الدخول. حاول مرة أخرى.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={signIn}>
      {!configured && <div className="notice">أكمل إعداد Supabase وحدد بريد مسؤول واحد في ADMIN_EMAIL داخل ملف البيئة لتفعيل الدخول.</div>}
      <label className="field" htmlFor="email">
        البريد الإلكتروني
        <input id="email" name="email" type="email" autoComplete="username" required disabled={!configured || isSubmitting} />
      </label>
      <label className="field" htmlFor="password">
        كلمة المرور
        <input id="password" name="password" type="password" autoComplete="current-password" required disabled={!configured || isSubmitting} />
      </label>
      <button className="button" type="submit" disabled={!configured || isSubmitting}>
        {isSubmitting ? <LoaderCircle aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
        {isSubmitting ? "جاري تسجيل الدخول" : "دخول لوحة الإدارة"}
      </button>
      {errorMessage && <p className="login-error" role="alert">{errorMessage}</p>}
    </form>
  );
}
