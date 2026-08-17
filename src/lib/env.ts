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

/**
 * The server-side Supabase key on its own. Provider integrations each used to
 * reach for this through their own config getter, which meant an unrelated
 * missing variable (say a GitHub one) would break Reddit and Obsidian sync too.
 */
export function getSupabaseSecretKey(): string {
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("The Supabase server key is not configured.");
  }
  return secretKey;
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

export interface RedditServerConfig {
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  supabaseSecretKey: string;
  /**
   * Reddit requires a unique, descriptive User-Agent on every Data API call, in
   * the form `web:<app id>:<version> (by /u/<reddit username>)`.
   */
  userAgent: string;
}

export function getRedditServerConfig(): RedditServerConfig {
  const config = {
    clientId: process.env.REDDIT_APP_CLIENT_ID,
    clientSecret: process.env.REDDIT_APP_CLIENT_SECRET,
    encryptionKey: process.env.REDDIT_TOKEN_ENCRYPTION_KEY,
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY,
    userAgent: process.env.REDDIT_USER_AGENT,
  };
  if (Object.values(config).some((value) => !value)) {
    throw new Error("Reddit connection is not configured.");
  }
  return config as RedditServerConfig;
}
