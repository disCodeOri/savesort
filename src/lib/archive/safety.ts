/**
 * Entry-level safety checks shared by every archive importer.
 *
 * The rules are identical whatever platform produced the ZIP, so they live in
 * one place rather than being re-derived per importer: a traversal check that
 * is subtly weaker in one copy is exactly the kind of bug that gets shipped.
 * Each importer supplies its own numeric budget, because a 4 GB X archive and
 * a 40 MB Reddit export have very different plausible sizes.
 */

export interface ArchiveEntryLimits {
  /** Any single entry larger than this is skipped rather than buffered. */
  maxEntryBytes: number;
  /** A zip bomb shows up as an implausible expansion factor. */
  maxCompressionRatio: number;
  /** Deeply nested paths are a traversal smell, not a real archive layout. */
  maxPathDepth: number;
  maxPathLength: number;
}

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
 * escaping the privacy allowlist by nesting a messages export under a path
 * that looks like a saved-items file.
 */
export function rejectEntryPathWith(
  path: string,
  limits: ArchiveEntryLimits,
): EntryRejection | null {
  if (path.length > limits.maxPathLength) return "path_too_long";
  // Backslashes are normalised first so a Windows-style traversal cannot slip
  // past a forward-slash-only check.
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return "absolute_path";
  if (/^[A-Za-z]:/.test(normalized)) return "absolute_path";
  const segments = normalized.split("/");
  if (segments.includes("..")) return "path_traversal";
  if (segments.length > limits.maxPathDepth) return "path_too_deep";
  return null;
}

export function rejectEntrySizeWith(
  compressedBytes: number,
  uncompressedBytes: number,
  limits: ArchiveEntryLimits,
): EntryRejection | null {
  if (uncompressedBytes > limits.maxEntryBytes) return "entry_too_large";
  // A tiny compressed payload claiming a huge expansion is the classic bomb
  // signature. Small files are exempt because their ratio is meaningless.
  if (
    compressedBytes > 1_024 &&
    uncompressedBytes / compressedBytes > limits.maxCompressionRatio
  ) {
    return "compression_ratio";
  }
  return null;
}

/** User-facing wording. Never names the offending path or its contents. */
export function describeRejection(rejection: EntryRejection): string {
  if (rejection === "path_traversal" || rejection === "absolute_path") {
    return "Skipped a file with an unsafe path.";
  }
  if (rejection === "path_too_long" || rejection === "path_too_deep") {
    return "Skipped a file with an unexpected path.";
  }
  if (rejection === "entry_too_large") {
    return "Skipped a file that was too large.";
  }
  return "Skipped a file that expanded unexpectedly.";
}
