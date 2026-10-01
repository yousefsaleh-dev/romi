"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { Activity, AudioLines, CalendarDays, LayoutDashboard, LogOut } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

const navigation = [
  { href: "/dashboard", label: "نظرة عامة", icon: LayoutDashboard },
  { href: "/dashboard/simulation", label: "محاكاة صوتية", icon: AudioLines },
  { href: "/dashboard/bookings", label: "الحجوزات", icon: CalendarDays },
  { href: "/dashboard/activity", label: "سجل النشاط", icon: Activity },
];

export function AdminShell({ children, email }: { children: React.ReactNode; email: string }) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.replace("/login");
  }

  return (
    <div className="app-frame" dir="rtl">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Image src="/logo.png" alt="شعار ROMI" fill sizes="56px" priority /></div>
          <div><div className="brand-name">ROMI</div><div className="brand-sub">تشغيل المستشفى</div></div>
        </div>
        <p className="nav-label">التشغيل</p>
        <nav className="nav-list" aria-label="التنقل الرئيسي">
          {navigation.map(({ href, label, icon: Icon }) => {
            const active = href === "/dashboard" ? pathname === href : pathname.startsWith(href);
            return (
              <Link className={`nav-link${active ? " active" : ""}`} href={href} key={href} aria-current={active ? "page" : undefined}>
                <Icon aria-hidden="true" />{label}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          ROMI · بوابة استقبال المستشفى
          <div className="site-pill"><span className="site-dot" /> نقطة استقبال واحدة</div>
        </div>
      </aside>
      <div className="main-area">
        <header className="topbar">
          <div className="crumb">لوحة الإدارة <span aria-hidden="true">/</span> ROMI</div>
          <div className="topbar-right">
            <span className="admin-chip"><span className="avatar">{email.slice(0, 1).toUpperCase()}</span>{email}</span>
            <button className="button secondary" onClick={signOut} type="button" aria-label="تسجيل الخروج">
              <LogOut aria-hidden="true" /> خروج
            </button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
