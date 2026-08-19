/**
 * Guard rails for reading an untrusted archive.
 *
 * The archive is read in the browser, so a malicious ZIP cannot write outside
 * a temp directory the way a server-side extract could. The remaining risks
 * are resource exhaustion and confusing the reader into reading the wrong
 * entry, which is what these limits and the path check address.
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

export type EntryRejection =
  | "path_traversal"
  | "absolute_path"
  | "path_too_long"
  | "path_too_deep"
  | "entry_too_large"
  | "compression_ratio";

/**
 * Validates an entry path before it is used for anything.
 *
 * Even reading in-browser, a `..` entry would let a crafted archive
 * impersonate a file from a directory we treat differently — for instance
 * escaping the privacy allowlist by nesting a DM export under a path that
 * looks like a likes file.
 */
export function rejectEntryPath(path: string): EntryRejection | null {
  if (path.length > ARCHIVE_LIMITS.maxPathLength) return "path_too_long";
  // Backslashes are normalised first so a Windows-style traversal cannot slip
  // past a forward-slash-only check.
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return "absolute_path";
  if (/^[A-Za-z]:/.test(normalized)) return "absolute_path";
  const segments = normalized.split("/");
  if (segments.includes("..")) return "path_traversal";
  if (segments.length > ARCHIVE_LIMITS.maxPathDepth) return "path_too_deep";
  return null;
}

export function rejectEntrySize(
  compressedBytes: number,
  uncompressedBytes: number,
): EntryRejection | null {
  if (uncompressedBytes > ARCHIVE_LIMITS.maxEntryBytes)
    return "entry_too_large";
  // A tiny compressed payload claiming a huge expansion is the classic bomb
  // signature. Small files are exempt because their ratio is meaningless.
  if (
    compressedBytes > 1_024 &&
    uncompressedBytes / compressedBytes > ARCHIVE_LIMITS.maxCompressionRatio
  ) {
    return "compression_ratio";
  }
  return null;
}

export function describeRejection(rejection: EntryRejection): string {
  if (rejection === "path_traversal" || rejection === "absolute_path") {
    return "Skipped a file with an unsafe path.";
  }
  if (rejection === "path_too_long" || rejection === "path_too_deep") {
    return "Skipped a file with an unexpected path.";
  }
  if (rejection === "entry_too_large")
    return "Skipped a file that was too large.";
  return "Skipped a file that expanded unexpectedly.";
}
