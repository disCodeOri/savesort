import "server-only";

import { mapWithConcurrency } from "@/lib/async/concurrency";
import { embedDocument } from "@/lib/embeddings/gemini";
import { buildSearchableText } from "@/lib/search/searchable-text";
import { createAdminClient } from "@/lib/supabase/admin";
import { availabilityFor } from "@/lib/x-archive/normalize";
import type { ArchiveRecordInput } from "@/lib/x-archive/schemas";

const EMBEDDING_CONCURRENCY = 4;
const MAX_TITLE_LENGTH = 120;
const INDEXING_ERROR = "Semantic indexing is temporarily unavailable.";

export interface BatchResult {
  created: number;
  updated: number;
  relationships: number;
  embedded: number;
  skippedForAi: number;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function titleFrom(text: string | null, postId: string): string {
  const collapsed = text ? collapse(text) : "";
  if (!collapsed) return `Post ${postId}`;
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

function authorLabel(record: ArchiveRecordInput): string | null {
  if (!record.authorUsername) return record.authorName ?? null;
  return record.authorName
    ? `${record.authorName} (@${record.authorUsername})`
    : `@${record.authorUsername}`;
}

/**
 * Builds the indexed document. Hashtags and the author are included so a
 * search like "posts I liked from @someone" works even when the post body
 * never mentions them.
 */
function searchableFor(record: ArchiveRecordInput): string {
  if (!record.text) return "";
  return buildSearchableText({
    title: titleFrom(record.text, record.postId),
    source: "x",
    author: authorLabel(record),
    tags: record.hashtags,
    content: record.text,
  });
}

/**
 * Prepares one record for storage.
 *
 * Availability is recomputed from the text the server actually received, so a
 * client claiming a bare id is "full" still cannot trigger AI spend. Records
 * without meaningful text are stored as references and never embedded.
 */
async function prepareRecord(
  record: ArchiveRecordInput,
): Promise<{ row: Record<string, unknown>; embedded: boolean }> {
  const availability = availabilityFor(record.text ?? null);
  const searchableText = searchableFor(record);

  const metadata = {
    x: {
      postId: record.postId,
      authorUsername: record.authorUsername ?? null,
      authorName: record.authorName ?? null,
      // X's post creation time. Never presented as when the user saved it.
      postedAt: record.createdAt ?? null,
      conversationId: record.conversationId ?? null,
      replyToPostId: record.replyToPostId ?? null,
      quotedPostId: record.quotedPostId ?? null,
      hashtags: record.hashtags,
      mentions: record.mentions,
      outboundUrls: record.externalUrls,
      contentAvailability: availability,
      // Provenance is additive: an item may later gain x_api alongside this.
      provenance: ["x_archive"],
    },
  };

  const base = {
    post_id: record.postId,
    url: record.canonicalUrl,
    normalized_url: record.canonicalUrl,
    title: titleFrom(record.text ?? null, record.postId),
    description: authorLabel(record),
    content: record.text ?? null,
    author: authorLabel(record),
    thumbnail_url: record.mediaUrls[0] ?? null,
    content_availability: availability,
    metadata,
    relationships: record.relationships.map((entry) => ({
      type: entry.type,
      timestamp: entry.timestamp ?? null,
    })),
  };

  if (availability === "reference_only") {
    // A post id carries no meaning; embedding it would produce a confident
    // vector for nothing. Left pending so a later X API sync can enrich it.
    return {
      row: {
        ...base,
        searchable_text: searchableText,
        embedding: null,
        indexing_status: "pending",
        indexing_error: null,
      },
      embedded: false,
    };
  }

  try {
    const result = await embedDocument(searchableText);
    return {
      row: {
        ...base,
        searchable_text: searchableText,
        embedding: result.embedding ? `[${result.embedding.join(",")}]` : null,
        indexing_status: result.embedding ? "ready" : "keyword_only",
        indexing_error: result.embedding ? null : INDEXING_ERROR,
      },
      embedded: Boolean(result.embedding),
    };
  } catch {
    return {
      row: {
        ...base,
        searchable_text: searchableText,
        embedding: null,
        indexing_status: "keyword_only",
        indexing_error: INDEXING_ERROR,
      },
      embedded: false,
    };
  }
}

export async function startArchiveImport(
  userId: string,
  archiveName: string,
  archiveSizeBytes: number,
  filesDetected: number,
): Promise<string> {
  const client = createAdminClient();
  const result = await client.rpc("begin_x_archive_import", {
    p_user_id: userId,
    p_archive_name: archiveName,
    p_archive_size_bytes: archiveSizeBytes,
    p_files_detected: filesDetected,
  });
  if (result.error || !result.data) {
    throw new Error("The import could not be started.");
  }
  return result.data as string;
}

/**
 * Applies one batch of records.
 *
 * Embeddings are generated before the write so the whole batch lands in a
 * single RPC call, which keeps the transaction short and lets a failed batch
 * be retried without partial state.
 */
export async function applyArchiveBatch(
  userId: string,
  importId: string,
  records: ArchiveRecordInput[],
): Promise<BatchResult> {
  const prepared = await mapWithConcurrency(
    records,
    EMBEDDING_CONCURRENCY,
    prepareRecord,
  );

  const client = createAdminClient();
  const applied = await client.rpc("apply_x_archive_batch", {
    p_user_id: userId,
    p_import_id: importId,
    p_items: prepared.map((entry) => entry.row),
  });
  if (applied.error) {
    throw new Error("This batch could not be saved.");
  }

  const counts = (applied.data ?? {}) as {
    created?: number;
    updated?: number;
    relationships?: number;
  };
  const embedded = prepared.filter((entry) => entry.embedded).length;

  return {
    created: counts.created ?? 0,
    updated: counts.updated ?? 0,
    relationships: counts.relationships ?? 0,
    embedded,
    skippedForAi: prepared.length - embedded,
  };
}

export async function completeArchiveImport(
  userId: string,
  importId: string,
  summary: {
    filesProcessed: number;
    filesSkipped: number;
    recordsDiscovered: number;
    warnings: string[];
    failed: boolean;
  },
): Promise<void> {
  // A partial failure is still a useful import: warnings surface the skipped
  // files rather than discarding everything that succeeded.
  const status = summary.failed
    ? "failed"
    : summary.warnings.length > 0
      ? "completed_with_warnings"
      : "completed";

  const client = createAdminClient();
  const result = await client.rpc("complete_x_archive_import", {
    p_user_id: userId,
    p_import_id: importId,
    p_status: status,
    p_stage: summary.failed ? "failed" : "done",
    p_files_processed: summary.filesProcessed,
    p_files_skipped: summary.filesSkipped,
    p_records_discovered: summary.recordsDiscovered,
    p_warnings: summary.warnings,
    p_errors: [],
  });
  if (result.error) throw new Error("The import could not be finalised.");
}

export interface ArchiveImportStatus {
  importId: string;
  status: string;
  stage: string;
  archiveName: string | null;
  filesDetected: number;
  filesProcessed: number;
  filesSkipped: number;
  recordsDiscovered: number;
  recordsProcessed: number;
  contentCreated: number;
  contentUpdated: number;
  relationshipsCreated: number;
  duplicatesMerged: number;
  warnings: string[];
  startedAt: string;
  completedAt: string | null;
}

export async function getLatestImport(
  userId: string,
): Promise<ArchiveImportStatus | null> {
  const client = createAdminClient();
  const result = await client
    .from("x_archive_imports")
    .select(
      "id, status, stage, archive_name, files_detected, files_processed, files_skipped, records_discovered, records_processed, content_created, content_updated, relationships_created, duplicates_merged, warnings, started_at, completed_at",
    )
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (result.error) throw new Error("The import status could not be loaded.");
  if (!result.data) return null;

  const row = result.data as Record<string, unknown>;
  return {
    importId: String(row.id),
    status: String(row.status),
    stage: String(row.stage),
    archiveName: (row.archive_name as string | null) ?? null,
    filesDetected: Number(row.files_detected ?? 0),
    filesProcessed: Number(row.files_processed ?? 0),
    filesSkipped: Number(row.files_skipped ?? 0),
    recordsDiscovered: Number(row.records_discovered ?? 0),
    recordsProcessed: Number(row.records_processed ?? 0),
    contentCreated: Number(row.content_created ?? 0),
    contentUpdated: Number(row.content_updated ?? 0),
    relationshipsCreated: Number(row.relationships_created ?? 0),
    duplicatesMerged: Number(row.duplicates_merged ?? 0),
    warnings: Array.isArray(row.warnings) ? (row.warnings as string[]) : [],
    startedAt: String(row.started_at),
    completedAt: (row.completed_at as string | null) ?? null,
  };
}

/** Removes this import's relationships; shared content survives. */
export async function revertArchiveImport(
  userId: string,
  importId: string,
): Promise<{ relationshipsRemoved: number; itemsRemoved: number }> {
  const client = createAdminClient();
  const result = await client.rpc("revert_x_archive_import", {
    p_user_id: userId,
    p_import_id: importId,
  });
  if (result.error) throw new Error("The import could not be reverted.");

  const data = (result.data ?? {}) as {
    relationships_removed?: number;
    items_removed?: number;
  };
  return {
    relationshipsRemoved: data.relationships_removed ?? 0,
    itemsRemoved: data.items_removed ?? 0,
  };
}
