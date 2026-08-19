import {
  describeRejection as describeEntryRejection,
  rejectEntryPathWith,
  rejectEntrySizeWith,
  type EntryRejection,
} from "@/lib/archive/safety";

/**
 * Budgets for a Reddit or LinkedIn account export.
 *
 * These exports are text-only — CSV and JSON, no media — so a real one is a
 * few megabytes even for a decade-old account with a hundred thousand
 * comments. The ceilings are set generously above that so a legitimate export
 * always fits, while still refusing anything that could only be an attack or
 * a mis-selected file.
 */
export const IMPORT_LIMITS = {
  /** A whole account export, zipped. Real ones are single-digit megabytes. */
  maxArchiveBytes: 512 * 1024 * 1024,
  /** One dataset file. `comments.csv` is the largest in practice. */
  maxEntryBytes: 128 * 1024 * 1024,
  maxTotalUncompressedBytes: 768 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxPathDepth: 12,
  maxPathLength: 512,
  /** Files we are willing to open. Both exports ship well under 100. */
  maxCandidateFiles: 512,
  /** Rows read from a single dataset file. */
  maxRowsPerFile: 200_000,
  /** Characters kept from one CSV cell or JSON string. */
  maxFieldCharacters: 20_000,
  /** Records forwarded from one archive, across every selected category. */
  maxRecords: 100_000,
} as const;

export type { EntryRejection };

export function rejectImportEntryPath(path: string): EntryRejection | null {
  return rejectEntryPathWith(path, IMPORT_LIMITS);
}

export function rejectImportEntrySize(
  compressedBytes: number,
  uncompressedBytes: number,
): EntryRejection | null {
  return rejectEntrySizeWith(compressedBytes, uncompressedBytes, IMPORT_LIMITS);
}

export function describeImportRejection(rejection: EntryRejection): string {
  return describeEntryRejection(rejection);
}
