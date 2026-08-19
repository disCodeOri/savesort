import { readXArchive, ArchiveReadError } from "@/lib/x-archive/read-archive";
import { reconcileRecords } from "@/lib/x-archive/reconcile";

/**
 * Drives an archive import from the browser.
 *
 * The archive is read locally and only allowlisted, reconciled records are
 * sent. Batches are bounded so no single request depends on a long-lived
 * connection, and progress is persisted server-side after every batch, so
 * closing the tab loses at most the batch in flight.
 */

const BATCH_SIZE = 100;

export type ImportStage =
  "reading" | "analyzing" | "merging" | "importing" | "done";

export interface ImportProgress {
  stage: ImportStage;
  filesDetected: number;
  itemsTotal: number;
  itemsProcessed: number;
}

export interface ImportSummary {
  importId: string;
  itemsTotal: number;
  created: number;
  updated: number;
  relationships: number;
  embedded: number;
  referenceOnly: number;
  filesProcessed: number;
  filesSkipped: number;
  warnings: string[];
  byRelationship: Record<string, number>;
}

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const SAFE_ERROR = "The archive could not be imported. Try again later.";

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
 * Reads the archive, reconciles it, and uploads the result in batches.
 *
 * `onProgress` reports coarse stages rather than a percentage, because the
 * total item count is unknown until the archive has been read.
 */
export async function runArchiveImport(
  file: File,
  onProgress: (progress: ImportProgress) => void,
  fetchImpl: FetchImplementation = fetch,
): Promise<ImportSummary> {
  onProgress({
    stage: "reading",
    filesDetected: 0,
    itemsTotal: 0,
    itemsProcessed: 0,
  });

  const bytes = new Uint8Array(await file.arrayBuffer());

  let read;
  try {
    read = await readXArchive(bytes);
  } catch (error) {
    // ArchiveReadError messages are already user-facing and safe.
    throw error instanceof ArchiveReadError ? error : new Error(SAFE_ERROR);
  }

  onProgress({
    stage: "merging",
    filesDetected: read.filesDetected,
    itemsTotal: 0,
    itemsProcessed: 0,
  });

  // One post seen in several datasets becomes one item carrying several
  // relationships, before anything is uploaded.
  const items = reconcileRecords(read.records);

  const started = await postJson(
    "/api/x/archive/start",
    {
      archiveName: file.name,
      archiveSizeBytes: file.size,
      filesDetected: read.filesDetected,
      archiveUsername: read.accountUsername,
      archiveUserId: read.accountUserId,
    },
    fetchImpl,
  );
  const importId = String(started.importId ?? "");
  if (!importId) throw new Error(SAFE_ERROR);

  const summary: ImportSummary = {
    importId,
    itemsTotal: items.length,
    created: 0,
    updated: 0,
    relationships: 0,
    embedded: 0,
    referenceOnly: items.filter(
      (item) => item.contentAvailability === "reference_only",
    ).length,
    filesProcessed: read.filesProcessed,
    filesSkipped: read.filesSkipped,
    warnings: [...read.warnings],
    byRelationship: {},
  };

  for (const item of items) {
    for (const relationship of item.relationships) {
      summary.byRelationship[relationship.type] =
        (summary.byRelationship[relationship.type] ?? 0) + 1;
    }
  }

  let failed = false;
  for (let index = 0; index < items.length; index += BATCH_SIZE) {
    const batch = items.slice(index, index + BATCH_SIZE);
    onProgress({
      stage: "importing",
      filesDetected: read.filesDetected,
      itemsTotal: items.length,
      itemsProcessed: index,
    });

    try {
      const result = await postJson(
        "/api/x/archive/batch",
        {
          importId,
          records: batch.map((item) => ({
            postId: item.postId,
            canonicalUrl: item.canonicalUrl,
            text: item.text,
            authorUsername: item.authorUsername,
            authorName: item.authorName,
            createdAt: item.createdAt,
            conversationId: item.conversationId,
            replyToPostId: item.replyToPostId,
            quotedPostId: item.quotedPostId,
            hashtags: item.hashtags,
            mentions: item.mentions,
            externalUrls: item.externalUrls,
            mediaUrls: item.mediaUrls,
            relationships: item.relationships,
          })),
        },
        fetchImpl,
      );
      summary.created += Number(result.created ?? 0);
      summary.updated += Number(result.updated ?? 0);
      summary.relationships += Number(result.relationships ?? 0);
      summary.embedded += Number(result.embedded ?? 0);
    } catch {
      // One bad batch should not discard the batches that already landed.
      failed = true;
      summary.warnings.push("Some items could not be imported.");
      break;
    }
  }

  const completed = await postJson(
    "/api/x/archive/complete",
    {
      importId,
      filesProcessed: read.filesProcessed,
      filesSkipped: read.filesSkipped,
      recordsDiscovered: read.records.length,
      warnings: summary.warnings.slice(0, 100),
      failed,
    },
    fetchImpl,
  );
  void completed;

  onProgress({
    stage: "done",
    filesDetected: read.filesDetected,
    itemsTotal: items.length,
    itemsProcessed: items.length,
  });

  return summary;
}
