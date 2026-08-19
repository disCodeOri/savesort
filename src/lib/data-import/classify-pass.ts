import "server-only";

import {
  classifyImportedItem,
  type Classification,
  type ClassificationInput,
} from "@/lib/data-import/classification";
import { hasSufficientContentForAi } from "@/lib/data-import/content-quality";
import { CATEGORY_LABELS, type ImportCategory } from "@/lib/data-import/types";
import { embedDocument } from "@/lib/embeddings/gemini";
import { buildSearchableText } from "@/lib/search/searchable-text";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * One bounded pass of classification and re-indexing.
 *
 * Deliberately separate from the import itself. Items are already in the
 * library and already keyword-searchable before this runs, so a slow or
 * failing model never blocks, delays, or undoes the import — it only means
 * some items are less findable by vague description until a later pass.
 *
 * The client calls this repeatedly until `remaining` reaches zero, which keeps
 * every request short and makes the whole stage resumable after a reload
 * without any queue infrastructure.
 */

const CLASSIFY_CONCURRENCY = 2;

export interface ClassifyPassResult {
  processed: number;
  ready: number;
  insufficient: number;
  failed: number;
  /** Records still pending after this pass. */
  remaining: number;
}

interface PendingRecord {
  contentKey: string;
  platform: string;
  savedItemId: string | null;
}

interface SavedItemRow {
  id: string;
  title: string | null;
  content: string | null;
  author: string | null;
  metadata: Record<string, unknown>;
}

function platformMetadata(item: SavedItemRow): Record<string, unknown> {
  const platform = item.metadata?.platform;
  return platform && typeof platform === "object"
    ? (platform as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Rebuilds the model input from stored provenance.
 *
 * `sourceTitle` is used rather than the `title` column, because the column may
 * hold a neutral display label like "Saved LinkedIn item". Feeding that to the
 * classifier would let a made-up label be treated as source text.
 */
export function classificationInputFor(
  item: SavedItemRow,
): ClassificationInput {
  const platform = platformMetadata(item);
  return {
    title: text(platform.sourceTitle),
    rawText: item.content,
    userText: text(platform.userText),
    community: text(platform.community),
    author: item.author,
    contentType: String(platform.contentType ?? "post"),
  };
}

/**
 * Classifies up to `limit` pending records for one import.
 *
 * Ownership is checked twice: the import must belong to the caller, and every
 * row read or written is scoped to their user id even though the admin client
 * bypasses RLS.
 */
export async function runClassificationPass(
  userId: string,
  importId: string,
  limit: number,
): Promise<ClassifyPassResult> {
  const client = createAdminClient();

  const owned = await client
    .from("data_imports")
    .select("id, platform")
    .eq("user_id", userId)
    .eq("id", importId)
    .maybeSingle();
  if (owned.error || !owned.data) throw new Error("Import not found.");
  const source = String((owned.data as { platform: string }).platform);

  const pendingResult = await client
    .from("data_import_records")
    .select("content_key, platform, saved_item_id")
    .eq("user_id", userId)
    .eq("import_id", importId)
    .eq("classification_status", "pending")
    .limit(limit);
  if (pendingResult.error)
    throw new Error("The import could not be continued.");

  const pending: PendingRecord[] = (pendingResult.data ?? []).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      contentKey: String(record.content_key),
      platform: String(record.platform),
      savedItemId: (record.saved_item_id as string | null) ?? null,
    };
  });

  const result: ClassifyPassResult = {
    processed: 0,
    ready: 0,
    insufficient: 0,
    failed: 0,
    remaining: 0,
  };
  if (pending.length === 0) return result;

  const itemIds = pending
    .map((record) => record.savedItemId)
    .filter((id): id is string => Boolean(id));
  const itemsResult = itemIds.length
    ? await client
        .from("saved_items")
        .select("id, title, content, author, metadata")
        .eq("user_id", userId)
        .in("id", itemIds)
    : { data: [], error: null };
  if (itemsResult.error) throw new Error("The import could not be continued.");

  const byId = new Map<string, SavedItemRow>(
    (itemsResult.data ?? []).map((row) => {
      const item = row as unknown as SavedItemRow;
      return [item.id, item];
    }),
  );

  const outcomes = await mapPending(
    pending,
    byId,
    source,
    client,
    userId,
    importId,
  );
  for (const outcome of outcomes) {
    result.processed += 1;
    if (outcome === "ready") result.ready += 1;
    else if (outcome === "insufficient_content") result.insufficient += 1;
    else result.failed += 1;
  }

  const remainingResult = await client
    .from("data_import_records")
    .select("content_key", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("import_id", importId)
    .eq("classification_status", "pending");
  result.remaining = remainingResult.count ?? 0;

  return result;
}

type Outcome = "ready" | "insufficient_content" | "failed";

async function mapPending(
  pending: PendingRecord[],
  byId: Map<string, SavedItemRow>,
  source: string,
  client: ReturnType<typeof createAdminClient>,
  userId: string,
  importId: string,
): Promise<Outcome[]> {
  const results: Outcome[] = new Array(pending.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < pending.length) {
      const index = next;
      next += 1;
      const record = pending[index]!;
      results[index] = await classifyOne(
        record,
        byId,
        source,
        client,
        userId,
        importId,
      );
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(CLASSIFY_CONCURRENCY, pending.length) },
      worker,
    ),
  );
  return results;
}

async function classifyOne(
  record: PendingRecord,
  byId: Map<string, SavedItemRow>,
  source: string,
  client: ReturnType<typeof createAdminClient>,
  userId: string,
  importId: string,
): Promise<Outcome> {
  const item = record.savedItemId ? byId.get(record.savedItemId) : undefined;
  if (!item) {
    await recordOutcome(
      client,
      userId,
      importId,
      record,
      "failed",
      "Item not found.",
    );
    return "failed";
  }

  const input = classificationInputFor(item);
  // Re-checked here, not trusted from the import: this is the only place that
  // decides whether an API call happens.
  if (!hasSufficientContentForAi(input)) {
    await recordOutcome(
      client,
      userId,
      importId,
      record,
      "insufficient_content",
      null,
    );
    return "insufficient_content";
  }

  const outcome = await classifyImportedItem(input);
  if (outcome.status !== "ready") {
    // The item keeps its keyword-searchable text; only the enrichment failed.
    await recordOutcome(
      client,
      userId,
      importId,
      record,
      "failed",
      outcome.status === "failed" ? outcome.error : null,
    );
    return "failed";
  }

  const searchableText = searchableTextWithSource(
    item,
    input,
    outcome.classification,
    source,
  );
  const embedded = await embedDocument(searchableText);

  const update = await client
    .from("saved_items")
    .update({
      searchable_text: searchableText,
      // Generated output lives under its own key. Source fields — title,
      // content, author — are never touched by the classifier.
      metadata: { ...item.metadata, generated: outcome.classification },
      ...(embedded.embedding
        ? {
            embedding: `[${embedded.embedding.join(",")}]`,
            indexing_status: "ready",
            indexing_error: null,
          }
        : { indexing_status: "keyword_only", indexing_error: embedded.error }),
    })
    .eq("id", item.id)
    .eq("user_id", userId);
  if (update.error) {
    await recordOutcome(client, userId, importId, record, "failed", null);
    return "failed";
  }

  await recordOutcome(client, userId, importId, record, "ready", null);
  return "ready";
}

/** The indexed document, rebuilt to include the generated retrieval terms. */
export function searchableTextWithSource(
  item: SavedItemRow,
  input: ClassificationInput,
  classification: Classification,
  source: string,
): string {
  const platform = platformMetadata(item);
  const categories = Array.isArray(platform.categories)
    ? (platform.categories as string[]).map(
        (category) => CATEGORY_LABELS[category as ImportCategory] ?? category,
      )
    : [];

  const content = [
    input.rawText,
    input.userText ? `The user's own comment: ${input.userText}` : null,
    classification.summary ? `Summary: ${classification.summary}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");

  return buildSearchableText({
    title: input.title,
    source,
    author: input.author,
    description: [input.community, ...categories]
      .filter((part): part is string => Boolean(part))
      .join(" · "),
    tags: [...classification.topics, ...classification.keywords],
    content,
  });
}

async function recordOutcome(
  client: ReturnType<typeof createAdminClient>,
  userId: string,
  importId: string,
  record: PendingRecord,
  status: Outcome,
  error: string | null,
): Promise<void> {
  await client.rpc("record_data_import_classification", {
    p_user_id: userId,
    p_import_id: importId,
    p_content_key: record.contentKey,
    p_platform: record.platform,
    p_status: status,
    p_error: error,
  });
}
