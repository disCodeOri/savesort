import { unzip, type Unzipped, type UnzipFileInfo } from "fflate";

import {
  describeImportRejection,
  IMPORT_LIMITS,
  rejectImportEntryPath,
  rejectImportEntrySize,
} from "@/lib/data-import/limits";
import type { ImportFileReport } from "@/lib/data-import/types";

/**
 * Turns a selected file into a flat list of readable text entries.
 *
 * Handles the two things a user can plausibly pick: the ZIP the platform sent
 * them, or a single CSV/JSON they pulled out of it. Everything happens on the
 * user's machine — this module never uploads anything.
 *
 * Entries are vetted through fflate's `filter`, which runs against the ZIP
 * headers BEFORE anything is inflated. That ordering is the whole point: a
 * decompression bomb is refused while it is still a few kilobytes, rather than
 * after it has been expanded into the tab's memory.
 */

export interface ArchiveEntry {
  path: string;
  text: string;
}

export interface ReadArchiveResult {
  entries: ArchiveEntry[];
  filesDetected: number;
  skipped: ImportFileReport[];
  warnings: string[];
}

export class ImportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportFileError";
  }
}

const TEXT_EXTENSION = /\.(csv|json|jsonl|txt)$/i;
const NESTED_ARCHIVE = /\.(zip|gz|tar|7z|rar|bz2|xz)$/i;
/** Stored and deflate. Any other method in a text export is a red flag. */
const ALLOWED_COMPRESSION = new Set([0, 8]);

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export function looksLikeZip(data: Uint8Array): boolean {
  // "PK\x03\x04" local file header, or "PK\x05\x06" for an empty archive.
  return (
    data.byteLength >= 4 &&
    data[0] === 0x50 &&
    data[1] === 0x4b &&
    (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07)
  );
}

function unzipFiltered(
  data: Uint8Array,
  filter: (file: UnzipFileInfo) => boolean,
): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    unzip(data, { filter }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

/**
 * Decides whether one ZIP entry is safe to inflate.
 *
 * Runs on header metadata only. Rejections are recorded so the import report
 * can say something was skipped without ever naming what was in it.
 */
function vetEntry(
  file: UnzipFileInfo,
  state: { totalUncompressed: number; accepted: number },
  skipped: ImportFileReport[],
): boolean {
  const path = file.name;
  if (path.endsWith("/") || file.originalSize === 0) return false;

  const pathRejection = rejectImportEntryPath(path);
  if (pathRejection) {
    skipped.push({
      path,
      category: null,
      recordCount: 0,
      status: "skipped",
      message: describeImportRejection(pathRejection),
    });
    return false;
  }

  // A nested archive is never opened. Legitimate exports do not contain one,
  // and recursing into archives is how a bomb wins.
  if (NESTED_ARCHIVE.test(path)) {
    skipped.push({
      path,
      category: null,
      recordCount: 0,
      status: "skipped",
      message: "Skipped a nested archive.",
    });
    return false;
  }

  // Anything that is not a text dataset is not decoded at all. An export
  // contains no executables, so anything else is irrelevant or hostile.
  if (!TEXT_EXTENSION.test(path)) return false;

  if (!ALLOWED_COMPRESSION.has(file.compression)) {
    skipped.push({
      path,
      category: null,
      recordCount: 0,
      status: "skipped",
      message: "Skipped a file stored in an unsupported format.",
    });
    return false;
  }

  const sizeRejection = rejectImportEntrySize(file.size, file.originalSize);
  if (sizeRejection) {
    skipped.push({
      path,
      category: null,
      recordCount: 0,
      status: "skipped",
      message: describeImportRejection(sizeRejection),
    });
    return false;
  }

  if (
    state.totalUncompressed + file.originalSize >
    IMPORT_LIMITS.maxTotalUncompressedBytes
  ) {
    skipped.push({
      path,
      category: null,
      recordCount: 0,
      status: "skipped",
      message: "Skipped a file that would exceed the safe import size.",
    });
    return false;
  }
  if (state.accepted >= IMPORT_LIMITS.maxCandidateFiles) return false;

  state.totalUncompressed += file.originalSize;
  state.accepted += 1;
  return true;
}

export async function readImportArchive(
  fileName: string,
  data: Uint8Array,
): Promise<ReadArchiveResult> {
  if (data.byteLength > IMPORT_LIMITS.maxArchiveBytes) {
    throw new ImportFileError(
      "This export exceeds the safe import size for GRAPPlin.",
    );
  }
  if (data.byteLength === 0) throw new ImportFileError("That file is empty.");

  if (!looksLikeZip(data)) {
    // A standalone CSV or JSON pulled out of an export is a supported input.
    if (!TEXT_EXTENSION.test(fileName)) {
      throw new ImportFileError(
        "We couldn't recognize this as a Reddit or LinkedIn data export.",
      );
    }
    return {
      entries: [{ path: fileName, text: decode(data) }],
      filesDetected: 1,
      skipped: [],
      warnings: [],
    };
  }

  const skipped: ImportFileReport[] = [];
  const state = { totalUncompressed: 0, accepted: 0, seen: 0 };

  let unzipped: Unzipped;
  try {
    unzipped = await unzipFiltered(data, (file) => {
      if (!file.name.endsWith("/")) state.seen += 1;
      return vetEntry(file, state, skipped);
    });
  } catch {
    throw new ImportFileError(
      "This archive couldn't be read. Download a fresh copy and try again.",
    );
  }

  const entries: ArchiveEntry[] = Object.entries(unzipped)
    .filter(([, bytes]) => bytes.byteLength > 0)
    .map(([path, bytes]) => ({ path, text: decode(bytes) }));

  const warnings: string[] = [];
  if (state.accepted >= IMPORT_LIMITS.maxCandidateFiles) {
    warnings.push(
      "The export contained an unusual number of files; some were skipped.",
    );
  }

  if (entries.length === 0) {
    throw new ImportFileError(
      "We couldn't recognize this as a Reddit or LinkedIn data export.",
    );
  }

  return { entries, filesDetected: state.seen, skipped, warnings };
}
