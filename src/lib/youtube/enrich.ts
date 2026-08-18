import "server-only";

import { embedDocument } from "@/lib/embeddings/gemini";
import { createAdminClient } from "@/lib/supabase/admin";
import { analyzeYouTubeVideo } from "@/lib/youtube/analysis";
import { buildEnrichedSearchableText } from "@/lib/youtube/map-video";

const DEFAULT_BATCH_SIZE = 3;
const INDEXING_ERROR = "Semantic indexing is temporarily unavailable.";

export interface EnrichmentProgress {
  /** Videos analysed in this call, whatever the outcome. */
  processed: number;
  ready: number;
  failed: number;
  unsupported: number;
  /** Videos still waiting after this batch. */
  remaining: number;
}

interface PendingRow {
  video_id: string;
  saved_item_id: string | null;
}

interface SavedItemRow {
  title: string | null;
  author: string | null;
  description: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
}

async function countPending(
  client: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<number> {
  const result = await client
    .from("youtube_videos")
    .select("video_id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("enrichment_status", "pending");
  if (result.error) throw new Error("Enrichment queue could not be read.");
  return result.count ?? 0;
}

/**
 * Analyses a small batch of imported-but-unanalysed videos.
 *
 * Deliberately batched and caller-driven rather than a background job: each
 * analysis is a slow multimodal model call, so the UI polls this and shows
 * progress instead of blocking the import behind it. Only rows still marked
 * 'pending' are picked up, which is what makes re-running it free.
 */
export async function enrichPendingVideos(
  userId: string,
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<EnrichmentProgress> {
  const client = createAdminClient();
  const pending = await client
    .from("youtube_videos")
    .select("video_id, saved_item_id")
    .eq("user_id", userId)
    .eq("enrichment_status", "pending")
    .limit(batchSize);
  if (pending.error) throw new Error("Enrichment queue could not be read.");

  const rows = (pending.data ?? []) as PendingRow[];
  const progress: EnrichmentProgress = {
    processed: 0,
    ready: 0,
    failed: 0,
    unsupported: 0,
    remaining: 0,
  };

  for (const row of rows) {
    const outcome = await analyzeYouTubeVideo(row.video_id);
    progress.processed += 1;

    if (outcome.status !== "ready") {
      progress[outcome.status === "unsupported" ? "unsupported" : "failed"] +=
        1;
      await client.rpc("apply_youtube_enrichment", {
        p_user_id: userId,
        p_video_id: row.video_id,
        p_content: null,
        p_searchable_text: null,
        p_embedding: null,
        p_indexing_status: null,
        p_status: outcome.status,
        p_error: outcome.error,
      });
      continue;
    }

    // Rebuild the searchable document around the analysis, then re-embed so
    // semantic search can match concepts the title never mentions.
    let searchableText = outcome.analysis;
    let embedding: string | null = null;
    let indexingStatus = "keyword_only";

    const item = await client
      .from("saved_items")
      .select("title, author, description, tags, metadata")
      .eq("id", row.saved_item_id ?? "")
      .maybeSingle();
    if (!item.error && item.data) {
      const saved = item.data as SavedItemRow;
      searchableText = buildEnrichedSearchableText(
        {
          title: saved.title,
          author: saved.author,
          description: saved.description,
          tags: saved.tags ?? [],
        },
        outcome.analysis,
      );
    }

    try {
      const embedded = await embedDocument(searchableText);
      if (embedded.embedding) {
        embedding = `[${embedded.embedding.join(",")}]`;
        indexingStatus = "ready";
      }
    } catch {
      // Keyword-only is an acceptable outcome; the analysis text is still
      // indexed by Postgres full-text search.
    }

    const applied = await client.rpc("apply_youtube_enrichment", {
      p_user_id: userId,
      p_video_id: row.video_id,
      p_content: outcome.analysis,
      p_searchable_text: searchableText,
      p_embedding: embedding,
      p_indexing_status: indexingStatus,
      p_status: "ready",
      p_error: embedding ? null : INDEXING_ERROR,
    });
    if (applied.error) {
      // The row stays pending, so the next batch retries it rather than
      // losing the analysis outcome entirely.
      progress.failed += 1;
      continue;
    }
    progress.ready += 1;
  }

  progress.remaining = await countPending(client, userId);
  return progress;
}
