import "server-only";

import { mapWithConcurrency } from "@/lib/async/concurrency";
import type { Classification } from "@/lib/data-import/classification";
import {
  assessAvailability,
  collapseWhitespace,
  hasSufficientContentForAi,
} from "@/lib/data-import/content-quality";
import {
  PARSER_VERSION,
  type ImportRecordInput,
} from "@/lib/data-import/schemas";
import { CATEGORY_LABELS, type ImportCategory } from "@/lib/data-import/types";
import { embedDocument } from "@/lib/embeddings/gemini";
import { buildSearchableText } from "@/lib/search/searchable-text";
import { analyzeUrl, describeContentType } from "@/lib/urls/analyze";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Writes imported records into the canonical library.
 *
 * An imported record becomes an ordinary `saved_items` row: same table, same
 * generated tsvector, same pgvector column, same `hybrid_search_saved_items`.
 * There is deliberately no parallel index and no parallel search path.
 *
 * Everything cost- or safety-relevant is recomputed here from the text the
 * server actually received. A client claiming a bare URL is "full" cannot
 * trigger an embedding, because the claim is never read.
 */

const EMBEDDING_CONCURRENCY = 4;
const MAX_TITLE_LENGTH = 120;

export interface BatchResult {
  created: number;
  updated: number;
  embedded: number;
  full: number;
  partial: number;
  referenceOnly: number;
  classificationPending: number;
  classificationInsufficient: number;
}

function truncateTitle(value: string): string {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

/**
 * A neutral label for an item whose export carried no title.
 *
 * This is display chrome, not source content: it is written to `title` so the
 * card is not blank, and is deliberately excluded from the AI input and from
 * the raw content field, so nothing downstream can mistake it for something
 * the platform said.
 */
export function fallbackLabel(record: ImportRecordInput): string {
  if (record.platform === "reddit") {
    const kind = record.contentType === "comment" ? "comment" : "post";
    return record.community
      ? `Saved Reddit ${kind} in r/${record.community}`
      : `Saved Reddit ${kind}`;
  }
  if (record.contentType === "job") return "Saved LinkedIn job";
  if (record.contentType === "article") return "Saved LinkedIn article";
  return "Saved LinkedIn item";
}

function displayTitle(record: ImportRecordInput): string {
  return record.title ? truncateTitle(record.title) : fallbackLabel(record);
}

function categoryLabels(categories: string[]): string[] {
  return categories.map(
    (category) => CATEGORY_LABELS[category as ImportCategory] ?? category,
  );
}

/**
 * The one-line description under the title.
 *
 * Assembled only from things the export supplied, so a reference-only item
 * says what it genuinely is rather than pretending to a summary.
 */
export function describeRecord(record: ImportRecordInput): string | null {
  const parts = [
    record.community ? `r/${record.community}` : null,
    record.platform === "linkedin" && record.community
      ? record.community
      : null,
    record.author ? `by ${record.author}` : null,
    ...categoryLabels(record.categories),
  ].filter((part): part is string => Boolean(part));
  const unique = [...new Set(parts)];
  return unique.length > 0 ? unique.join(" · ").slice(0, 300) : null;
}

/**
 * Builds the document the search index actually sees.
 *
 * Generated summary, topics and keywords are included because that is what
 * makes a vague query land on an item whose own text never used those words.
 * They live alongside the source text in the index only — the source fields
 * themselves are never overwritten with model output.
 */
export function buildImportSearchableText(
  record: ImportRecordInput,
  classification: Classification | null,
): string {
  const content = [
    record.rawText,
    record.userText ? `The user's own comment: ${record.userText}` : null,
    classification?.summary ? `Summary: ${classification.summary}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");

  // The URL is often the only thing a reference-only record has. Its slug,
  // community and path words are real terms the user might search for, so they
  // are indexed even when the export supplied no text at all.
  const url = analyzeUrl(record.canonicalUrl);

  return buildSearchableText({
    // Only a real title is indexed. A fallback label would put the words
    // "saved linkedin item" into every reference-only document and make them
    // match each other.
    title: record.title ?? url.titleFromSlug,
    source: record.platform,
    author: record.author,
    description: [
      record.community ?? url.community,
      describeContentType(url.contentType),
      ...categoryLabels(record.categories),
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · "),
    // The indexed document's tag line, not the user's `tags` column: generated
    // retrieval terms are never written to `saved_items.tags`.
    tags: classification
      ? [...classification.topics, ...classification.keywords]
      : url.keywords,
    content,
  });
}

export function toClassificationInput(record: ImportRecordInput) {
  return {
    title: record.title,
    rawText: record.rawText,
    userText: record.userText,
    community: record.community,
    author: record.author,
    contentType: record.contentType,
  };
}

/**
 * Provenance for one imported item.
 *
 * A whitelist, not a dump of the row. Nothing from the export travels here
 * except the fields named, so an unrelated column a platform adds later cannot
 * leak personal data into the library.
 */
function buildMetadata(record: ImportRecordInput, importId: string) {
  const urlSignals = analyzeUrl(record.canonicalUrl);
  return {
    import: {
      method: `${record.platform}_export`,
      platform: record.platform,
      importId,
      parserVersion: PARSER_VERSION,
      contentAvailability: assessAvailability(record),
      sourceFiles: record.sourceFiles.slice(0, 20),
      // Present so a future, explicitly user-approved enrichment flow can find
      // the items that would benefit from it.
      canEnrichLater: assessAvailability(record) === "reference_only",
    },
    platform: {
      contentType: record.contentType,
      contentKey: record.contentKey,
      sourceId: record.sourceId,
      categories: record.categories,
      community: record.community,
      // The real title, kept separate from the display `title` column, which
      // may hold a neutral fallback label. Only this one is ever shown to the
      // classifier.
      sourceTitle: record.title,
      // The user's own words about this item, kept out of `content` so it can
      // never be mistaken for what the platform published.
      userText: record.userText,
      // Distinct timestamps kept distinct. A missing saved date stays missing
      // rather than borrowing the creation date or the import time.
      sourceCreatedAt: record.sourceCreatedAt,
      sourceSavedAt: record.sourceSavedAt,
      sourceActedAt: record.sourceActedAt,
      originalUrl: record.originalUrl,
      externalUrl: record.externalUrl,
      titleSource: record.titleSource,
      // Derived from the URL string alone — never fetched. Stored so content
      // type and keywords can become first-class filters later without
      // reprocessing every item.
      urlContentType: urlSignals.contentType,
      urlKeywords: urlSignals.keywords,
    },
  };
}

interface PreparedRow {
  row: Record<string, unknown>;
  embedded: boolean;
  availability: "full" | "partial" | "reference_only";
  classificationStatus: "pending" | "insufficient_content";
}

/**
 * Prepares one record for storage.
 *
 * Reference-only items are stored with whatever keyword text exists and are
 * marked `insufficient_content`: they are never embedded and never queued for
 * an AI call, because a URL and a date carry nothing to embed.
 */
async function prepareRecord(
  record: ImportRecordInput,
  importId: string,
): Promise<PreparedRow> {
  const availability = assessAvailability(record);
  const eligible = hasSufficientContentForAi(record);
  const searchableText = buildImportSearchableText(record, null);

  const base = {
    content_key: record.contentKey,
    url: record.canonicalUrl,
    normalized_url: record.canonicalUrl,
    title: displayTitle(record),
    description: describeRecord(record),
    // Only verbatim platform content. The user's own comment stays in
    // metadata and in the index; it is not the item's content.
    content: record.rawText,
    author: record.author,
    categories: record.categories,
    source_files: record.sourceFiles.slice(0, 20),
    content_availability: availability,
    classification_status: eligible ? "pending" : "insufficient_content",
    metadata: buildMetadata(record, importId),
    searchable_text: searchableText,
  };

  if (!eligible) {
    return {
      row: { ...base, embedding: null, indexing_status: "keyword_only" },
      embedded: false,
      availability,
      classificationStatus: "insufficient_content",
    };
  }

  try {
    const result = await embedDocument(searchableText);
    return {
      row: {
        ...base,
        embedding: result.embedding ? `[${result.embedding.join(",")}]` : null,
        indexing_status: result.embedding ? "ready" : "keyword_only",
      },
      embedded: Boolean(result.embedding),
      availability,
      classificationStatus: "pending",
    };
  } catch {
    // A failed embedding must not lose the item; keyword search still works.
    return {
      row: { ...base, embedding: null, indexing_status: "keyword_only" },
      embedded: false,
      availability,
      classificationStatus: "pending",
    };
  }
}

export interface StartImportOptions {
  platform: "reddit" | "linkedin";
  safeFilename: string;
  fileSizeBytes: number;
  fileHash: string | null;
  selectedCategories: string[];
  detectedCategories: Record<string, number>;
  itemsDetected: number;
  itemsSelected: number;
  filesDetected: number;
}

export async function startDataImport(
  userId: string,
  options: StartImportOptions,
): Promise<string> {
  const client = createAdminClient();
  const result = await client.rpc("begin_data_import", {
    p_user_id: userId,
    p_platform: options.platform,
    p_file_hash: options.fileHash,
    // Only the name, sanitised: a path from a client-supplied filename has no
    // business reaching the database.
    p_safe_filename: options.safeFilename.replace(/[\\/]/g, "_").slice(0, 255),
    p_file_size_bytes: options.fileSizeBytes,
    p_parser_version: PARSER_VERSION,
    p_selected_categories: options.selectedCategories,
    p_detected_categories: options.detectedCategories,
    p_items_detected: options.itemsDetected,
    p_items_selected: options.itemsSelected,
    p_files_detected: options.filesDetected,
  });
  if (result.error || !result.data) {
    throw new Error("The import could not be started.");
  }
  return result.data as string;
}

export async function applyImportBatch(
  userId: string,
  importId: string,
  records: ImportRecordInput[],
): Promise<BatchResult> {
  const prepared = await mapWithConcurrency(
    records,
    EMBEDDING_CONCURRENCY,
    (record) => prepareRecord(record, importId),
  );

  const client = createAdminClient();
  const applied = await client.rpc("apply_data_import_batch", {
    p_user_id: userId,
    p_import_id: importId,
    p_items: prepared.map((entry) => entry.row),
  });
  if (applied.error) throw new Error("This batch could not be saved.");

  const counts = (applied.data ?? {}) as {
    created?: number;
    updated?: number;
  };

  return {
    created: counts.created ?? 0,
    updated: counts.updated ?? 0,
    embedded: prepared.filter((entry) => entry.embedded).length,
    full: prepared.filter((entry) => entry.availability === "full").length,
    partial: prepared.filter((entry) => entry.availability === "partial")
      .length,
    referenceOnly: prepared.filter(
      (entry) => entry.availability === "reference_only",
    ).length,
    classificationPending: prepared.filter(
      (entry) => entry.classificationStatus === "pending",
    ).length,
    classificationInsufficient: prepared.filter(
      (entry) => entry.classificationStatus === "insufficient_content",
    ).length,
  };
}

export async function completeDataImport(
  userId: string,
  importId: string,
  summary: {
    filesProcessed: number;
    filesSkipped: number;
    itemsUnresolved: number;
    warnings: string[];
    failed: boolean;
    /** Classification still has work to do; the import is not finished yet. */
    classifying?: boolean;
  },
): Promise<void> {
  const status = summary.failed
    ? "failed"
    : summary.classifying
      ? "classifying"
      : summary.warnings.length > 0
        ? "completed_with_warnings"
        : "completed";

  const client = createAdminClient();
  const result = await client.rpc("complete_data_import", {
    p_user_id: userId,
    p_import_id: importId,
    p_status: status,
    p_stage: summary.failed
      ? "failed"
      : summary.classifying
        ? "classifying"
        : "done",
    p_files_processed: summary.filesProcessed,
    p_files_skipped: summary.filesSkipped,
    p_items_unresolved: summary.itemsUnresolved,
    p_warnings: summary.warnings.slice(0, 100),
    p_safe_error: summary.failed ? "Some records could not be imported." : null,
  });
  if (result.error) throw new Error("The import could not be finalised.");
}

export interface DataImportStatus {
  importId: string;
  platform: string;
  status: string;
  stage: string;
  safeFilename: string | null;
  selectedCategories: string[];
  detectedCategories: Record<string, number>;
  itemsDetected: number;
  itemsSelected: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsDuplicated: number;
  itemsUnresolved: number;
  fullCount: number;
  partialCount: number;
  referenceOnlyCount: number;
  classificationReady: number;
  classificationInsufficient: number;
  classificationFailed: number;
  filesProcessed: number;
  filesSkipped: number;
  warnings: string[];
  startedAt: string;
  completedAt: string | null;
}

const IMPORT_COLUMNS =
  "id, platform, status, stage, safe_filename, selected_categories, detected_categories, items_detected, items_selected, items_created, items_updated, items_duplicated, items_unresolved, full_count, partial_count, reference_only_count, classification_ready_count, classification_insufficient_count, classification_failed_count, files_processed, files_skipped, warnings, started_at, completed_at";

function toStatus(row: Record<string, unknown>): DataImportStatus {
  return {
    importId: String(row.id),
    platform: String(row.platform),
    status: String(row.status),
    stage: String(row.stage),
    safeFilename: (row.safe_filename as string | null) ?? null,
    selectedCategories: Array.isArray(row.selected_categories)
      ? (row.selected_categories as string[])
      : [],
    detectedCategories:
      row.detected_categories && typeof row.detected_categories === "object"
        ? (row.detected_categories as Record<string, number>)
        : {},
    itemsDetected: Number(row.items_detected ?? 0),
    itemsSelected: Number(row.items_selected ?? 0),
    itemsCreated: Number(row.items_created ?? 0),
    itemsUpdated: Number(row.items_updated ?? 0),
    itemsDuplicated: Number(row.items_duplicated ?? 0),
    itemsUnresolved: Number(row.items_unresolved ?? 0),
    fullCount: Number(row.full_count ?? 0),
    partialCount: Number(row.partial_count ?? 0),
    referenceOnlyCount: Number(row.reference_only_count ?? 0),
    classificationReady: Number(row.classification_ready_count ?? 0),
    classificationInsufficient: Number(
      row.classification_insufficient_count ?? 0,
    ),
    classificationFailed: Number(row.classification_failed_count ?? 0),
    filesProcessed: Number(row.files_processed ?? 0),
    filesSkipped: Number(row.files_skipped ?? 0),
    warnings: Array.isArray(row.warnings) ? (row.warnings as string[]) : [],
    startedAt: String(row.started_at),
    completedAt: (row.completed_at as string | null) ?? null,
  };
}

export async function getLatestImport(
  userId: string,
): Promise<DataImportStatus | null> {
  const client = createAdminClient();
  const result = await client
    .from("data_imports")
    .select(IMPORT_COLUMNS)
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (result.error) throw new Error("The import status could not be loaded.");
  return result.data ? toStatus(result.data as Record<string, unknown>) : null;
}

export async function getImport(
  userId: string,
  importId: string,
): Promise<DataImportStatus | null> {
  const client = createAdminClient();
  const result = await client
    .from("data_imports")
    .select(IMPORT_COLUMNS)
    // Ownership is enforced here as well as by RLS: the admin client bypasses
    // RLS, so one user must never be able to name another user's import id.
    .eq("user_id", userId)
    .eq("id", importId)
    .maybeSingle();
  if (result.error) throw new Error("The import status could not be loaded.");
  return result.data ? toStatus(result.data as Record<string, unknown>) : null;
}

export async function revertDataImport(
  userId: string,
  importId: string,
): Promise<{ recordsRemoved: number; itemsRemoved: number }> {
  const client = createAdminClient();
  const result = await client.rpc("revert_data_import", {
    p_user_id: userId,
    p_import_id: importId,
  });
  if (result.error) throw new Error("The import could not be removed.");

  const data = (result.data ?? {}) as {
    recordsRemoved?: number;
    itemsRemoved?: number;
  };
  return {
    recordsRemoved: data.recordsRemoved ?? 0,
    itemsRemoved: data.itemsRemoved ?? 0,
  };
}
