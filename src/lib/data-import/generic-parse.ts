import { normalizeHeader, type CsvRow } from "@/lib/data-import/csv";
import {
  readGenericJson,
  type GenericRecord,
} from "@/lib/data-import/json-records";
import { normalizeLinkedInRow } from "@/lib/data-import/linkedin/parse";
import { normalizeRedditRow } from "@/lib/data-import/reddit/parse";
import type {
  ImportCategory,
  ImportPlatform,
  NormalizedRecord,
} from "@/lib/data-import/types";

/**
 * The last resort for a file we do not recognise.
 *
 * When a JSON dataset matches no known column shape, the generic reader still
 * extracts whatever it honestly can, and this maps the result back through the
 * *same* platform normalizers the CSV path uses. That matters: identity,
 * canonical URLs and safety checks stay in one place, so a record recovered
 * this way lands on exactly the same `saved_items` row as one that arrived
 * through a recognised file.
 */

/**
 * Presents a generic record as a row the platform normalizers understand.
 *
 * Both key spellings are written because `cell()` looks up the normalized
 * header first and the raw name second.
 */
export function toSyntheticRow(record: GenericRecord): CsvRow {
  const row: CsvRow = {};

  const set = (key: string, value: string | null | undefined) => {
    if (!value) return;
    row[key] = value;
    row[normalizeHeader(key)] = value;
  };

  const url = record.url?.canonicalUrl ?? null;
  set("permalink", url);
  set("link", url);
  set("url", url);
  set("savedItem", url);
  set("shareLink", url);

  // A title decoded from a URL slug is not a `title` column. Passing it as one
  // would let the normalizer stamp it `titleSource: "source"`, which would be
  // a lie about where the words came from.
  if (!record.titleFromUrl) set("title", record.title);

  set("body", record.text);
  set("author", record.author);
  set("subreddit", record.community);
  set("companyName", record.community);
  set("date", record.date);
  set("savedDate", record.date);
  set("id", record.contentId);

  return row;
}

/**
 * The category a recovered record is filed under.
 *
 * Deliberately the platform's saved-items category: an unrecognised file in a
 * Reddit or LinkedIn export is far more likely to be a variant of the saved
 * dataset than of anything else, and filing it as saved content is the choice
 * a user would expect from a "saved data" import.
 */
const FALLBACK_CATEGORY: Record<ImportPlatform, ImportCategory> = {
  reddit: "reddit_saved_post",
  linkedin: "linkedin_saved_item",
};

export interface GenericParseResult {
  records: NormalizedRecord[];
  unresolved: number;
  /** Private fields the filter refused, for the import report. */
  droppedPrivateKeys: string[];
}

/**
 * Reads an unrecognised JSON dataset.
 *
 * Records whose URL does not resolve to the detected platform are counted as
 * unresolved rather than imported under a guessed identity — the same rule the
 * recognised parsers follow.
 */
export function parseGenericJson(
  platform: ImportPlatform,
  text: string,
  sourceFile: string,
): GenericParseResult {
  const { records: generic, droppedPrivateKeys } = readGenericJson(text);
  const category = FALLBACK_CATEGORY[platform];

  const records: NormalizedRecord[] = [];
  let unresolved = 0;

  for (const entry of generic) {
    const row = toSyntheticRow(entry);
    const normalized =
      platform === "reddit"
        ? normalizeRedditRow(row, category, sourceFile)
        : normalizeLinkedInRow(row, category, sourceFile);

    if (!normalized) {
      unresolved += 1;
      continue;
    }

    // The URL slug is a real recovery, but a lossy one, so it is attached with
    // its provenance rather than through the `title` column.
    if (entry.titleFromUrl && entry.title && !normalized.title) {
      normalized.title = entry.title;
      normalized.titleSource = "permalink_slug";
    }
    records.push(normalized);
  }

  return { records, unresolved, droppedPrivateKeys };
}
