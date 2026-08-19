import { normalizeUrl } from "@/lib/urls/normalize";

/**
 * LinkedIn identity and permalink handling.
 *
 * The single most valuable thing recoverable from a LinkedIn export URL is the
 * activity id. The same post appears as
 *
 *   https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/
 *   https://www.linkedin.com/posts/someone_a-slug-activity-7100000000000000001-Ab1c
 *
 * in different datasets of the SAME archive. Reducing both to the activity id
 * is what lets a Saved Item be enriched by the Reactions or Comments file
 * sitting next to it — with zero network access.
 */

const LINKEDIN_ORIGIN = "https://www.linkedin.com";

/**
 * LinkedIn's own tracking parameters.
 *
 * `trk` rides on nearly every LinkedIn URL and differs by where the link was
 * copied from, so leaving it in would file one post under several identities.
 * The token-shaped ones arrive on links from LinkedIn's notification emails
 * and are closer to credentials than to tracking — all the more reason not to
 * store them.
 */
const LINKEDIN_TRACKING_PARAMETERS = new Set([
  "trk",
  "trackingid",
  "traceid",
  "originaltrackingid",
  "origintrackingid",
  "original_referer",
  "originalsubdomain",
  "refid",
  "lipi",
  "licu",
  "eid",
  "midtoken",
  "midsig",
  "otptoken",
  "rcm",
]);

export type LinkedInObjectKind = "activity" | "job" | "article" | "other";

export interface LinkedInUrlParts {
  kind: LinkedInObjectKind;
  /** Activity id, job id, or null when the URL names neither. */
  objectId: string | null;
  /** The `/pulse/<slug>` segment for articles. */
  slug: string | null;
}

export function isLinkedInHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "linkedin.com" || host.endsWith(".linkedin.com");
}

/** Parses a LinkedIn URL, rejecting anything that is not LinkedIn. */
export function resolveLinkedInUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!isLinkedInHost(url.hostname)) return null;
  return url;
}

/**
 * Extracts the activity id from either URL form.
 *
 * The `/posts/` form ends with `…-activity-<id>-<4 char token>`; the trailing
 * token is a display artefact and is not part of the identity.
 */
export function activityIdFrom(url: URL): string | null {
  const path = decodeURIComponentSafe(url.pathname);

  const urn = path.match(/urn:li:(?:activity|ugcPost|share):(\d{6,25})/i);
  if (urn?.[1]) return urn[1];

  const posts = path.match(/-activity-(\d{6,25})(?:-|\/|$)/i);
  if (posts?.[1]) return posts[1];

  // `/feed/update/7100000000000000001` shows up in older exports.
  const bare = path.match(/\/feed\/update\/(\d{6,25})(?:\/|$)/i);
  if (bare?.[1]) return bare[1];

  return null;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseLinkedInUrl(value: string): LinkedInUrlParts {
  const url = resolveLinkedInUrl(value);
  if (!url) return { kind: "other", objectId: null, slug: null };

  const activityId = activityIdFrom(url);
  if (activityId) return { kind: "activity", objectId: activityId, slug: null };

  const job = url.pathname.match(/\/jobs\/view\/(\d{4,25})/);
  if (job?.[1]) return { kind: "job", objectId: job[1], slug: null };

  const article = url.pathname.match(/\/pulse\/([A-Za-z0-9_%-]{1,300})/);
  if (article?.[1])
    return { kind: "article", objectId: null, slug: article[1] };

  return { kind: "other", objectId: null, slug: null };
}

/**
 * The canonical permalink for a LinkedIn object.
 *
 * `/feed/update/urn:li:activity:<id>` and `/jobs/view/<id>` are LinkedIn's own
 * documented permalink shapes, so building them from an id the export supplied
 * is a deterministic rewrite rather than an invented URL. When no id is
 * recoverable the original URL is normalized and kept as-is — a URL is never
 * fabricated to satisfy a database constraint.
 */
export function linkedInCanonicalUrl(value: string): string | null {
  const parts = parseLinkedInUrl(value);
  if (parts.kind === "activity" && parts.objectId) {
    return `${LINKEDIN_ORIGIN}/feed/update/urn:li:activity:${parts.objectId}`;
  }
  if (parts.kind === "job" && parts.objectId) {
    return `${LINKEDIN_ORIGIN}/jobs/view/${parts.objectId}`;
  }

  const url = resolveLinkedInUrl(value);
  if (!url) return null;
  for (const name of [...url.searchParams.keys()]) {
    if (LINKEDIN_TRACKING_PARAMETERS.has(name.toLowerCase())) {
      url.searchParams.delete(name);
    }
  }
  try {
    // Then the shared safe normalisation: hash, generic tracking params,
    // trailing slash. Unknown LinkedIn URL shapes are otherwise left alone,
    // because rewriting a form we do not understand risks breaking identity.
    return normalizeUrl(url.toString());
  } catch {
    return null;
  }
}

/** The merge key for a LinkedIn object. */
export function linkedInContentKey(canonicalUrl: string): string {
  const parts = parseLinkedInUrl(canonicalUrl);
  if (parts.kind === "activity" && parts.objectId) {
    return `linkedin:activity:${parts.objectId}`;
  }
  if (parts.kind === "job" && parts.objectId) {
    return `linkedin:job:${parts.objectId}`;
  }
  return `linkedin:url:${canonicalUrl.toLowerCase()}`;
}

/**
 * A LinkedIn `/posts/…` URL embeds the author's public identifier before the
 * slug: `/posts/jane-doe-1234_some-slug-activity-…`. That is data the export
 * supplied, so recovering it is not a network lookup — but it is a handle, not
 * a display name, and is stored as such.
 */
export function authorHandleFrom(value: string): string | null {
  const url = resolveLinkedInUrl(value);
  if (!url) return null;
  const matched = url.pathname.match(/\/posts\/([A-Za-z0-9_-]{2,120})_/);
  const handle = matched?.[1];
  if (!handle || !/[a-z]/i.test(handle)) return null;
  return handle;
}
