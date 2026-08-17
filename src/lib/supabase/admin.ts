import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getSupabasePublicConfig, getSupabaseSecretKey } from "@/lib/env";

export function createAdminClient() {
  const { url } = getSupabasePublicConfig();
  return createClient(url, getSupabaseSecretKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
