export const SOURCES = [
  "github",
  "instagram",
  "youtube",
  "reddit",
  "x",
  "obsidian",
  "website",
  "other",
] as const;

export type Source = (typeof SOURCES)[number];

function isHost(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

const RESTRICTED_PLATFORM_DOMAINS = [
  "instagram.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "facebook.com",
];

export function isRestrictedPlatformUrl(input: string): boolean {
  try {
    const hostname = new URL(input).hostname.toLowerCase();
    return RESTRICTED_PLATFORM_DOMAINS.some((domain) =>
      isHost(hostname, domain),
    );
  } catch {
    return false;
  }
}

export function detectSource(input: string): Source {
  const hostname = new URL(input).hostname.toLowerCase();

  if (isHost(hostname, "github.com")) return "github";
  if (isHost(hostname, "instagram.com")) return "instagram";
  if (isHost(hostname, "youtube.com") || hostname === "youtu.be")
    return "youtube";
  if (isHost(hostname, "reddit.com")) return "reddit";
  if (isHost(hostname, "x.com") || isHost(hostname, "twitter.com")) return "x";
  return "website";
}

export function parseGitHubRepositoryUrl(
  input: string,
): { owner: string; repository: string } | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (!isHost(url.hostname.toLowerCase(), "github.com")) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;

  const [owner, rawRepository] = parts;
  const repository = rawRepository.replace(/\.git$/i, "");
  if (!owner || !repository) return null;

  return { owner, repository };
}

export const RESTRICTED_SOURCES = new Set<Source>(["instagram", "x"]);
