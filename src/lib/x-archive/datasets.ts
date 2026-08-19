/**
 * Which archive files GRAPPlin will read, and which it refuses to touch.
 *
 * This is an allowlist, not a blocklist. An X archive contains direct
 * messages, contacts, IP and device history, login records and ad-targeting
 * data; none of that belongs in a knowledge search index, and none of it
 * should ever reach an AI model. Anything not explicitly recognised as
 * content-bearing is skipped, so a dataset X adds in future is excluded by
 * default rather than silently ingested.
 */

export type ArchiveDataset =
  "bookmarks" | "likes" | "posts" | "account" | "profile";

export interface DatasetMatch {
  dataset: ArchiveDataset;
  /** Why this file matched, for the import report. */
  reason: string;
}

/**
 * Filename stems, oldest Twitter naming through current X naming. Matched on
 * the basename so `data/like.js`, `like-part1.js` and `twitter-likes.js` all
 * resolve the same way.
 */
const DATASET_PATTERNS: Array<{
  dataset: ArchiveDataset;
  patterns: RegExp[];
}> = [
  {
    dataset: "bookmarks",
    patterns: [/^bookmark/, /bookmarks?$/, /saved[-_]?(post|tweet)s?/],
  },
  {
    dataset: "likes",
    patterns: [
      /^likes?$/,
      /^like[-_]/,
      /favorites?$/,
      /liked[-_]?(post|tweet)s?/,
    ],
  },
  {
    dataset: "posts",
    // "tweets" is the old name; "posts" is current. Both appear in the wild,
    // sometimes in the same archive.
    patterns: [
      /^tweets?$/,
      /^tweet[-_]/,
      /^posts?$/,
      /^post[-_]/,
      /^note[-_]?tweet/,
    ],
  },
  { dataset: "account", patterns: [/^account$/] },
  { dataset: "profile", patterns: [/^profile$/] },
];

/**
 * Datasets that must never be read. Listed explicitly so the intent is
 * reviewable, even though the allowlist above already excludes them.
 */
export const PRIVACY_EXCLUDED = [
  "direct-message",
  "direct_message",
  "dm-",
  "dm_",
  "contact",
  "address-book",
  "phone",
  "email-address",
  "ip-audit",
  "device",
  "login",
  "account-creation-ip",
  "account-suspension",
  "ad-",
  "ads-",
  "advertiser",
  "personalization",
  "audience",
  "demographic",
  "payment",
  "billing",
  "card",
  "verified-organization",
  "screen-name-change",
  "connected-application",
  "saved-search",
  "protected-history",
  "user-link-clicks",
];

function basename(relativePath: string): string {
  const name = relativePath.split("/").pop() ?? relativePath;
  return name.replace(/\.(js|json|csv|html)$/i, "").toLowerCase();
}

/** True when any path segment names a privacy-excluded dataset. */
export function isPrivacyExcluded(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return PRIVACY_EXCLUDED.some((marker) => lower.includes(marker));
}

/**
 * Classifies one archive file. Returns null when the file is excluded or
 * simply not content-bearing.
 */
export function detectDataset(relativePath: string): DatasetMatch | null {
  if (isPrivacyExcluded(relativePath)) return null;

  const stem = basename(relativePath)
    // Archives split large datasets across part files.
    .replace(/[-_]?part\d+$/, "")
    .replace(/^twitter[-_]/, "");

  for (const entry of DATASET_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(stem))) {
      return {
        dataset: entry.dataset,
        reason: `matched ${entry.dataset} naming`,
      };
    }
  }
  return null;
}

/**
 * Structural fallback for a file whose name GRAPPlin does not recognise.
 *
 * X renames files between archive versions, so shape is checked as well as
 * name — but only to assign a file to an already-allowlisted dataset, never
 * to pull in something the allowlist excluded.
 */
export function detectDatasetFromShape(
  relativePath: string,
  records: unknown[],
): DatasetMatch | null {
  if (isPrivacyExcluded(relativePath) || records.length === 0) return null;

  const sample = records[0];
  if (!sample || typeof sample !== "object") return null;
  const keys = new Set(
    Object.keys(sample as Record<string, unknown>).map((key) =>
      key.toLowerCase(),
    ),
  );

  // Archive records are usually wrapped one level deep, e.g. { like: {...} }.
  const wrapper = [...keys][0];
  const inner =
    keys.size === 1 && wrapper
      ? (sample as Record<string, unknown>)[wrapper]
      : sample;
  const innerKeys = new Set(
    inner && typeof inner === "object"
      ? Object.keys(inner as Record<string, unknown>).map((key) =>
          key.toLowerCase(),
        )
      : [],
  );

  if (
    wrapper === "like" ||
    (innerKeys.has("expandedurl") && innerKeys.has("tweetid"))
  ) {
    return { dataset: "likes", reason: "matched like record shape" };
  }
  if (wrapper === "bookmark" || innerKeys.has("bookmarkedat")) {
    return { dataset: "bookmarks", reason: "matched bookmark record shape" };
  }
  if (
    wrapper === "tweet" ||
    wrapper === "post" ||
    (innerKeys.has("full_text") && innerKeys.has("id_str")) ||
    (innerKeys.has("fulltext") && innerKeys.has("idstr"))
  ) {
    return { dataset: "posts", reason: "matched post record shape" };
  }
  return null;
}
