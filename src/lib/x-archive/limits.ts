import {
  describeRejection as describeEntryRejection,
  rejectEntryPathWith,
  rejectEntrySizeWith,
  type EntryRejection,
} from "@/lib/archive/safety";

/**
 * Guard rails for reading an untrusted X archive.
 *
 * The archive is read in the browser, so a malicious ZIP cannot write outside
 * a temp directory the way a server-side extract could. The remaining risks
 * are resource exhaustion and confusing the reader into reading the wrong
 * entry, which is what these limits and the path check address.
 *
 * The checks themselves live in `@/lib/archive/safety` so every importer runs
 * the same traversal and bomb logic; only the numbers are X-specific.
 */

export const ARCHIVE_LIMITS = {
  /** Refuse an archive we would not finish reading in reasonable time. */
  maxArchiveBytes: 4 * 1024 * 1024 * 1024,
  /** Any single entry larger than this is skipped rather than buffered. */
  maxEntryBytes: 64 * 1024 * 1024,
  /** Total bytes we are willing to decompress across the whole archive. */
  maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
  /** A zip bomb shows up as an implausible expansion factor. */
  maxCompressionRatio: 200,
  /** Deeply nested paths are a traversal smell, not a real archive layout. */
  maxPathDepth: 12,
  maxPathLength: 512,
  /** Content-bearing files we will actually open. */
  maxCandidateFiles: 2_000,
} as const;

export type { EntryRejection };

export function rejectEntryPath(path: string): EntryRejection | null {
  return rejectEntryPathWith(path, ARCHIVE_LIMITS);
}

export function rejectEntrySize(
  compressedBytes: number,
  uncompressedBytes: number,
): EntryRejection | null {
  return rejectEntrySizeWith(
    compressedBytes,
    uncompressedBytes,
    ARCHIVE_LIMITS,
  );
}

export function describeRejection(rejection: EntryRejection): string {
  return describeEntryRejection(rejection);
}
