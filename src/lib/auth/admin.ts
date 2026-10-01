import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function getAdminSupabase() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  const allowedEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const isAdmin = user?.app_metadata?.role === "admin";
  const emailAllowed = Boolean(allowedEmail && user?.email?.toLowerCase() === allowedEmail);

  if (!user || !isAdmin || !emailAllowed) return null;
  return { supabase, user };
}
