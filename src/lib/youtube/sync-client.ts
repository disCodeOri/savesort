export type YouTubeSyncProgress =
  | {
      status: "running";
      syncId: string;
      nextPage: number;
      discoveredCount: number;
      savedCount: number;
      skippedCount: number;
    }
  | {
      status:
        | "complete"
        | "not_connected"
        | "reconnect_required"
        | "no_playlists"
        | "failed";
      discoveredCount: number;
      savedCount: number;
      skippedCount: number;
    };

export interface EnrichmentProgress {
  processed: number;
  ready: number;
  failed: number;
  unsupported: number;
  remaining: number;
}

type SyncRequest = { action: "start" } | { action: "continue"; syncId: string };

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const MAX_CONTINUATION_RESPONSES = 1_000;
const MAX_ENRICHMENT_BATCHES = 400;
const SAFE_SYNC_ERROR =
  "YouTube sync is temporarily unavailable. Try again later.";

function isProgress(value: unknown): value is YouTubeSyncProgress {
  if (!value || typeof value !== "object") return false;
  const progress = value as Partial<YouTubeSyncProgress>;
  if (
    typeof progress.discoveredCount !== "number" ||
    typeof progress.savedCount !== "number" ||
    typeof progress.skippedCount !== "number"
  ) {
    return false;
  }
  if (progress.status === "running") {
    return (
      typeof progress.syncId === "string" &&
      typeof progress.nextPage === "number"
    );
  }
  return [
    "complete",
    "not_connected",
    "reconnect_required",
    "no_playlists",
    "failed",
  ].includes(progress.status ?? "");
}

function safeErrorMessage(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "error" in value &&
    typeof value.error === "string"
  ) {
    return value.error;
  }
  return SAFE_SYNC_ERROR;
}

async function postSyncRequest(
  request: SyncRequest,
  fetchImpl: FetchImplementation,
): Promise<YouTubeSyncProgress> {
  let response: Response;
  try {
    response = await fetchImpl("/api/youtube/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    throw new Error(SAFE_SYNC_ERROR);
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(safeErrorMessage(body));
  if (!isProgress(body)) throw new Error(SAFE_SYNC_ERROR);
  return body;
}

/** Imports playlist metadata, page by page, until the selection is exhausted. */
export async function runYouTubeSync(
  onProgress: (progress: YouTubeSyncProgress) => void,
  fetchImpl: FetchImplementation = fetch,
): Promise<YouTubeSyncProgress> {
  let request: SyncRequest = { action: "start" };
  let continuationResponses = 0;

  while (true) {
    const progress = await postSyncRequest(request, fetchImpl);
    onProgress(progress);

    if (progress.status !== "running") return progress;
    if (continuationResponses >= MAX_CONTINUATION_RESPONSES) {
      throw new Error("YouTube sync did not finish.");
    }

    continuationResponses += 1;
    request = { action: "continue", syncId: progress.syncId };
  }
}

function isEnrichment(value: unknown): value is EnrichmentProgress {
  if (!value || typeof value !== "object") return false;
  const progress = value as Partial<EnrichmentProgress>;
  return (
    typeof progress.processed === "number" &&
    typeof progress.remaining === "number"
  );
}

/**
 * Drains the analysis queue in batches. Stops as soon as a batch reports no
 * remaining work, or makes no progress — which is what prevents an endlessly
 * failing video from looping forever.
 */
export async function runYouTubeEnrichment(
  onProgress: (progress: EnrichmentProgress) => void,
  fetchImpl: FetchImplementation = fetch,
): Promise<EnrichmentProgress> {
  let last: EnrichmentProgress = {
    processed: 0,
    ready: 0,
    failed: 0,
    unsupported: 0,
    remaining: 0,
  };

  for (let batch = 0; batch < MAX_ENRICHMENT_BATCHES; batch += 1) {
    let response: Response;
    try {
      response = await fetchImpl("/api/youtube/enrich", { method: "POST" });
    } catch {
      throw new Error(SAFE_SYNC_ERROR);
    }

    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(safeErrorMessage(body));
    if (!isEnrichment(body)) throw new Error(SAFE_SYNC_ERROR);

    last = body;
    onProgress(body);
    if (body.remaining === 0 || body.processed === 0) return body;
  }

  return last;
}
