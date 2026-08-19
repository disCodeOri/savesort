import type { Source } from "@/lib/sources/detect-source";

/**
 * What a URL can tell us before anything is fetched.
 *
 * A URL is not an opaque string. `reddit.com/r/rust/comments/abc123/why_async_is_hard`
 * already names a platform, a community, a stable post id and most of a title.
 * This registry is how that is harvested — deterministically, offline, and the
 * same way every time.
 *
 * Rules are ordered most-specific first. Named capture groups carry meaning:
 * `id`, `author`, `community` and `slug` are promoted to first-class fields;
 * every other named group is kept as a descriptor.
 */

export type UrlPlatform =
  | "reddit"
  | "linkedin"
  | "youtube"
  | "x"
  | "github"
  | "instagram"
  | "medium"
  | "substack"
  | "stackoverflow"
  | "hackernews"
  | "arxiv"
  | "wikipedia"
  | "npm"
  | "spotify"
  | "tiktok"
  | "notion"
  | "devto"
  | "web";

export type UrlContentType =
  | "post"
  | "comment"
  | "video"
  | "short"
  | "playlist"
  | "channel"
  | "article"
  | "repository"
  | "gist"
  | "issue"
  | "pull_request"
  | "profile"
  | "job"
  | "question"
  | "answer"
  | "paper"
  | "package"
  | "track"
  | "album"
  | "episode"
  | "document"
  | "file"
  | "image"
  | "search"
  | "home"
  | "unknown";

export interface UrlRule {
  contentType: UrlContentType;
  /** Matched against the decoded pathname. */
  pattern: RegExp;
  /** Query parameters to read, as descriptor name → parameter key. */
  params?: Record<string, string>;
  /** Which descriptor holds the stable content id, when it comes from a param. */
  idFrom?: string;
}

export interface PlatformRules {
  platform: UrlPlatform;
  /** How this platform maps onto GRAPPlin's existing source union. */
  source: Source;
  hosts: string[];
  rules: UrlRule[];
  /** Used when the host matches but no rule does. */
  fallback: UrlContentType;
}

export const PLATFORM_RULES: PlatformRules[] = [
  {
    platform: "reddit",
    source: "reddit",
    hosts: ["reddit.com", "redd.it"],
    fallback: "post",
    rules: [
      {
        contentType: "comment",
        pattern:
          /^\/r\/(?<community>[A-Za-z0-9_]+)\/comments\/(?<id>[a-z0-9]+)\/(?<slug>[^/]*)\/(?<commentId>[a-z0-9]+)/i,
      },
      {
        contentType: "post",
        pattern:
          /^\/r\/(?<community>[A-Za-z0-9_]+)\/comments\/(?<id>[a-z0-9]+)(?:\/(?<slug>[^/]+))?/i,
      },
      { contentType: "post", pattern: /^\/comments\/(?<id>[a-z0-9]+)/i },
      {
        contentType: "channel",
        pattern: /^\/r\/(?<community>[A-Za-z0-9_]+)\/?$/i,
      },
      {
        contentType: "profile",
        pattern: /^\/u(?:ser)?\/(?<author>[A-Za-z0-9_-]+)/i,
      },
    ],
  },
  {
    platform: "linkedin",
    source: "linkedin",
    hosts: ["linkedin.com"],
    fallback: "post",
    rules: [
      {
        contentType: "post",
        pattern:
          /^\/feed\/update\/urn:li:(?:activity|ugcPost|share):(?<id>\d+)/i,
      },
      {
        contentType: "post",
        pattern:
          /^\/posts\/(?<author>[A-Za-z0-9_-]+)_(?<slug>.*?)-activity-(?<id>\d+)/i,
      },
      { contentType: "job", pattern: /^\/jobs\/view\/(?<id>\d+)/i },
      { contentType: "article", pattern: /^\/pulse\/(?<slug>[^/]+)/i },
      {
        contentType: "profile",
        pattern: /^\/in\/(?<author>[A-Za-z0-9_-]+)/i,
      },
      {
        contentType: "channel",
        pattern: /^\/company\/(?<community>[A-Za-z0-9_-]+)/i,
      },
    ],
  },
  {
    platform: "youtube",
    source: "youtube",
    hosts: ["youtube.com", "youtu.be", "youtube-nocookie.com"],
    fallback: "video",
    rules: [
      {
        contentType: "video",
        pattern: /^\/watch/i,
        params: { id: "v", playlist: "list", startSeconds: "t" },
        idFrom: "id",
      },
      { contentType: "short", pattern: /^\/shorts\/(?<id>[\w-]{6,20})/i },
      { contentType: "video", pattern: /^\/embed\/(?<id>[\w-]{6,20})/i },
      {
        contentType: "playlist",
        pattern: /^\/playlist/i,
        params: { id: "list" },
        idFrom: "id",
      },
      { contentType: "channel", pattern: /^\/(?:@(?<author>[\w.-]+))/i },
      {
        contentType: "channel",
        pattern: /^\/(?:channel|c|user)\/(?<author>[\w.-]+)/i,
      },
      // youtu.be puts the video id straight in the path.
      { contentType: "video", pattern: /^\/(?<id>[\w-]{6,20})$/ },
    ],
  },
  {
    platform: "x",
    source: "x",
    hosts: ["x.com", "twitter.com"],
    fallback: "post",
    rules: [
      {
        contentType: "post",
        pattern: /^\/(?<author>[A-Za-z0-9_]{1,20})\/status(?:es)?\/(?<id>\d+)/i,
      },
      {
        contentType: "profile",
        pattern: /^\/(?<author>[A-Za-z0-9_]{1,20})\/?$/i,
      },
    ],
  },
  {
    platform: "github",
    source: "github",
    hosts: ["github.com", "gist.github.com"],
    fallback: "repository",
    rules: [
      {
        contentType: "issue",
        pattern:
          /^\/(?<author>[\w.-]+)\/(?<repository>[\w.-]+)\/issues\/(?<id>\d+)/i,
      },
      {
        contentType: "pull_request",
        pattern:
          /^\/(?<author>[\w.-]+)\/(?<repository>[\w.-]+)\/pull\/(?<id>\d+)/i,
      },
      {
        contentType: "file",
        pattern:
          /^\/(?<author>[\w.-]+)\/(?<repository>[\w.-]+)\/blob\/(?<ref>[^/]+)\/(?<path>.+)$/i,
      },
      {
        contentType: "document",
        pattern:
          /^\/(?<author>[\w.-]+)\/(?<repository>[\w.-]+)\/(?:wiki|discussions)\/(?<slug>[^/]+)/i,
      },
      {
        contentType: "repository",
        pattern: /^\/(?<author>[\w.-]+)\/(?<repository>[\w.-]+)\/?$/i,
      },
      { contentType: "profile", pattern: /^\/(?<author>[\w.-]+)\/?$/i },
    ],
  },
  {
    platform: "instagram",
    source: "instagram",
    hosts: ["instagram.com"],
    fallback: "post",
    rules: [
      { contentType: "post", pattern: /^\/p\/(?<id>[\w-]+)/i },
      { contentType: "video", pattern: /^\/reels?\/(?<id>[\w-]+)/i },
      { contentType: "profile", pattern: /^\/(?<author>[\w.]+)\/?$/i },
    ],
  },
  {
    platform: "stackoverflow",
    source: "website",
    hosts: [
      "stackoverflow.com",
      "superuser.com",
      "serverfault.com",
      "askubuntu.com",
      "stackexchange.com",
    ],
    fallback: "question",
    rules: [
      {
        contentType: "question",
        pattern: /^\/questions\/(?<id>\d+)(?:\/(?<slug>[^/]+))?/i,
      },
      { contentType: "answer", pattern: /^\/a\/(?<id>\d+)/i },
      { contentType: "question", pattern: /^\/q\/(?<id>\d+)/i },
      { contentType: "channel", pattern: /^\/tags\/(?<community>[^/]+)/i },
    ],
  },
  {
    platform: "hackernews",
    source: "website",
    hosts: ["news.ycombinator.com"],
    fallback: "post",
    rules: [
      {
        contentType: "post",
        pattern: /^\/item/i,
        params: { id: "id" },
        idFrom: "id",
      },
      {
        contentType: "profile",
        pattern: /^\/user/i,
        params: { author: "id" },
      },
    ],
  },
  {
    platform: "arxiv",
    source: "website",
    hosts: ["arxiv.org"],
    fallback: "paper",
    rules: [
      { contentType: "paper", pattern: /^\/abs\/(?<id>[\d.]+(?:v\d+)?)/i },
      { contentType: "paper", pattern: /^\/pdf\/(?<id>[\d.]+(?:v\d+)?)/i },
    ],
  },
  {
    platform: "wikipedia",
    source: "website",
    hosts: ["wikipedia.org", "wikimedia.org"],
    fallback: "article",
    rules: [{ contentType: "article", pattern: /^\/wiki\/(?<slug>[^/]+)/i }],
  },
  {
    platform: "medium",
    source: "website",
    hosts: ["medium.com"],
    fallback: "article",
    rules: [
      {
        contentType: "article",
        pattern: /^\/@(?<author>[\w.-]+)\/(?<slug>.+?)-(?<id>[a-f0-9]{8,})$/i,
      },
      {
        contentType: "article",
        pattern:
          /^\/(?:@(?<author>[\w.-]+)\/)?(?<slug>[^/]+?)-(?<id>[a-f0-9]{8,})$/i,
      },
      { contentType: "profile", pattern: /^\/@(?<author>[\w.-]+)\/?$/i },
    ],
  },
  {
    platform: "substack",
    source: "website",
    hosts: ["substack.com"],
    fallback: "article",
    rules: [{ contentType: "article", pattern: /^\/p\/(?<slug>[^/]+)/i }],
  },
  {
    platform: "devto",
    source: "website",
    hosts: ["dev.to"],
    fallback: "article",
    rules: [
      {
        contentType: "article",
        pattern: /^\/(?<author>[\w-]+)\/(?<slug>[^/]+)/i,
      },
    ],
  },
  {
    platform: "npm",
    source: "website",
    hosts: ["npmjs.com"],
    fallback: "package",
    rules: [{ contentType: "package", pattern: /^\/package\/(?<id>[^?]+)/i }],
  },
  {
    platform: "spotify",
    source: "website",
    hosts: ["open.spotify.com", "spotify.com"],
    fallback: "track",
    rules: [
      { contentType: "track", pattern: /^\/track\/(?<id>\w+)/i },
      { contentType: "album", pattern: /^\/album\/(?<id>\w+)/i },
      { contentType: "episode", pattern: /^\/episode\/(?<id>\w+)/i },
      { contentType: "playlist", pattern: /^\/playlist\/(?<id>\w+)/i },
    ],
  },
  {
    platform: "tiktok",
    source: "website",
    hosts: ["tiktok.com"],
    fallback: "video",
    rules: [
      {
        contentType: "video",
        pattern: /^\/@(?<author>[\w.-]+)\/video\/(?<id>\d+)/i,
      },
      { contentType: "profile", pattern: /^\/@(?<author>[\w.-]+)\/?$/i },
    ],
  },
  {
    platform: "notion",
    source: "website",
    hosts: ["notion.so", "notion.site"],
    fallback: "document",
    rules: [
      {
        contentType: "document",
        pattern:
          /^\/(?:(?<author>[\w-]+)\/)?(?<slug>.+?)-(?<id>[a-f0-9]{32})$/i,
      },
    ],
  },
];

/** File extensions worth recognising, mapped to what they represent. */
export const EXTENSION_TYPES: Record<string, UrlContentType> = {
  pdf: "document",
  doc: "document",
  docx: "document",
  ppt: "document",
  pptx: "document",
  xls: "document",
  xlsx: "document",
  csv: "document",
  txt: "document",
  md: "document",
  epub: "document",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  mp3: "episode",
  wav: "episode",
  m4a: "episode",
};

/**
 * Path segments that describe what a page is on an ordinary website.
 *
 * This is what lets `example.com/blog/2024/05/why-rust` be classified without
 * knowing anything about example.com.
 */
export const GENERIC_SEGMENT_TYPES: Array<[RegExp, UrlContentType]> = [
  [/^(?:blog|posts?|articles?|news|stories|story|essays?)$/i, "article"],
  [
    /^(?:docs?|documentation|guide|guides|manual|reference|handbook)$/i,
    "document",
  ],
  [/^(?:videos?|watch|episode|episodes)$/i, "video"],
  [/^(?:podcasts?|listen)$/i, "episode"],
  [/^(?:jobs?|careers?|vacancies)$/i, "job"],
  [/^(?:products?|shop|store|item)$/i, "document"],
  [/^(?:questions?|forum|thread|threads|discussion|discussions)$/i, "question"],
  [/^(?:papers?|research|publications?)$/i, "paper"],
  [/^(?:users?|profile|people|author|authors|@[\w.-]+)$/i, "profile"],
  [/^(?:search|find)$/i, "search"],
];
