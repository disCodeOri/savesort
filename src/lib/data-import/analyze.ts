import {
  ImportFileError,
  readImportArchive,
  type ArchiveEntry,
} from "@/lib/data-import/archive";
import { parseCsv, type CsvTable } from "@/lib/data-import/csv";
import { isPrivacyExcluded, resolveCategory } from "@/lib/data-import/datasets";
import {
  detectPlatform,
  type PlatformDetection,
} from "@/lib/data-import/detect-platform";
import { parseGenericJson } from "@/lib/data-import/generic-parse";
import { IMPORT_LIMITS } from "@/lib/data-import/limits";
import { parseLinkedInTable } from "@/lib/data-import/linkedin/parse";
import { parseRedditTable } from "@/lib/data-import/reddit/parse";
import {
  CATEGORY_PLATFORM,
  SAVED_CATEGORIES,
  type DatasetSummary,
  type ImportCategory,
  type ImportFileReport,
  type ImportPlatform,
  type NormalizedRecord,
} from "@/lib/data-import/types";

/**
 * Inspects an export and reports what is in it, without writing anything.
 *
 * This is the step that makes the preview honest: the user sees the real
 * categories and the real counts from their own file before a single row
 * reaches the server. It runs entirely in the browser.
 */

export interface AnalysisResult {
  platform: ImportPlatform;
  fileName: string;
  fileSizeBytes: number;
  /** SHA-256 of the selected file, for repeat-import detection. */
  fileHash: string | null;
  datasets: DatasetSummary[];
  /** Categories pre-ticked in the UI: saved/bookmarked content. */
  defaultSelection: ImportCategory[];
  records: NormalizedRecord[];
  files: ImportFileReport[];
  filesDetected: number;
  filesProcessed: number;
  filesSkipped: number;
  unresolvedRecords: number;
  warnings: string[];
}

export class ImportAnalysisError extends Error {
  /** Set when detection could not choose between the two platforms. */
  readonly candidates: ImportPlatform[] | null;

  constructor(message: string, candidates: ImportPlatform[] | null = null) {
    super(message);
    this.name = "ImportAnalysisError";
    this.candidates = candidates;
  }
}

/** JSON exports wrap their rows in an array or a single keyed object. */
function jsonRows(text: string): Record<string, string>[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? Object.values(parsed as Record<string, unknown>).find(Array.isArray)
      : null;
  if (!Array.isArray(list)) return null;

  return list.slice(0, IMPORT_LIMITS.maxRowsPerFile).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      entry as Record<string, unknown>,
    )) {
      if (typeof value === "string" || typeof value === "number") {
        row[key] = String(value).slice(0, IMPORT_LIMITS.maxFieldCharacters);
      }
    }
    return [row];
  });
}

/**
 * Presents a JSON dataset through the same table interface as a CSV, so the
 * dataset rules and parsers need only one code path.
 */
function tableFrom(entry: ArchiveEntry): CsvTable | null {
  if (/\.(json|jsonl)$/i.test(entry.path)) {
    const rows = jsonRows(entry.text);
    if (!rows) return null;
    const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const table = parseCsv("");
    return {
      headers,
      normalizedHeaders: headers.map((header) =>
        header.toLowerCase().replace(/[^a-z0-9]/g, ""),
      ),
      rows,
      truncated: table.truncated,
    };
  }
  return parseCsv(entry.text);
}

function isParseableJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function isJsonPath(path: string): boolean {
  return /\.(json|jsonl)$/i.test(path);
}

function parseTable(
  platform: ImportPlatform,
  table: CsvTable,
  category: ImportCategory,
  path: string,
) {
  return platform === "reddit"
    ? parseRedditTable(table, category, path)
    : parseLinkedInTable(table, category, path);
}

/** SHA-256 of the raw file, used only to recognise a repeat upload. */
async function hashFile(data: Uint8Array): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const buffer = data.slice().buffer as ArrayBuffer;
    const digest = await subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/**
 * Reads and inventories an export.
 *
 * `forcedPlatform` is supplied only after the user has resolved an ambiguous
 * detection themselves; it is never guessed.
 */
export async function analyzeExport(
  fileName: string,
  data: Uint8Array,
  forcedPlatform?: ImportPlatform,
): Promise<AnalysisResult> {
  const archive = await readImportArchive(fileName, data);

  // Detection reads filenames plus a small sample of allowlisted text files.
  // Privacy-excluded datasets are never sampled and never opened.
  const readable = archive.entries.filter(
    (entry) => !isPrivacyExcluded(entry.path),
  );
  const detection: PlatformDetection = forcedPlatform
    ? {
        status: "detected",
        platform: forcedPlatform,
        confidence: Number.POSITIVE_INFINITY,
      }
    : detectPlatform(
        archive.entries.map((entry) => ({
          path: entry.path,
          sample: isPrivacyExcluded(entry.path)
            ? undefined
            : entry.text.slice(0, 4_000),
        })),
      );

  if (detection.status === "ambiguous") {
    throw new ImportAnalysisError(
      "This export could be from Reddit or LinkedIn. Choose which one it is.",
      detection.candidates,
    );
  }
  if (detection.status === "unknown") {
    throw new ImportAnalysisError(
      "We couldn't recognize this as a Reddit or LinkedIn data export.",
    );
  }

  const platform = detection.platform;
  const files: ImportFileReport[] = [...archive.skipped];
  const records: NormalizedRecord[] = [];
  const warnings = [...archive.warnings];
  let unresolvedRecords = 0;
  let filesProcessed = 0;
  let parseFailures = 0;

  for (const entry of readable) {
    const table = tableFrom(entry);
    const category = table
      ? resolveCategory(platform, entry.path, table)
      : null;

    if (table && category) {
      const parsed = parseTable(platform, table, category, entry.path);
      records.push(...parsed.records);
      unresolvedRecords += parsed.unresolved;
      filesProcessed += 1;
      if (table.truncated) {
        warnings.push("A very large file in this export was only partly read.");
      }

      files.push({
        path: entry.path,
        category,
        recordCount: parsed.records.length,
        status: "parsed",
      });

      if (records.length >= IMPORT_LIMITS.maxRecords) {
        warnings.push(
          "This export contained more records than GRAPPlin imports at once.",
        );
        break;
      }
      continue;
    }

    if (isJsonPath(entry.path)) {
      // A JSON file we cannot classify by shape gets one last pass: the
      // generic reader takes whatever it will honestly give up, routed through
      // the same platform normalizer the recognised files use.
      const recovered = parseGenericJson(platform, entry.text, entry.path);
      if (recovered.records.length > 0) {
        records.push(...recovered.records);
        unresolvedRecords += recovered.unresolved;
        filesProcessed += 1;
        files.push({
          path: entry.path,
          category: recovered.records[0]!.category,
          recordCount: recovered.records.length,
          status: "parsed",
          message: "Read from an unrecognised file layout.",
        });
        continue;
      }
      // Valid JSON that is simply not a dataset — a settings blob, a manifest
      // — is not a read failure and must not raise a warning.
      if (isParseableJson(entry.text)) continue;
    }

    if (!table) {
      parseFailures += 1;
      files.push({
        path: entry.path,
        category: null,
        recordCount: 0,
        status: "error",
        // Deliberately generic: an error must never echo file contents.
        message: "This file could not be read.",
      });
      continue;
    }

    // Recognised as readable but not as one of ours. Ignoring it silently is
    // what lets an export gain new datasets without breaking the importer.
  }

  if (filesProcessed === 0) {
    const label = platform === "reddit" ? "Reddit" : "LinkedIn";
    throw new ImportAnalysisError(
      `We found a ${label} export, but it doesn't contain any supported saved or activity data.`,
    );
  }
  if (parseFailures > 0) {
    warnings.push(
      "Most of your export was imported, but some records couldn't be read.",
    );
  }

  const byCategory = new Map<ImportCategory, DatasetSummary>();
  for (const record of records) {
    const summary = byCategory.get(record.category) ?? {
      category: record.category,
      recordCount: 0,
      sourceFiles: [],
    };
    summary.recordCount += 1;
    if (!summary.sourceFiles.includes(record.sourceFile)) {
      summary.sourceFiles.push(record.sourceFile);
    }
    byCategory.set(record.category, summary);
  }

  const datasets = [...byCategory.values()].filter(
    (summary) => CATEGORY_PLATFORM[summary.category] === platform,
  );

  return {
    platform,
    fileName,
    fileSizeBytes: data.byteLength,
    fileHash: await hashFile(data),
    datasets,
    // Saved content is ticked by default; everything else is opt-in so an
    // import does not sweep in an entire social-media history.
    defaultSelection: datasets
      .map((summary) => summary.category)
      .filter((category) => SAVED_CATEGORIES.includes(category)),
    records,
    files,
    filesDetected: archive.filesDetected,
    filesProcessed,
    filesSkipped: archive.skipped.length,
    unresolvedRecords,
    warnings,
  };
}

export { ImportFileError };
