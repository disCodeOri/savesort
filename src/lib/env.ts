export function getSupabasePublicConfig(): {
  url: string;
  publishableKey: string;
} {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) {
    throw new Error(
      "Supabase public environment variables are not configured.",
    );
  }
  return { url, publishableKey };
}

export interface GitHubServerConfig {
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  supabaseSecretKey: string;
}

export function getGitHubServerConfig(): GitHubServerConfig {
  const config = {
    clientId: process.env.GITHUB_APP_CLIENT_ID,
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
    encryptionKey: process.env.GITHUB_TOKEN_ENCRYPTION_KEY,
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY,
  };
  if (Object.values(config).some((value) => !value)) {
    throw new Error("GitHub connection is not configured.");
  }
  return config as GitHubServerConfig;
}
