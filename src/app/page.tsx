import { LandingPage } from "@/components/landing/landing-page";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let isAuthenticated = false;
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    isAuthenticated = Boolean(data?.user);
  } catch {
    isAuthenticated = false;
  }

  return <LandingPage isAuthenticated={isAuthenticated} />;
}
