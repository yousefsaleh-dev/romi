import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { getAdminSupabase } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const adminContext = await getAdminSupabase();
  if (!adminContext) redirect("/login");

  return <AdminShell email={adminContext.user.email ?? "admin"}>{children}</AdminShell>;
}
