import { cell, type CsvRow, type CsvTable } from "@/lib/data-import/csv";
import {
  authorHandleFrom,
  linkedInCanonicalUrl,
  linkedInContentKey,
  parseLinkedInUrl,
} from "@/lib/data-import/linkedin/urls";
import type {
  ImportCategory,
  NormalizedRecord,
  PlatformContentType,
} from "@/lib/data-import/types";

/**
 * Reads LinkedIn's official account export.
 *
 * `Saved_Items.csv` is a URL and a saved date. There is no title, no body, no
 * author — LinkedIn simply does not include them. An item that arrives that
 * way is a complete, valid record, not a failure, and it is stored as a
 * reference rather than being filled in from anywhere else.
 *
 * The one thing that CAN add context is another file in the same upload:
 * `Shares.csv` carries the text of posts the user wrote, `Comments.csv`
 * carries what the user said on someone else's post, `Reactions.csv` dates an
 * interaction. All three key on the same activity id, which is why a saved
 * item can gain real text without a single network request.
 */

const CONTENT_LIMIT = 10_000;
const TITLE_LIMIT = 300;

function truncate(value: string | null, limit: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

/** LinkedIn writes ISO-ish dates; anything unparseable becomes null. */
function toIso(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const direct = new Date(trimmed);
  if (!Number.isNaN(direct.valueOf())) return direct.toISOString();
  // `2024-05-12 09:31:04 UTC` appears in some datasets.
  const cleaned = trimmed.replace(/\s+UTC$/i, "Z").replace(" ", "T");
  const parsed = new Date(cleaned);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

/** The off-LinkedIn link a share points at. Non-HTTP schemes are refused. */
function externalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().slice(0, 2_000);
  } catch {
    return null;
  }
}

const CONTENT_TYPES: Record<ImportCategory, PlatformContentType> = {
  linkedin_saved_item: "post",
  linkedin_saved_job: "job",
  linkedin_reaction: "post",
  linkedin_share: "post",
  linkedin_comment: "post",
  linkedin_article: "article",
  reddit_saved_post: "post",
  reddit_saved_comment: "comment",
  reddit_upvoted_post: "post",
  reddit_upvoted_comment: "comment",
  reddit_own_post: "post",
  reddit_own_comment: "comment",
};

/** The URL column each dataset uses, in the order the exports have used them. */
const URL_COLUMNS: Partial<Record<ImportCategory, string[]>> = {
  linkedin_saved_item: ["savedItem", "savedItemUrl", "url", "link", "item"],
  linkedin_saved_job: ["jobUrl", "url", "link", "savedItem"],
  linkedin_reaction: ["link", "url"],
  linkedin_share: ["shareLink", "link", "url"],
  linkedin_comment: ["link", "url"],
  linkedin_article: ["articleLink", "link", "url", "permalink"],
};

/**
 * A saved job's title and company are genuine source fields — LinkedIn puts
 * them in the export — so they populate title and community directly.
 */
function jobFields(row: CsvRow): {
  title: string | null;
  company: string | null;
} {
  return {
    title: truncate(cell(row, "jobTitle", "title"), TITLE_LIMIT),
    company: truncate(cell(row, "companyName", "company"), TITLE_LIMIT),
  };
}

export function normalizeLinkedInRow(
  row: CsvRow,
  category: ImportCategory,
  sourceFile: string,
): NormalizedRecord | null {
  const columns = URL_COLUMNS[category] ?? ["url", "link"];
  const rawUrl = cell(row, ...columns);
  if (!rawUrl) return null;

  const canonicalUrl = linkedInCanonicalUrl(rawUrl);
  // A Saved Item pointing somewhere other than LinkedIn cannot be identified
  // as a LinkedIn object, so it is reported unresolved rather than imported
  // under a guessed identity.
  if (!canonicalUrl) return null;

  const parts = parseLinkedInUrl(canonicalUrl);
  const job = category === "linkedin_saved_job" ? jobFields(row) : null;

  const shareText =
    category === "linkedin_share"
      ? truncate(
          cell(row, "shareCommentary", "commentary", "text"),
          CONTENT_LIMIT,
        )
      : null;
  const articleText =
    category === "linkedin_article"
      ? truncate(cell(row, "content", "body", "text"), CONTENT_LIMIT)
      : null;
  // The user's own comment on someone else's post. It describes the post
  // without being the post, so it is kept separate from `rawText` and is never
  // presented as LinkedIn's content for that URL.
  const commentText =
    category === "linkedin_comment"
      ? truncate(cell(row, "message", "comment", "commentText"), CONTENT_LIMIT)
      : null;

  const title =
    job?.title ??
    (category === "linkedin_article"
      ? truncate(cell(row, "title"), TITLE_LIMIT)
      : null);

  const date = toIso(
    cell(row, "date", "savedDate", "savedAt", "publishedDate", "datePublished"),
  );

  const isSaved =
    category === "linkedin_saved_item" || category === "linkedin_saved_job";
  const isAuthored =
    category === "linkedin_share" || category === "linkedin_article";

  return {
    platform: "linkedin",
    category,
    contentType: CONTENT_TYPES[category],
    contentKey: linkedInContentKey(canonicalUrl),
    sourceId: parts.objectId,
    canonicalUrl,
    originalUrl: rawUrl.slice(0, 2_000),
    title,
    titleSource: title ? "source" : null,
    rawText: shareText ?? articleText,
    userText: commentText,
    author: authorHandleFrom(rawUrl),
    community: job?.company ?? null,
    // A share or article is dated by its publication; a saved item is dated by
    // the save. Conflating the two would misdate the whole library.
    sourceCreatedAt: isAuthored ? date : null,
    sourceSavedAt: isSaved ? date : null,
    sourceActedAt:
      category === "linkedin_reaction" || category === "linkedin_comment"
        ? date
        : null,
    externalUrl: externalUrl(cell(row, "sharedUrl", "externalUrl")),
    parentContentKey: null,
    sourceFile,
  };
}

export function parseLinkedInTable(
  table: CsvTable,
  category: ImportCategory,
  sourceFile: string,
): { records: NormalizedRecord[]; unresolved: number } {
  const records: NormalizedRecord[] = [];
  let unresolved = 0;

  for (const row of table.rows) {
    const record = normalizeLinkedInRow(row, category, sourceFile);
    if (record) records.push(record);
    else unresolved += 1;
  }

  return { records, unresolved };
}
