import { cell, type CsvRow, type CsvTable } from "@/lib/data-import/csv";
import {
  isThingId,
  parseRedditPermalink,
  redditCanonicalUrl,
  redditContentKey,
  resolveRedditUrl,
  stripThingPrefix,
  titleFromSlug,
} from "@/lib/data-import/reddit/urls";
import type { ImportCategory, NormalizedRecord } from "@/lib/data-import/types";

/**
 * Reads Reddit's official account export.
 *
 * The shape that matters most: `saved_posts.csv` and `saved_comments.csv`
 * contain an id and a permalink and NOTHING else — no title, no body, no
 * subreddit column, no saved date. That is not a parser failure, it is what
 * Reddit ships. The permalink itself carries the subreddit and a slugified
 * title, and `posts.csv` / `comments.csv` carry real bodies for anything the
 * user wrote themselves, so those are the only two sources of extra context —
 * both from inside the same upload.
 */

const CONTENT_LIMIT = 10_000;
const TITLE_LIMIT = 300;

function truncate(value: string | null, limit: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

/**
 * Reddit writes `2024-01-02 15:04:05 UTC` in export date columns, which
 * `Date` does not accept. Anything unparseable becomes null rather than a
 * guess.
 */
function toIso(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value
    .trim()
    .replace(/\s+UTC$/i, "Z")
    .replace(" ", "T");
  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  const fallback = new Date(value.trim());
  return Number.isNaN(fallback.valueOf()) ? null : fallback.toISOString();
}

/** An off-Reddit link a post points at. Rejects non-HTTP schemes outright. */
function externalUrl(value: string | null, canonical: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.toString() === canonical) return null;
    // A self-post's `url` column repeats the permalink; that is not external.
    if (
      /(^|\.)reddit\.com$/i.test(url.hostname) &&
      url.pathname.includes("/comments/")
    ) {
      return null;
    }
    return url.toString().slice(0, 2_000);
  } catch {
    return null;
  }
}

function subredditFrom(
  row: CsvRow,
  permalinkSubreddit: string | null,
): string | null {
  const explicit = cell(row, "subreddit", "subreddit_name_prefixed");
  const name =
    (explicit ?? permalinkSubreddit)?.replace(/^\/?r\//i, "") ?? null;
  return name && /^[A-Za-z0-9_]{1,30}$/.test(name) ? name : null;
}

const POST_CATEGORIES = new Set<ImportCategory>([
  "reddit_saved_post",
  "reddit_upvoted_post",
  "reddit_own_post",
]);

/**
 * Normalizes one export row.
 *
 * Returns null when no permalink resolves to a Reddit post — a row that cannot
 * be identified cannot be deduplicated, merged, or safely linked, so it is
 * counted as unresolved rather than imported under a fabricated URL.
 */
export function normalizeRedditRow(
  row: CsvRow,
  category: ImportCategory,
  sourceFile: string,
): NormalizedRecord | null {
  const permalinkValue =
    cell(row, "permalink", "link", "url", "post_url", "comment_url") ?? "";
  const parts = parseRedditPermalink(permalinkValue);

  const rawId = cell(row, "id");
  // Validated, not merely stripped: an unchecked id column would let a crafted
  // row put arbitrary text into a constructed permalink.
  const declaredId = rawId && isThingId(rawId) ? stripThingPrefix(rawId) : null;

  const expectsComment = !POST_CATEGORIES.has(category);
  // In `saved_comments.csv` the `id` column is the comment id and the
  // permalink already ends with it; when the permalink is truncated the id
  // column is the only thing naming the comment.
  const commentId = expectsComment ? (parts.commentId ?? declaredId) : null;
  const postId = parts.postId ?? (expectsComment ? null : declaredId);

  if (!postId) return null;
  if (expectsComment && !commentId) return null;

  let canonicalUrl: string;
  try {
    canonicalUrl = redditCanonicalUrl({
      subreddit: parts.subreddit,
      postId,
      slug: parts.slug,
      commentId,
    });
  } catch {
    return null;
  }

  const permalinkTitle = titleFromSlug(parts.slug);
  const sourceTitle = truncate(cell(row, "title"), TITLE_LIMIT);
  // A `title` column is verbatim; the slug is a lossy decoding of the
  // permalink. A comment has no title of its own, so the slug — which names
  // the parent post — is recorded as context, never as the comment's title.
  const title = sourceTitle ?? (commentId ? null : permalinkTitle);
  const titleSource = sourceTitle
    ? ("source" as const)
    : title
      ? ("permalink_slug" as const)
      : null;

  const body = truncate(cell(row, "body", "selftext", "text"), CONTENT_LIMIT);
  const isOwnContent =
    category === "reddit_own_post" || category === "reddit_own_comment";

  const parentPostId = commentId ? postId : null;
  const votedAt = toIso(cell(row, "date", "created", "timestamp"));

  return {
    platform: "reddit",
    category,
    contentType: commentId ? "comment" : "post",
    contentKey: redditContentKey({ postId, commentId }),
    sourceId: commentId ? `t1_${commentId}` : `t3_${postId}`,
    canonicalUrl,
    originalUrl: resolveRedditUrl(permalinkValue)?.toString() ?? null,
    title,
    titleSource,
    // A body is verbatim platform content whoever wrote it; when the export
    // credits it to the user it is still the text of that post or comment.
    rawText: body,
    userText: null,
    author: isOwnContent ? null : (cell(row, "author") ?? null),
    community: subredditFrom(row, parts.subreddit),
    sourceCreatedAt: isOwnContent ? votedAt : null,
    // Reddit's export dates no save. Leaving this null is the honest answer;
    // the import date is a GRAPPlin fact, not a Reddit one.
    sourceSavedAt: null,
    sourceActedAt:
      category === "reddit_upvoted_post" ||
      category === "reddit_upvoted_comment"
        ? votedAt
        : null,
    externalUrl: externalUrl(cell(row, "url"), canonicalUrl),
    parentContentKey: parentPostId
      ? redditContentKey({ postId: parentPostId })
      : null,
    sourceFile,
  };
}

/** Only upvotes are an interest signal; a downvote is the opposite of one. */
function isUpvote(row: CsvRow): boolean {
  const direction = cell(row, "direction", "vote")?.toLowerCase();
  return direction === "up" || direction === "upvote" || direction === "1";
}

export function parseRedditTable(
  table: CsvTable,
  category: ImportCategory,
  sourceFile: string,
): { records: NormalizedRecord[]; unresolved: number } {
  const records: NormalizedRecord[] = [];
  let unresolved = 0;

  const votes =
    category === "reddit_upvoted_post" || category === "reddit_upvoted_comment";

  for (const row of table.rows) {
    if (votes && !isUpvote(row)) continue;
    const record = normalizeRedditRow(row, category, sourceFile);
    if (record) records.push(record);
    else unresolved += 1;
  }

  return { records, unresolved };
}
