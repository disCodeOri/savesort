/**
 * Turns raw archive records into a normalized shape.
 *
 * Nothing here invents data. When the archive supplies only an id, the result
 * is a reference-only record with null text — never a fabricated summary, and
 * never a value derived from a different field that happens to be present.
 */

export type RelationshipType =
  "bookmark" | "like" | "own_post" | "repost" | "reply" | "quote_post";

export type ContentAvailability = "full" | "partial" | "reference_only";

export interface NormalizedRecord {
  postId: string;
  canonicalUrl: string;
  text: string | null;
  authorUsername: string | null;
  authorName: string | null;
  createdAt: string | null;
  conversationId: string | null;
  replyToPostId: string | null;
  quotedPostId: string | null;
  hashtags: string[];
  mentions: string[];
  externalUrls: string[];
  mediaUrls: string[];
  relationships: Array<{ type: RelationshipType; timestamp: string | null }>;
  sourceFile: string;
}

/**
 * Post ids are numeric but not fixed width: 2006-era ids are one or two
 * digits, modern snowflake ids are 19. A historical archive is precisely
 * where the short ones show up, so the lower bound is 1.
 */
const POST_ID_PATTERN = /^\d{1,25}$/;
/** Matches both twitter.com and x.com status permalinks. */
const STATUS_URL_PATTERN =
  /(?:twitter|x)\.com\/([A-Za-z0-9_]{1,20})\/status(?:es)?\/(\d{1,25})/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Archive records nest their payload one level, e.g. { like: {...} }. */
export function unwrapRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const inner = value[keys[0]!];
    if (isRecord(inner)) return inner;
  }
  return value;
}

/** Reads a field under any of several historical spellings. */
function field(record: Record<string, unknown>, ...names: string[]): unknown {
  const lowered = new Map(
    Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]),
  );
  for (const name of names) {
    const value = lowered.get(name.toLowerCase());
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function extractPostId(record: Record<string, unknown>): string | null {
  const direct = str(
    field(
      record,
      "tweetId",
      "tweet_id",
      "postId",
      "post_id",
      "id_str",
      "idStr",
      "id",
    ),
  );
  if (direct && POST_ID_PATTERN.test(direct)) return direct;

  const url = str(
    field(record, "expandedUrl", "expanded_url", "url", "tweetUrl"),
  );
  const matched = url?.match(STATUS_URL_PATTERN);
  return matched?.[2] ?? null;
}

/**
 * Canonical permalink. x.com is chosen as the single canonical host so an
 * archive record and an API record for the same post collapse onto one
 * saved_items row.
 */
export function canonicalUrl(postId: string, username: string | null): string {
  return `https://x.com/${username ?? "i"}/status/${postId}`;
}

export function usernameFromUrl(value: string | null): string | null {
  const matched = value?.match(STATUS_URL_PATTERN);
  return matched?.[1] ?? null;
}

function toIso(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function stringList(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (isRecord(entry)) {
      const nested = str(entry[key]);
      return nested ? [nested] : [];
    }
    return [];
  });
}

function entitiesFrom(record: Record<string, unknown>) {
  const entities = field(record, "entities");
  const container = isRecord(entities) ? entities : {};
  const urls = Array.isArray(container.urls) ? container.urls : [];

  return {
    hashtags: stringList(container.hashtags, "text"),
    mentions: stringList(
      container.user_mentions ?? container.userMentions,
      "screen_name",
    ),
    externalUrls: urls.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const url =
        str(entry.expanded_url) ?? str(entry.expandedUrl) ?? str(entry.url);
      // t.co shorteners carry no meaning for search; keep only real targets.
      return url && !/^https?:\/\/t\.co\//i.test(url) ? [url] : [];
    }),
  };
}

function mediaFrom(record: Record<string, unknown>): string[] {
  const entities = field(
    record,
    "extended_entities",
    "extendedEntities",
    "entities",
  );
  if (!isRecord(entities) || !Array.isArray(entities.media)) return [];
  return entities.media.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const url =
      str(entry.media_url_https) ??
      str(entry.mediaUrlHttps) ??
      str(entry.media_url);
    return url ? [url] : [];
  });
}

/** Enough text to be worth classifying and embedding. */
export function availabilityFor(text: string | null): ContentAvailability {
  if (!text) return "reference_only";
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length >= 80) return "full";
  if (collapsed.length > 0) return "partial";
  return "reference_only";
}

/**
 * Normalizes one archive record for a known dataset.
 *
 * Returns null when no stable post id can be found — an unidentifiable record
 * cannot be deduplicated and is not worth importing.
 */
export function normalizeRecord(
  raw: unknown,
  relationship: RelationshipType,
  sourceFile: string,
): NormalizedRecord | null {
  const record = unwrapRecord(raw);
  if (!record) return null;

  const postId = extractPostId(record);
  if (!postId) return null;

  const url = str(
    field(record, "expandedUrl", "expanded_url", "url", "tweetUrl"),
  );
  const explicitUsername =
    str(field(record, "screenName", "screen_name", "username")) ??
    (isRecord(field(record, "user"))
      ? str((field(record, "user") as Record<string, unknown>).screen_name)
      : null);
  // An explicit username beats one inferred from a URL.
  const authorUsername = explicitUsername ?? usernameFromUrl(url);

  const text =
    str(field(record, "fullText", "full_text", "text")) ??
    str(field(record, "tweetText", "tweet_text"));

  const entities = entitiesFrom(record);
  const isRepost = Boolean(
    field(record, "retweeted", "retweetedStatus", "retweeted_status") ||
    (text && /^RT @/.test(text)),
  );

  // The archive gives a bookmark/like no timestamp of its own. Only a genuine
  // relationship timestamp is used; the post's creation time is not a
  // substitute for when the user acted on it.
  const relationshipTimestamp = toIso(
    field(record, "bookmarkedAt", "bookmarked_at", "likedAt", "liked_at"),
  );

  return {
    postId,
    canonicalUrl: canonicalUrl(postId, authorUsername),
    text,
    authorUsername,
    authorName:
      str(field(record, "name", "displayName", "display_name")) ?? null,
    createdAt: toIso(field(record, "createdAt", "created_at")),
    conversationId: str(field(record, "conversationId", "conversation_id")),
    replyToPostId: str(
      field(
        record,
        "inReplyToStatusId",
        "in_reply_to_status_id",
        "in_reply_to_status_id_str",
      ),
    ),
    quotedPostId: str(
      field(
        record,
        "quotedStatusId",
        "quoted_status_id",
        "quoted_status_id_str",
      ),
    ),
    hashtags: entities.hashtags,
    mentions: entities.mentions,
    externalUrls: entities.externalUrls,
    mediaUrls: mediaFrom(record),
    relationships: [
      {
        // Reposts arrive inside the user's own post history; classify them as
        // the share signal they are rather than authorship.
        type: relationship === "own_post" && isRepost ? "repost" : relationship,
        timestamp: relationshipTimestamp,
      },
    ],
    sourceFile,
  };
}
