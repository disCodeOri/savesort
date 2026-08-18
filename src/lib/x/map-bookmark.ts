import { buildSearchableText } from "@/lib/search/searchable-text";
import { normalizeUrl, validateHttpUrl } from "@/lib/urls/normalize";
import type { XAccount, XMedia, XPost } from "@/lib/x/types";

const MAX_TITLE_LENGTH = 120;
const MAX_QUOTED_LENGTH = 1_000;

export interface XProviderMetadata {
  postId: string;
  authorId: string | null;
  authorUsername: string | null;
  authorName: string | null;
  /** X's post creation time — never the moment the user bookmarked it. */
  postedAt: string | null;
  lang: string | null;
  conversationId: string | null;
  outboundUrls: string[];
  mediaType: string | null;
  quotedPostId: string | null;
}

export interface XProviderItem {
  url: string;
  normalized_url: string;
  post_id: string;
  source: "x";
  title: string;
  description: string | null;
  content: string | null;
  author: string | null;
  thumbnail_url: string | null;
  tags: string[];
  metadata: { x: XProviderMetadata };
  searchable_text: string;
}

/** Canonical public permalink. Falls back to `i` when the author is unknown. */
export function xPostUrl(username: string | null, postId: string): string {
  return `https://x.com/${username ?? "i"}/status/${postId}`;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * A post has no title, so the first line doubles as one. The full text still
 * lives in content, so nothing is lost to search by truncating here.
 */
function titleFrom(text: string, postId: string): string {
  const collapsed = collapse(text);
  if (!collapsed) return `Post ${postId}`;
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

/**
 * Only http(s) links survive. X-supplied URLs are untrusted input, so they go
 * through the same validation as anything else before being stored.
 */
function safeOutboundUrls(urls: string[]): string[] {
  return urls.filter((url) => validateHttpUrl(url).ok);
}

function thumbnailFrom(
  post: XPost,
  mediaByKey: Map<string, XMedia>,
): {
  url: string | null;
  type: string | null;
  altText: string | null;
} {
  for (const key of post.mediaKeys) {
    const media = mediaByKey.get(key);
    if (!media) continue;
    const url = media.previewImageUrl;
    return {
      url: url && validateHttpUrl(url).ok ? url : null,
      type: media.type,
      altText: media.altText,
    };
  }
  return { url: null, type: null, altText: null };
}

/**
 * Maps a bookmarked post into a saved item.
 *
 * Quoted-post text is folded into the indexed body deliberately: a bookmark
 * like "this is exactly right" is unsearchable on its own, and the quoted post
 * arrives free in the same API response as an expansion.
 */
export function mapXBookmark(
  post: XPost,
  authorsById: Map<string, XAccount>,
  mediaByKey: Map<string, XMedia>,
  referencedPostsById: Map<string, XPost>,
): XProviderItem {
  const author = post.authorId
    ? (authorsById.get(post.authorId) ?? null)
    : null;
  const url = normalizeUrl(xPostUrl(author?.username ?? null, post.id));
  const media = thumbnailFrom(post, mediaByKey);
  const outboundUrls = safeOutboundUrls(post.urls);

  const quoted = post.referencedPostIds
    .map((id) => referencedPostsById.get(id))
    .find((entry): entry is XPost => Boolean(entry && entry.text));

  const bodyParts = [collapse(post.text)];
  if (media.altText) bodyParts.push(`Image: ${collapse(media.altText)}`);
  if (quoted) {
    const quotedAuthor = quoted.authorId
      ? authorsById.get(quoted.authorId)
      : undefined;
    const attribution = quotedAuthor
      ? `@${quotedAuthor.username}`
      : "quoted post";
    bodyParts.push(
      `Quoting ${attribution}: ${collapse(quoted.text).slice(0, MAX_QUOTED_LENGTH)}`,
    );
  }
  if (outboundUrls.length > 0)
    bodyParts.push(`Links: ${outboundUrls.join(" ")}`);

  const content = bodyParts.filter(Boolean).join("\n");
  const authorLabel = author
    ? `${author.name ?? author.username} (@${author.username})`
    : null;

  const item: XProviderItem = {
    url,
    normalized_url: url,
    post_id: post.id,
    source: "x",
    title: titleFrom(post.text, post.id),
    description: authorLabel,
    content,
    author: authorLabel,
    thumbnail_url: media.url,
    tags: [],
    metadata: {
      x: {
        postId: post.id,
        authorId: post.authorId,
        authorUsername: author?.username ?? null,
        authorName: author?.name ?? null,
        postedAt: post.createdAt,
        lang: post.lang,
        conversationId: post.conversationId,
        outboundUrls,
        mediaType: media.type,
        quotedPostId: quoted?.id ?? null,
      },
    },
    searchable_text: "",
  };
  item.searchable_text = buildSearchableText(item);
  return item;
}
