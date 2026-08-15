import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getGitHubServerConfig, getSupabasePublicConfig } from "@/lib/env";

export function createAdminClient() {
  const { url } = getSupabasePublicConfig();
  const { supabaseSecretKey } = getGitHubServerConfig();
  return createClient(url, supabaseSecretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
