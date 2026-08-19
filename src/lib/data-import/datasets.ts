import {
  cell,
  hasAnyColumn,
  hasColumns,
  type CsvTable,
} from "@/lib/data-import/csv";
import { parseRedditPermalink } from "@/lib/data-import/reddit/urls";
import type { ImportCategory, ImportPlatform } from "@/lib/data-import/types";

/**
 * Which files GRAPPlin will open, and which it refuses to touch.
 *
 * This is an allowlist, not a blocklist. A Reddit export contains private
 * messages, chat history, IP logs, linked identities and payment records; a
 * LinkedIn export contains connections, contacts, message history, login
 * records, ad-targeting inferences and the profile itself. None of that
 * belongs in a knowledge index and none of it should ever reach an AI model.
 *
 * Anything not explicitly recognised as content-bearing is never opened, so a
 * dataset either platform adds in future is excluded by default rather than
 * silently ingested.
 */

/**
 * Named for reviewability. The allowlist above already excludes all of these —
 * this list exists so the intent is auditable at a glance, and so a test can
 * assert none of them is ever read.
 */
export const PRIVACY_EXCLUDED_STEMS = [
  // Reddit
  "messages",
  "message_headers",
  "chat_history",
  "chat_message_headers",
  "ip_logs",
  "linked_identities",
  "linked_phone_number",
  "account_gender",
  "user_preferences",
  "friends",
  "payouts",
  "stripe",
  "subscriptions",
  "purchases",
  "persona",
  "sensitive_ads_preferences",
  "twitter",
  "checkfile",
  "drafts",
  // LinkedIn
  "connections",
  "contacts",
  "invitations",
  "profile",
  "positions",
  "education",
  "skills",
  "email_addresses",
  "phonenumbers",
  "logins",
  "security_challenges",
  "ad_targeting",
  "inferences_about_you",
  "registration",
  "devices",
  "endorsement_received_info",
  "endorsement_given_info",
  "recommendations_received",
  "recommendations_given",
  "search_queries",
  "job_applicant_saved_answers",
  "job_applications",
  "job_seeker_preferences",
  "member_follows",
  "company_follows",
  "rich_media",
  "events",
  "learning",
  "patents",
  "publications",
  "languages",
  "causes_you_care_about",
  "ads_clicked",
] as const;

interface DatasetRule {
  category: ImportCategory;
  /** Matched against the lower-cased basename without its extension. */
  patterns: RegExp[];
  /**
   * Confirms a match by column shape when the filename is ambiguous, and
   * rescues a match when the filename has drifted. Returns true only when the
   * table really looks like this dataset.
   */
  matchesShape(table: CsvTable): boolean;
}

/**
 * Whether the permalinks in a table point at posts or at comments.
 *
 * `saved_posts.csv` and `saved_comments.csv` have identical columns — both are
 * exactly `id,permalink` — so the column shape cannot tell them apart. The
 * permalinks can: a comment permalink carries a fourth path segment naming the
 * comment. Sampling a few rows is what lets a renamed file still be filed
 * correctly.
 *
 * Returns null when there is nothing to sample, so an empty dataset falls back
 * to whatever the filename said.
 */
function permalinkKind(table: CsvTable): "post" | "comment" | null {
  let posts = 0;
  let comments = 0;
  for (const row of table.rows.slice(0, 25)) {
    const value = cell(row, "permalink", "link", "url");
    if (!value) continue;
    const parts = parseRedditPermalink(value);
    if (!parts.postId) continue;
    if (parts.commentId) comments += 1;
    else posts += 1;
  }
  if (posts === 0 && comments === 0) return null;
  return comments > posts ? "comment" : "post";
}

const REDDIT_DATASETS: DatasetRule[] = [
  {
    category: "reddit_saved_post",
    patterns: [/^saved[_-]?posts?$/, /^saved[_-]?submissions?$/],
    // The real file is exactly `id,permalink`.
    matchesShape: (table) =>
      hasColumns(table, "permalink") &&
      !hasAnyColumn(table, "body", "direction") &&
      permalinkKind(table) !== "comment",
  },
  {
    category: "reddit_saved_comment",
    patterns: [/^saved[_-]?comments?$/],
    matchesShape: (table) =>
      hasColumns(table, "permalink") &&
      !hasAnyColumn(table, "body", "direction") &&
      permalinkKind(table) === "comment",
  },
  {
    category: "reddit_upvoted_post",
    patterns: [/^post[_-]?votes?$/, /^upvoted[_-]?posts?$/],
    matchesShape: (table) => hasColumns(table, "permalink", "direction"),
  },
  {
    category: "reddit_upvoted_comment",
    patterns: [/^comment[_-]?votes?$/, /^upvoted[_-]?comments?$/],
    matchesShape: (table) => hasColumns(table, "permalink", "direction"),
  },
  {
    category: "reddit_own_post",
    patterns: [/^posts?$/, /^submissions?$/],
    matchesShape: (table) =>
      hasColumns(table, "permalink") && hasAnyColumn(table, "title", "body"),
  },
  {
    category: "reddit_own_comment",
    patterns: [/^comments?$/],
    matchesShape: (table) =>
      hasColumns(table, "permalink", "body") && !hasColumns(table, "title"),
  },
];

const LINKEDIN_DATASETS: DatasetRule[] = [
  {
    category: "linkedin_saved_item",
    patterns: [/^saved[_ -]?items?$/, /^saved[_ -]?posts?$/],
    matchesShape: (table) =>
      hasAnyColumn(table, "savedItem", "savedItemUrl", "url", "link") &&
      !hasAnyColumn(table, "jobTitle", "companyName"),
  },
  {
    category: "linkedin_saved_job",
    patterns: [/^saved[_ -]?jobs?$/, /^jobs?[_ -]?saved$/],
    matchesShape: (table) => hasAnyColumn(table, "jobTitle", "companyName"),
  },
  {
    category: "linkedin_reaction",
    patterns: [/^reactions?$/, /^likes?$/],
    matchesShape: (table) =>
      hasAnyColumn(table, "link", "url") && hasAnyColumn(table, "type"),
  },
  {
    category: "linkedin_share",
    patterns: [/^shares?$/, /^posts?$/],
    matchesShape: (table) =>
      hasAnyColumn(table, "shareLink", "shareCommentary", "sharedUrl"),
  },
  {
    category: "linkedin_comment",
    patterns: [/^comments?$/],
    matchesShape: (table) => hasAnyColumn(table, "message", "comment"),
  },
  {
    category: "linkedin_article",
    patterns: [/^articles?$/],
    matchesShape: (table) =>
      hasAnyColumn(table, "content", "articleLink", "publishedDate", "title"),
  },
];

const DATASETS: Record<ImportPlatform, DatasetRule[]> = {
  reddit: REDDIT_DATASETS,
  linkedin: LINKEDIN_DATASETS,
};

/** `Reddit/exports/Saved_Posts.CSV` → `saved_posts`. */
export function basenameStem(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (
    base
      .replace(/\.(csv|json|jsonl|txt)$/i, "")
      .replace(/^﻿/, "")
      // A duplicate download picks up "(1)" or " copy"; that is not schema drift.
      .replace(/\s*\((\d+)\)\s*$/, "")
      .replace(/\s+copy$/i, "")
      .trim()
      .toLowerCase()
  );
}

export function isPrivacyExcluded(path: string): boolean {
  const stem = basenameStem(path).replace(/[ -]/g, "_");
  return PRIVACY_EXCLUDED_STEMS.some(
    (excluded) => stem === excluded || stem.startsWith(`${excluded}_`),
  );
}

/**
 * The category a file's NAME suggests, before it is opened.
 *
 * Returns every rule whose pattern matches, because `comments` is a real
 * dataset name on both platforms and `posts` is ambiguous within Reddit
 * itself. The shape check then decides.
 */
export function candidateCategories(
  platform: ImportPlatform,
  path: string,
): ImportCategory[] {
  const stem = basenameStem(path);
  return DATASETS[platform]
    .filter((rule) => rule.patterns.some((pattern) => pattern.test(stem)))
    .map((rule) => rule.category);
}

/**
 * Resolves a parsed file to one category.
 *
 * Filename is a hint, never the contract: a rule only wins if the table's
 * columns actually look like that dataset. When the filename has drifted
 * beyond recognition, every rule for the platform is tried on shape alone, so
 * a renamed `Saved_Items (1).csv` still imports.
 */
export function resolveCategory(
  platform: ImportPlatform,
  path: string,
  table: CsvTable,
): ImportCategory | null {
  if (table.headers.length === 0) return null;

  const named = candidateCategories(platform, path);
  // An empty dataset has no shape to check. When the filename named exactly
  // one rule, take its word for it rather than mis-filing a file with no rows.
  if (table.rows.length === 0 && named.length === 1) return named[0] ?? null;

  for (const rule of DATASETS[platform]) {
    if (named.includes(rule.category) && rule.matchesShape(table)) {
      return rule.category;
    }
  }

  // Filename gave nothing usable. Fall back to shape, but only when exactly
  // one rule claims the table — an ambiguous shape is left unrecognised
  // rather than guessed at.
  const byShape = DATASETS[platform].filter((rule) => rule.matchesShape(table));
  return byShape.length === 1 ? (byShape[0]?.category ?? null) : null;
}

/** Filenames that are strong evidence of a platform, weighted for detection. */
export const PLATFORM_MARKERS: Record<
  ImportPlatform,
  Array<{ pattern: RegExp; weight: number }>
> = {
  reddit: [
    { pattern: /^saved[_-]?posts?$/, weight: 3 },
    { pattern: /^saved[_-]?comments?$/, weight: 3 },
    { pattern: /^post[_-]?votes?$/, weight: 3 },
    { pattern: /^comment[_-]?votes?$/, weight: 3 },
    { pattern: /^subscribed[_-]?subreddits$/, weight: 3 },
    { pattern: /^approved[_-]?submitter[_-]?subreddits$/, weight: 3 },
    { pattern: /^moderated[_-]?subreddits$/, weight: 3 },
    { pattern: /^multireddits$/, weight: 3 },
    { pattern: /^gilded[_-]?content$/, weight: 2 },
    { pattern: /^hidden[_-]?posts$/, weight: 2 },
    { pattern: /^poll[_-]?votes$/, weight: 2 },
    { pattern: /^user[_-]?preferences$/, weight: 1 },
    { pattern: /^statistics$/, weight: 1 },
  ],
  linkedin: [
    { pattern: /^saved[_ -]?items?$/, weight: 3 },
    { pattern: /^saved[_ -]?jobs?$/, weight: 3 },
    { pattern: /^ad[_ -]?targeting$/, weight: 3 },
    { pattern: /^inferences[_ -]?about[_ -]?you$/, weight: 3 },
    { pattern: /^job[_ -]?seeker[_ -]?preferences$/, weight: 3 },
    { pattern: /^endorsement[_ -]?received[_ -]?info$/, weight: 3 },
    { pattern: /^security[_ -]?challenges$/, weight: 2 },
    { pattern: /^rich[_ -]?media$/, weight: 2 },
    { pattern: /^invitations$/, weight: 2 },
    { pattern: /^connections$/, weight: 2 },
    { pattern: /^reactions$/, weight: 1 },
    { pattern: /^shares$/, weight: 1 },
    { pattern: /^registration$/, weight: 1 },
  ],
};
