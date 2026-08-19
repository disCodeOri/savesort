import {
  detectSource,
  isRestrictedPlatformUrl,
  type Source,
} from "@/lib/sources/detect-source";
import { normalizeUrl, validateHttpUrl } from "@/lib/urls/normalize";
import {
  EXTENSION_TYPES,
  GENERIC_SEGMENT_TYPES,
  PLATFORM_RULES,
  type PlatformRules,
  type UrlContentType,
  type UrlPlatform,
} from "@/lib/urls/patterns";

/**
 * Everything a URL can be made to admit, without fetching it.
 *
 * A saved link is often all GRAPPlin gets — a platform export routinely hands
 * over a URL and a date and nothing else. That URL is not opaque:
 * `reddit.com/r/rust/comments/abc123/why_async_is_hard` names a platform, a
 * community, a stable id and most of a title. Mining it is the difference
 * between an unfindable row and one a vague search can actually reach.
 *
 * Every signal here is derived from the URL string itself. Nothing is fetched,
 * nothing is guessed from outside the string, and the same URL always produces
 * the same analysis.
 */

export interface UrlAnalysis {
  /** The URL as given. */
  input: string;
  /** Normalized, tracking-stripped form. Empty when the URL is unusable. */
  canonicalUrl: string;
  platform: UrlPlatform;
  /** How this maps onto GRAPPlin's existing source union. */
  source: Source;
  contentType: UrlContentType;
  /** A stable platform id when the URL carries one. */
  contentId: string | null;
  /** The author or owner the URL names. */
  author: string | null;
  /** Subreddit, org, channel or publication. */
  community: string | null;
  /** A readable title decoded from a URL slug. Lossy — never verbatim source. */
  titleFromSlug: string | null;
  /** A publication date embedded in the path, e.g. /2024/05/12/. */
  dateFromPath: string | null;
  /** Everything else the pattern named: repo, issue number, timestamp, page. */
  descriptors: Record<string, string>;
  /** Retrieval terms mined from the path. */
  keywords: string[];
  fileExtension: string | null;
  /** True when GRAPPlin must never fetch this URL. */
  restricted: boolean;
  /**
   * How much was actually learned:
   *   high   — a stable id, or an id plus descriptors
   *   medium — no id, but a real title or author came out of the path
   *   low    — only the platform and a content type
   *   none   — not a usable HTTP URL
   */
  confidence: "high" | "medium" | "low" | "none";
}

const MAX_KEYWORDS = 12;
const MIN_KEYWORD_LENGTH = 3;

/**
 * Path words too common to help retrieval.
 *
 * Deliberately small: over-filtering loses real signal, and a keyword that
 * appears in every URL simply never wins a search anyway.
 */
const STOP_SEGMENTS = new Set([
  "www",
  "index",
  "html",
  "htm",
  "php",
  "amp",
  "page",
  "pages",
  "en",
  "en-us",
  "en-gb",
  "the",
  "and",
  "for",
  "with",
  "from",
  "your",
  "you",
  "how",
  "what",
  "why",
  "this",
  "that",
]);

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function findPlatform(hostname: string): PlatformRules | null {
  return (
    PLATFORM_RULES.find((entry) =>
      entry.hosts.some((host) => hostMatches(hostname, host)),
    ) ?? null
  );
}

function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * Turns a URL slug into readable words.
 *
 * `why_async_is_hard`, `why-async-is-hard` and `whyAsyncIsHard` all become
 * "Why async is hard". The result is lossy — casing and punctuation are gone —
 * so callers must record that it came from a slug and never present it as text
 * the platform actually wrote.
 */
export function titleFromSlug(slug: string | null | undefined): string | null {
  if (!slug) return null;

  let decoded = slug;
  try {
    decoded = decodeURIComponent(slug);
  } catch {
    // A malformed escape sequence is not worth discarding the slug over.
  }

  const words = decoded
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    // A trailing hash or id is part of the URL, not part of the title.
    .replace(/[-_](?:[a-f0-9]{7,}|\d{5,})$/i, "")
    .replace(/[-_+]+/g, " ")
    // camelCase and PascalCase slugs split on the case boundary.
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

  if (words.length < 3) return null;
  // Digits alone, or a hex blob, carry no meaning worth showing.
  if (!/[a-z]{2}/i.test(words)) return null;
  if (/^[a-f0-9 ]+$/i.test(words) && !/[g-z]/i.test(words)) return null;

  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A `/2024/05/12/` or `/2024-05-12-` date embedded in a path. */
function dateFromPath(pathname: string): string | null {
  const slashed = pathname.match(
    /\/(\d{4})\/(\d{1,2})(?:\/(\d{1,2}))?(?:\/|$)/,
  );
  const dashed = pathname.match(/\/(\d{4})-(\d{2})-(\d{2})[-/]/);
  const parts = dashed ?? slashed;
  if (!parts) return null;

  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3] ?? 1);
  // A plausible publication date, not an arbitrary number that looks like one.
  if (year < 1990 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

/** Retrieval terms mined from path segments and the slug. */
function keywordsFrom(pathname: string, slugTitle: string | null): string[] {
  const words = [
    ...decodePath(pathname).split(/[/\-_.+]/),
    ...(slugTitle ? slugTitle.split(" ") : []),
  ];

  const terms = words
    .map((word) => word.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter(
      (word) =>
        word.length >= MIN_KEYWORD_LENGTH &&
        !STOP_SEGMENTS.has(word) &&
        // Pure numbers and hex ids are identifiers, not search terms.
        !/^\d+$/.test(word) &&
        !/^[a-f0-9]{16,}$/.test(word),
    );

  return [...new Set(terms)].slice(0, MAX_KEYWORDS);
}

function fileExtensionOf(pathname: string): string | null {
  const matched = pathname.match(/\.([a-z0-9]{1,5})$/i);
  const extension = matched?.[1]?.toLowerCase();
  return extension && extension in EXTENSION_TYPES ? extension : null;
}

/**
 * Classifies an ordinary website URL from its shape alone.
 *
 * This is the case that matters most in volume: most saved links are not on a
 * platform we have rules for. A `/blog/2024/05/why-rust` path still yields a
 * content type, a date and a title.
 */
function classifyGenericPath(
  segments: string[],
  extension: string | null,
): UrlContentType {
  if (extension) return EXTENSION_TYPES[extension] ?? "file";
  if (segments.length === 0) return "home";

  for (const segment of segments) {
    for (const [pattern, type] of GENERIC_SEGMENT_TYPES) {
      if (pattern.test(segment)) return type;
    }
  }

  // A trailing multi-word slug is the signature of an article on almost every
  // publishing platform ever built.
  const last = segments[segments.length - 1] ?? "";
  if (/[-_]/.test(last) && last.length > 12) return "article";
  return "unknown";
}

/** Pulls the named groups a rule matched into a flat descriptor map. */
function descriptorsFrom(groups: Record<string, string | undefined>) {
  const descriptors: Record<string, string> = {};
  for (const [key, value] of Object.entries(groups)) {
    if (typeof value === "string" && value.trim()) {
      descriptors[key] = value.trim().slice(0, 200);
    }
  }
  return descriptors;
}

function confidenceFor(analysis: {
  contentId: string | null;
  titleFromSlug: string | null;
  author: string | null;
  contentType: UrlContentType;
}): UrlAnalysis["confidence"] {
  if (analysis.contentId) return "high";
  if (analysis.titleFromSlug || analysis.author) return "medium";
  return analysis.contentType === "unknown" ? "low" : "low";
}

/**
 * Analyses one URL.
 *
 * Never throws. An unusable string returns a `none`-confidence result rather
 * than an exception, because this runs over whole export files where one bad
 * row must not stop the rest.
 */
export function analyzeUrl(input: string): UrlAnalysis {
  const empty: UrlAnalysis = {
    input,
    canonicalUrl: "",
    platform: "web",
    source: "other",
    contentType: "unknown",
    contentId: null,
    author: null,
    community: null,
    titleFromSlug: null,
    dateFromPath: null,
    descriptors: {},
    keywords: [],
    fileExtension: null,
    restricted: false,
    confidence: "none",
  };

  const validation = validateHttpUrl(input ?? "");
  if (!validation.ok) return empty;

  const url = validation.url;
  let canonicalUrl = "";
  try {
    canonicalUrl = normalizeUrl(url.toString());
  } catch {
    canonicalUrl = url.toString();
  }

  const hostname = url.hostname.toLowerCase();
  const pathname = decodePath(url.pathname);
  const segments = pathname.split("/").filter(Boolean);
  const extension = fileExtensionOf(pathname);
  const platformRules = findPlatform(hostname);

  const analysis: UrlAnalysis = {
    ...empty,
    canonicalUrl,
    platform: platformRules?.platform ?? "web",
    source: platformRules?.source ?? detectSource(canonicalUrl),
    fileExtension: extension,
    restricted: isRestrictedPlatformUrl(canonicalUrl),
    dateFromPath: dateFromPath(pathname),
  };

  if (platformRules) {
    for (const rule of platformRules.rules) {
      const matched = pathname.match(rule.pattern);
      if (!matched) continue;

      const groups = descriptorsFrom(matched.groups ?? {});
      for (const [name, key] of Object.entries(rule.params ?? {})) {
        const value = url.searchParams.get(key);
        if (value) groups[name] = value.slice(0, 200);
      }

      analysis.contentType = rule.contentType;
      // A comment id is the identity of a comment; the post id it sits under
      // stays available as a descriptor.
      analysis.contentId = groups.commentId ?? groups.id ?? null;
      analysis.author = groups.author ?? null;
      analysis.community = groups.community ?? null;
      analysis.titleFromSlug = titleFromSlug(groups.slug);
      analysis.descriptors = groups;
      break;
    }

    if (analysis.contentType === "unknown") {
      analysis.contentType = platformRules.fallback;
    }
  } else {
    analysis.contentType = classifyGenericPath(segments, extension);
    // On an unknown host the last meaningful segment is the best title
    // candidate there is.
    const last = segments[segments.length - 1];
    analysis.titleFromSlug = titleFromSlug(last);

    // A trailing numeric or hash-shaped segment is an id on most CMSes.
    if (last && /^(?:\d{2,}|[a-f0-9]{8,})$/i.test(last)) {
      analysis.contentId = last;
      analysis.titleFromSlug = titleFromSlug(segments[segments.length - 2]);
    }
    if (url.searchParams.get("q") || url.searchParams.get("query")) {
      analysis.contentType = "search";
    }
  }

  analysis.keywords = keywordsFrom(pathname, analysis.titleFromSlug);
  analysis.confidence = confidenceFor(analysis);
  return analysis;
}

/**
 * A stable merge key for a URL.
 *
 * Prefers the platform id, because two URL spellings of the same post must
 * collapse onto one library row. Falls back to the canonical URL when the
 * platform gave us nothing to key on.
 */
export function urlContentKey(analysis: UrlAnalysis): string | null {
  if (!analysis.canonicalUrl) return null;
  if (analysis.contentId) {
    return `${analysis.platform}:${analysis.contentType}:${analysis.contentId}`;
  }
  return `${analysis.platform}:url:${analysis.canonicalUrl.toLowerCase()}`;
}

/** A short human label for the kind of thing a URL points at. */
export function describeContentType(type: UrlContentType): string {
  const labels: Partial<Record<UrlContentType, string>> = {
    pull_request: "pull request",
    home: "site",
    unknown: "link",
  };
  return labels[type] ?? type.replace(/_/g, " ");
}
