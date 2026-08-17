import type { RedditSavedPost } from "@/lib/reddit/types";
import { buildSearchableText } from "@/lib/search/searchable-text";
import { normalizeUrl } from "@/lib/urls/normalize";

const REDDIT_ORIGIN = "https://www.reddit.com";
const MAX_CONTENT_LENGTH = 10_000;
const MAX_DESCRIPTION_LENGTH = 300;
const DELETED_AUTHORS = new Set(["[deleted]", "[removed]"]);

export interface RedditProviderMetadata {
  id: string;
  fullname: string;
  permalink: string;
  subreddit: string;
  subredditPrefixed: string;
  author: string;
  /** Outbound target of a link post; null for self posts. */
  linkUrl: string | null;
  flair: string | null;
  score: number;
  numComments: number;
  createdUtc: number;
  nsfw: boolean;
  isSelf: boolean;
  providerTags: string[];
}

export interface RedditProviderItem {
  url: string;
  normalized_url: string;
  source: "reddit";
  title: string;
  description: string | null;
  notes: null;
  content: string | null;
  author: string | null;
  thumbnail_url: string | null;
  tags: string[];
  metadata: { reddit: RedditProviderMetadata };
  searchable_text: string;
}

export interface RedditMergedItem extends Omit<
  RedditProviderItem,
  "notes" | "thumbnail_url"
> {
  notes: string | null;
  thumbnail_url: string | null;
  metadata: Record<string, unknown> & { reddit: RedditProviderMetadata };
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function selfText(post: RedditSavedPost): string | null {
  const text = post.selftext?.trim() ?? "";
  if (!text) return null;
  return text.slice(0, MAX_CONTENT_LENGTH);
}

function excerpt(text: string | null): string | null {
  if (!text) return null;
  const collapsed = collapse(text);
  if (!collapsed) return null;
  if (collapsed.length <= MAX_DESCRIPTION_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

/**
 * Reddit sends `self`, `default`, `nsfw`, or `spoiler` in `thumbnail` when
 * there is no image, so only real HTTP(S) links become a thumbnail.
 */
function thumbnailUrl(post: RedditSavedPost): string | null {
  if (!post.thumbnail) return null;
  try {
    const url = new URL(post.thumbnail);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The outbound link of a link post, when it points somewhere off Reddit. */
function linkUrl(post: RedditSavedPost, permalinkUrl: string): string | null {
  if (post.is_self || !post.url) return null;
  try {
    const url = new URL(post.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.toString() === permalinkUrl) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function author(post: RedditSavedPost): string | null {
  const name = post.author.trim();
  if (!name || DELETED_AUTHORS.has(name)) return null;
  return name;
}

function providerTags(post: RedditSavedPost): string[] {
  const flair = post.link_flair_text?.trim();
  return [
    ...new Set(
      [post.subreddit_name_prefixed, flair].filter((tag): tag is string =>
        Boolean(tag),
      ),
    ),
  ];
}

/** Resolves a listing permalink, refusing anything that escapes Reddit. */
function permalinkUrl(permalink: string): string {
  const resolved = new URL(permalink, REDDIT_ORIGIN);
  if (resolved.origin !== REDDIT_ORIGIN) {
    throw new Error("That saved post does not point at Reddit.");
  }
  return normalizeUrl(resolved.toString());
}

export function mapRedditSave(post: RedditSavedPost): RedditProviderItem {
  const url = permalinkUrl(post.permalink);
  const content = selfText(post);
  const tags = providerTags(post);
  const outboundUrl = linkUrl(post, url);
  const reddit: RedditProviderMetadata = {
    id: post.id,
    fullname: post.name,
    permalink: post.permalink,
    subreddit: post.subreddit,
    subredditPrefixed: post.subreddit_name_prefixed,
    author: post.author,
    linkUrl: outboundUrl,
    flair: post.link_flair_text?.trim() || null,
    score: post.score,
    numComments: post.num_comments,
    createdUtc: post.created_utc,
    nsfw: post.over_18,
    isSelf: post.is_self,
    providerTags: tags,
  };
  const item: RedditProviderItem = {
    url,
    normalized_url: url,
    source: "reddit",
    title: collapse(post.title) || post.permalink,
    description: excerpt(content) ?? outboundUrl,
    notes: null,
    content,
    author: author(post),
    thumbnail_url: thumbnailUrl(post),
    tags,
    metadata: { reddit },
    searchable_text: "",
  };
  item.searchable_text = buildSearchableText(item);
  return item;
}

/**
 * Keeps everything the user wrote themselves while refreshing the fields Reddit
 * owns, so re-running a sync never overwrites notes or hand-added tags.
 */
export function mergeRedditProviderItem(
  existing: {
    url: string;
    normalized_url: string;
    title: string | null;
    description: string | null;
    notes: string | null;
    content: string | null;
    author: string | null;
    thumbnail_url: string | null;
    tags: string[];
    metadata: Record<string, unknown>;
  },
  provider: RedditProviderItem,
): RedditMergedItem {
  const previous = existing.metadata.reddit;
  const oldProviderTags =
    previous &&
    typeof previous === "object" &&
    Array.isArray((previous as { providerTags?: unknown }).providerTags)
      ? (previous as { providerTags: unknown[] }).providerTags.filter(
          (tag): tag is string => typeof tag === "string",
        )
      : [];
  const userTags = existing.tags.filter(
    (tag) => !oldProviderTags.includes(tag),
  );
  const tags = [...new Set([...userTags, ...provider.tags])];
  const metadata = {
    ...existing.metadata,
    reddit: provider.metadata.reddit,
  } as RedditMergedItem["metadata"];
  const merged: RedditMergedItem = {
    ...provider,
    notes: existing.notes,
    thumbnail_url: existing.thumbnail_url ?? provider.thumbnail_url,
    tags,
    metadata,
    searchable_text: "",
  };
  merged.searchable_text = buildSearchableText(merged);
  return merged;
}
