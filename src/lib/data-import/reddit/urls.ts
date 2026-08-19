import { normalizeUrl } from "@/lib/urls/normalize";

/**
 * Reddit identity and permalink handling.
 *
 * The canonical form produced here is deliberately identical to what the
 * Reddit OAuth sync produces in `mapRedditSave` — `normalizeUrl` applied to
 * `https://www.reddit.com` + the permalink path. That is what makes a post
 * arriving from both the connected account and an uploaded export collapse
 * onto a single `saved_items` row instead of duplicating.
 */

const REDDIT_ORIGIN = "https://www.reddit.com";
/** Base-36, as Reddit issues them. `t3_`/`t1_` prefixes are stripped first. */
const THING_ID = /^[a-z0-9]{1,13}$/i;

export interface RedditPermalinkParts {
  subreddit: string | null;
  postId: string | null;
  commentId: string | null;
  /** The slug segment, still in `some_post_title` form. */
  slug: string | null;
}

function isRedditHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "reddit.com" || host.endsWith(".reddit.com");
}

/**
 * Strips a `t3_`/`t1_` fullname prefix.
 *
 * Reddit's export writes bare ids in some columns and prefixed fullnames in
 * others; both name the same object, so identity has to ignore the prefix.
 */
export function stripThingPrefix(value: string): string {
  return value.trim().replace(/^t[1-6]_/i, "");
}

export function isThingId(value: string | null | undefined): boolean {
  return typeof value === "string" && THING_ID.test(stripThingPrefix(value));
}

/**
 * Resolves anything permalink-shaped to an absolute Reddit URL.
 *
 * Accepts the two forms exports use: a full URL, and a bare `/r/…` path.
 * Anything that resolves off Reddit is rejected rather than followed, so a
 * crafted row cannot smuggle an arbitrary destination into the library.
 */
export function resolveRedditUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = trimmed.startsWith("/")
      ? new URL(trimmed, REDDIT_ORIGIN)
      : new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!isRedditHost(url.hostname)) return null;
  return url;
}

/**
 * Pulls the parts out of a Reddit permalink path.
 *
 * Shapes handled:
 *   /r/<sub>/comments/<postId>/<slug>            → a post
 *   /r/<sub>/comments/<postId>/<slug>/<commentId> → a comment
 *   /comments/<postId>                            → a post, no subreddit
 */
export function parseRedditPermalink(value: string): RedditPermalinkParts {
  const empty: RedditPermalinkParts = {
    subreddit: null,
    postId: null,
    commentId: null,
    slug: null,
  };

  const url = resolveRedditUrl(value);
  if (!url) return empty;

  const segments = url.pathname.split("/").filter(Boolean);
  const commentsIndex = segments.indexOf("comments");
  if (commentsIndex < 0) return empty;

  const subreddit =
    segments[commentsIndex - 2] === "r"
      ? (segments[commentsIndex - 1] ?? null)
      : null;
  const postId = segments[commentsIndex + 1] ?? null;
  const slug = segments[commentsIndex + 2] ?? null;
  const commentId = segments[commentsIndex + 3] ?? null;

  return {
    subreddit:
      subreddit && /^[A-Za-z0-9_]{1,30}$/.test(subreddit) ? subreddit : null,
    postId: postId && isThingId(postId) ? stripThingPrefix(postId) : null,
    // A slug is free text; keep it only when it looks like a slug.
    slug: slug && /^[A-Za-z0-9_\-%]{1,300}$/.test(slug) ? slug : null,
    commentId:
      commentId && isThingId(commentId) ? stripThingPrefix(commentId) : null,
  };
}

/**
 * The canonical permalink GRAPPlin keys on.
 *
 * Built from ids the export supplied — never invented. The slug is included
 * when known because Reddit's own permalinks carry it and dropping it would
 * make an export-sourced URL differ from the OAuth-sourced one for the same
 * post.
 */
export function redditCanonicalUrl(parts: {
  subreddit: string | null;
  postId: string;
  slug?: string | null;
  commentId?: string | null;
}): string {
  const path = [
    parts.subreddit ? `r/${parts.subreddit}` : null,
    "comments",
    parts.postId,
    parts.slug ?? null,
    parts.commentId ?? null,
  ]
    .filter((segment): segment is string => Boolean(segment))
    .join("/");
  return normalizeUrl(`${REDDIT_ORIGIN}/${path}`);
}

/**
 * Turns a permalink slug back into readable words.
 *
 * The slug genuinely comes from the export — it is part of the permalink
 * string Reddit wrote — so this recovers information rather than inventing it.
 * It is lossy (lower-cased, punctuation dropped, sometimes truncated), which
 * is why callers must record `titleSource: "permalink_slug"` and never present
 * the result as verbatim source text.
 */
export function titleFromSlug(slug: string | null): string | null {
  if (!slug) return null;
  let decoded = slug;
  try {
    decoded = decodeURIComponent(slug);
  } catch {
    // A malformed escape sequence is not worth failing a row over.
  }
  const words = decoded.replace(/[_+]+/g, " ").replace(/\s+/g, " ").trim();
  if (words.length < 3 || !/[a-z]/i.test(words)) return null;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The merge key for a Reddit object.
 *
 * A comment key includes the post id so two comments with coincidentally
 * similar ids on different posts can never collide.
 */
export function redditContentKey(parts: {
  postId: string;
  commentId?: string | null;
}): string {
  return parts.commentId
    ? `reddit:t1_${parts.commentId}:${parts.postId}`
    : `reddit:t3_${parts.postId}`;
}
