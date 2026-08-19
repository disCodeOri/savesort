import { hasAnyColumn, hasColumns, parseCsv } from "@/lib/data-import/csv";
import { basenameStem, PLATFORM_MARKERS } from "@/lib/data-import/datasets";
import type { ImportPlatform } from "@/lib/data-import/types";

/**
 * Works out which platform produced an export.
 *
 * Never from a single signal. Reddit and LinkedIn both ship a `comments` file
 * and both ship a `posts`-shaped one, so a filename alone would happily
 * misfile one platform's archive as the other's — and any ZIP containing a
 * file called `comments.csv` would be claimed as an export. Detection scores
 * distinctive filenames across the whole archive, and falls back to column
 * shape when only one or two files are present.
 */

export type PlatformDetection =
  | { status: "detected"; platform: ImportPlatform; confidence: number }
  /** Both platforms scored; the caller must ask the user. */
  | { status: "ambiguous"; candidates: ImportPlatform[] }
  | { status: "unknown" };

/** The minimum score before a set of files is called a platform export. */
const MIN_SCORE = 3;

export interface DetectionFile {
  path: string;
  /** First bytes of the file, when the caller has already read it. */
  sample?: string;
}

function markerScore(platform: ImportPlatform, paths: string[]): number {
  const stems = new Set(paths.map(basenameStem));
  let score = 0;
  for (const marker of PLATFORM_MARKERS[platform]) {
    if ([...stems].some((stem) => marker.pattern.test(stem))) {
      score += marker.weight;
    }
  }
  return score;
}

/**
 * Column shapes unique enough to name a platform on their own.
 *
 * Used for a standalone CSV upload, where there is no archive layout to score.
 */
function shapeScore(platform: ImportPlatform, files: DetectionFile[]): number {
  let score = 0;
  for (const file of files) {
    if (!file.sample) continue;
    const table = parseCsv(file.sample, 20);
    if (table.headers.length === 0) continue;

    if (platform === "reddit") {
      // `id,permalink` with nothing else is the Reddit saved-items shape.
      if (hasColumns(table, "id", "permalink") && table.headers.length <= 3) {
        score += 3;
      }
      if (hasColumns(table, "permalink", "subreddit")) score += 3;
      if (hasColumns(table, "permalink", "direction")) score += 3;
    } else {
      if (hasAnyColumn(table, "savedItem", "savedItemUrl")) score += 3;
      if (hasAnyColumn(table, "shareCommentary", "shareLink", "sharedUrl")) {
        score += 3;
      }
      if (hasColumns(table, "jobTitle", "companyName")) score += 3;
    }
  }
  return score;
}

/** Reddit and LinkedIn URLs inside a sample are corroborating evidence. */
function urlScore(platform: ImportPlatform, files: DetectionFile[]): number {
  const domain =
    platform === "reddit"
      ? /https?:\/\/(?:[a-z0-9-]+\.)*reddit\.com\//i
      : /https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\//i;
  return files.some((file) => file.sample && domain.test(file.sample)) ? 2 : 0;
}

export function detectPlatform(files: DetectionFile[]): PlatformDetection {
  const paths = files.map((file) => file.path);

  const scores: Record<ImportPlatform, number> = {
    reddit:
      markerScore("reddit", paths) +
      shapeScore("reddit", files) +
      urlScore("reddit", files),
    linkedin:
      markerScore("linkedin", paths) +
      shapeScore("linkedin", files) +
      urlScore("linkedin", files),
  };

  const reddit = scores.reddit;
  const linkedin = scores.linkedin;

  if (reddit < MIN_SCORE && linkedin < MIN_SCORE) return { status: "unknown" };

  // A clear winner needs to be ahead, not merely tied. An archive that scores
  // for both is handed back to the user rather than guessed at.
  if (reddit >= MIN_SCORE && reddit > linkedin) {
    return { status: "detected", platform: "reddit", confidence: reddit };
  }
  if (linkedin >= MIN_SCORE && linkedin > reddit) {
    return { status: "detected", platform: "linkedin", confidence: linkedin };
  }
  return { status: "ambiguous", candidates: ["reddit", "linkedin"] };
}
