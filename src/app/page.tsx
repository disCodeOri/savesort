import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    redirect(data.user ? "/search" : "/login");
  } catch {
    redirect("/login");
  }
}
