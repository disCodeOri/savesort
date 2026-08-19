/**
 * The vocabulary shared by both platform importers.
 *
 * Everything downstream — reconciliation, persistence, classification, the
 * report — speaks in these terms, so adding a platform means writing a parser
 * that emits `NormalizedRecord` and nothing else has to change.
 */

export type ImportPlatform = "reddit" | "linkedin";

/**
 * What the user did with the thing, as the export describes it.
 *
 * Saved/bookmarked categories are listed first because they are the ones
 * selected by default; the rest are opt-in so importing does not sweep in an
 * entire social-media history.
 */
export type ImportCategory =
  // Reddit
  | "reddit_saved_post"
  | "reddit_saved_comment"
  | "reddit_upvoted_post"
  | "reddit_upvoted_comment"
  | "reddit_own_post"
  | "reddit_own_comment"
  // LinkedIn
  | "linkedin_saved_item"
  | "linkedin_saved_job"
  | "linkedin_reaction"
  | "linkedin_share"
  | "linkedin_comment"
  | "linkedin_article";

export const SAVED_CATEGORIES: ImportCategory[] = [
  "reddit_saved_post",
  "reddit_saved_comment",
  "linkedin_saved_item",
  "linkedin_saved_job",
];

export const CATEGORY_PLATFORM: Record<ImportCategory, ImportPlatform> = {
  reddit_saved_post: "reddit",
  reddit_saved_comment: "reddit",
  reddit_upvoted_post: "reddit",
  reddit_upvoted_comment: "reddit",
  reddit_own_post: "reddit",
  reddit_own_comment: "reddit",
  linkedin_saved_item: "linkedin",
  linkedin_saved_job: "linkedin",
  linkedin_reaction: "linkedin",
  linkedin_share: "linkedin",
  linkedin_comment: "linkedin",
  linkedin_article: "linkedin",
};

export const CATEGORY_LABELS: Record<ImportCategory, string> = {
  reddit_saved_post: "Saved posts",
  reddit_saved_comment: "Saved comments",
  reddit_upvoted_post: "Upvoted posts",
  reddit_upvoted_comment: "Upvoted comments",
  reddit_own_post: "Your posts",
  reddit_own_comment: "Your comments",
  linkedin_saved_item: "Saved items",
  linkedin_saved_job: "Saved jobs",
  linkedin_reaction: "Reactions",
  linkedin_share: "Shares",
  linkedin_comment: "Comments",
  linkedin_article: "Articles",
};

/** The kind of platform object a record points at, not what the user did. */
export type PlatformContentType =
  "post" | "comment" | "job" | "article" | "link";

export type ContentAvailability = "full" | "partial" | "reference_only";

/**
 * Where a title came from.
 *
 * Reddit permalinks embed a slugified title. Decoding it recovers real
 * information the export supplied, but it is lossy and must never be presented
 * as verbatim source text — hence the explicit provenance rather than a
 * silently populated `title`.
 */
export type TitleSource = "source" | "permalink_slug" | "fallback_label";

/**
 * One record as a single export file described it.
 *
 * Absent fields are `null`. Nothing here is ever inferred from a different
 * field, guessed, or filled in from the network.
 */
export interface NormalizedRecord {
  platform: ImportPlatform;
  category: ImportCategory;
  contentType: PlatformContentType;
  /**
   * Merge key. The strongest identity the export offered, in the order
   * documented in `matching.ts`. Records sharing a content key are the same
   * platform object and are merged; records that do not are never merged.
   */
  contentKey: string;
  /** The platform's own id, when the export supplies one. */
  sourceId: string | null;
  /** Deterministically derived permalink, already normalized. */
  canonicalUrl: string;
  /** The URL exactly as the export wrote it, for provenance. */
  originalUrl: string | null;
  title: string | null;
  titleSource: TitleSource | null;
  /** Verbatim platform content: the post body, the comment body, the article. */
  rawText: string | null;
  /** Text the USER wrote about this object, e.g. their own comment on it. */
  userText: string | null;
  author: string | null;
  /** Subreddit, LinkedIn company, or similar grouping. */
  community: string | null;
  /** When the platform object was created. */
  sourceCreatedAt: string | null;
  /** When the user saved it. Only ever set from a real "saved" timestamp. */
  sourceSavedAt: string | null;
  /** When the user reacted/voted/commented, if the export dates the action. */
  sourceActedAt: string | null;
  /** An off-platform link the post points at. */
  externalUrl: string | null;
  /** Parent post of a comment, as a content key. */
  parentContentKey: string | null;
  sourceFile: string;
}

/** One platform object after every contributing file has been merged. */
export interface ReconciledItem extends Omit<
  NormalizedRecord,
  "category" | "sourceFile"
> {
  categories: ImportCategory[];
  contentAvailability: ContentAvailability;
  sourceFiles: string[];
  /** Merge candidates that were too weak to act on, kept for the report. */
  unresolvedMatches: number;
}

export interface DatasetSummary {
  category: ImportCategory;
  recordCount: number;
  sourceFiles: string[];
}

export interface ImportFileReport {
  path: string;
  category: ImportCategory | null;
  recordCount: number;
  status: "parsed" | "skipped" | "error";
  message?: string;
}
