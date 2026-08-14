import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let email = "Account";
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (!data.user) redirect("/login");
    email = data.user.email ?? email;
  } catch {
    redirect("/login?error=Connect Supabase to open your private library.");
  }
  return <AppShell email={email}>{children}</AppShell>;
}
