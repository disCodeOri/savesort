import {
  analyzeExport,
  ImportAnalysisError,
  ImportFileError,
  type AnalysisResult,
} from "@/lib/data-import/analyze";
import { reconcileRecords } from "@/lib/data-import/reconcile";
import { MAX_BATCH_RECORDS } from "@/lib/data-import/schemas";
import type {
  ImportCategory,
  ImportPlatform,
  ReconciledItem,
} from "@/lib/data-import/types";

/**
 * Drives an import from the browser.
 *
 * The export is read locally and only the reconciled, allowlisted records are
 * sent. Work is split into bounded requests so no single call depends on a
 * long-lived connection, and server-side progress is persisted after every
 * batch — closing the tab loses at most the batch in flight, and re-uploading
 * the same file afterwards is idempotent.
 */

const BATCH_SIZE = MAX_BATCH_RECORDS;
const CLASSIFY_CHUNK = 8;
/** Stops a bug from turning the classification loop into an infinite one. */
const MAX_CLASSIFY_PASSES = 2_000;

export type ImportStage =
  "reading" | "merging" | "importing" | "classifying" | "done";

export interface ImportProgress {
  stage: ImportStage;
  itemsTotal: number;
  itemsProcessed: number;
}

export interface ImportSummary {
  importId: string;
  platform: ImportPlatform;
  itemsFound: number;
  itemsImported: number;
  created: number;
  updated: number;
  full: number;
  partial: number;
  referenceOnly: number;
  classified: number;
  insufficient: number;
  classificationFailed: number;
  embedded: number;
  unresolved: number;
  enrichedFromOtherFiles: number;
  filesProcessed: number;
  filesSkipped: number;
  byCategory: Partial<Record<ImportCategory, number>>;
  warnings: string[];
}

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const SAFE_ERROR = "The export could not be imported. Try again later.";

async function postJson(
  url: string,
  body: unknown,
  fetchImpl: FetchImplementation,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(SAFE_ERROR);
  }

  const parsed: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof parsed.error === "string"
        ? parsed.error
        : SAFE_ERROR;
    throw new Error(message);
  }
  return (parsed ?? {}) as Record<string, unknown>;
}

/**
 * Reads and inventories an export without importing anything.
 *
 * This is what the preview screen shows: the real categories and counts, taken
 * from the user's own file, before a single row leaves the device.
 */
export async function analyzeImportFile(
  file: File,
  forcedPlatform?: ImportPlatform,
): Promise<AnalysisResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return analyzeExport(file.name, bytes, forcedPlatform);
}

function toWireRecord(item: ReconciledItem) {
  return {
    platform: item.platform,
    contentKey: item.contentKey,
    contentType: item.contentType,
    sourceId: item.sourceId,
    canonicalUrl: item.canonicalUrl,
    originalUrl: item.originalUrl,
    title: item.title,
    titleSource: item.titleSource,
    rawText: item.rawText,
    userText: item.userText,
    author: item.author,
    community: item.community,
    sourceCreatedAt: item.sourceCreatedAt,
    sourceSavedAt: item.sourceSavedAt,
    sourceActedAt: item.sourceActedAt,
    externalUrl: item.externalUrl,
    categories: item.categories,
    sourceFiles: item.sourceFiles,
  };
}

export interface RunImportOptions {
  analysis: AnalysisResult;
  selected: ImportCategory[];
  /** Use unselected recognised files to add context to selected items. */
  crossReference: boolean;
  onProgress: (progress: ImportProgress) => void;
  fetchImpl?: FetchImplementation;
}

/**
 * Imports the selected categories from an analysed export.
 *
 * Runs in four bounded stages: reconcile locally, upload in batches, classify
 * in batches, finalise. Items become visible and keyword-searchable as soon as
 * their batch lands, well before classification finishes.
 */
export async function runDataImport(
  options: RunImportOptions,
): Promise<ImportSummary> {
  const { analysis, selected, onProgress } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  onProgress({ stage: "merging", itemsTotal: 0, itemsProcessed: 0 });

  const reconciled = reconcileRecords(analysis.records, {
    selected,
    crossReference: options.crossReference,
  });
  const items = reconciled.items;

  const detectedCategories: Record<string, number> = {};
  for (const dataset of analysis.datasets) {
    detectedCategories[dataset.category] = dataset.recordCount;
  }

  const started = await postJson(
    "/api/imports/start",
    {
      platform: analysis.platform,
      safeFilename: analysis.fileName,
      fileSizeBytes: analysis.fileSizeBytes,
      fileHash: analysis.fileHash,
      selectedCategories: selected,
      detectedCategories,
      itemsDetected: analysis.records.length,
      itemsSelected: items.length,
      filesDetected: analysis.filesDetected,
    },
    fetchImpl,
  );
  const importId = String(started.importId ?? "");
  if (!importId) throw new Error(SAFE_ERROR);

  const summary: ImportSummary = {
    importId,
    platform: analysis.platform,
    itemsFound: analysis.records.length,
    itemsImported: items.length,
    created: 0,
    updated: 0,
    full: 0,
    partial: 0,
    referenceOnly: 0,
    classified: 0,
    insufficient: 0,
    classificationFailed: 0,
    embedded: 0,
    unresolved: analysis.unresolvedRecords,
    enrichedFromOtherFiles: reconciled.enriched,
    filesProcessed: analysis.filesProcessed,
    filesSkipped: analysis.filesSkipped,
    byCategory: {},
    warnings: [...analysis.warnings],
  };

  for (const item of items) {
    for (const category of item.categories) {
      summary.byCategory[category] = (summary.byCategory[category] ?? 0) + 1;
    }
  }

  let failed = false;
  let pendingClassification = 0;

  for (let index = 0; index < items.length; index += BATCH_SIZE) {
    const batch = items.slice(index, index + BATCH_SIZE);
    onProgress({
      stage: "importing",
      itemsTotal: items.length,
      itemsProcessed: index,
    });

    try {
      const result = await postJson(
        "/api/imports/batch",
        { importId, records: batch.map(toWireRecord) },
        fetchImpl,
      );
      summary.created += Number(result.created ?? 0);
      summary.updated += Number(result.updated ?? 0);
      summary.full += Number(result.full ?? 0);
      summary.partial += Number(result.partial ?? 0);
      summary.referenceOnly += Number(result.referenceOnly ?? 0);
      summary.embedded += Number(result.embedded ?? 0);
      summary.insufficient += Number(result.classificationInsufficient ?? 0);
      pendingClassification += Number(result.classificationPending ?? 0);
    } catch {
      // One bad batch must not discard the batches that already landed.
      failed = true;
      summary.warnings.push("Some items could not be imported.");
      break;
    }
  }

  // Classification runs only over items that reached the server with real
  // text. Reference-only items were already settled as insufficient and cost
  // nothing here.
  if (!failed && pendingClassification > 0) {
    let processed = 0;
    for (let pass = 0; pass < MAX_CLASSIFY_PASSES; pass += 1) {
      onProgress({
        stage: "classifying",
        itemsTotal: pendingClassification,
        itemsProcessed: processed,
      });

      let result: Record<string, unknown>;
      try {
        result = await postJson(
          "/api/imports/classify",
          { importId, limit: CLASSIFY_CHUNK },
          fetchImpl,
        );
      } catch {
        // The import stands; only the enrichment stopped early.
        summary.warnings.push(
          "Some items could not be enriched for search. They are still saved and searchable by keyword.",
        );
        break;
      }

      summary.classified += Number(result.ready ?? 0);
      summary.insufficient += Number(result.insufficient ?? 0);
      summary.classificationFailed += Number(result.failed ?? 0);
      processed += Number(result.processed ?? 0);

      if (Number(result.processed ?? 0) === 0) break;
      if (Number(result.remaining ?? 0) === 0) break;
    }
  }

  const completed = await postJson(
    "/api/imports/complete",
    {
      importId,
      filesProcessed: analysis.filesProcessed,
      filesSkipped: analysis.filesSkipped,
      itemsUnresolved: analysis.unresolvedRecords,
      warnings: summary.warnings.slice(0, 100),
      failed,
    },
    fetchImpl,
  );
  void completed;

  onProgress({
    stage: "done",
    itemsTotal: items.length,
    itemsProcessed: items.length,
  });

  return summary;
}

export { ImportAnalysisError, ImportFileError };
export type { AnalysisResult };
