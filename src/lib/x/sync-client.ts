export type XSyncProgress =
  | {
      status: "running";
      syncId: string;
      nextPage: number;
      discoveredCount: number;
      savedCount: number;
      updatedCount: number;
      skippedCount: number;
    }
  | {
      status:
        | "complete"
        | "not_connected"
        | "reconnect_required"
        | "failed"
        | "rate_limited";
      discoveredCount: number;
      savedCount: number;
      updatedCount: number;
      skippedCount: number;
      rateLimitResetAt?: string | null;
      reconciled?: boolean;
      deactivatedCount?: number;
    };

type SyncRequest = { action: "start" } | { action: "continue"; syncId: string };

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * X bills per post returned, so an unbounded continuation loop is a spending
 * bug, not just a hang. The server enforces its own page cap; this is the
 * client-side backstop.
 */
const MAX_CONTINUATION_RESPONSES = 100;
const SAFE_SYNC_ERROR = "X sync is temporarily unavailable. Try again later.";

function isProgress(value: unknown): value is XSyncProgress {
  if (!value || typeof value !== "object") return false;
  const progress = value as Partial<XSyncProgress>;
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
    "failed",
    "rate_limited",
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
): Promise<XSyncProgress> {
  let response: Response;
  try {
    response = await fetchImpl("/api/x/sync", {
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

/**
 * Drives the bounded sync to completion, one page per request.
 *
 * Called only from an explicit user action — never from a render, mount, or
 * navigation — because every page costs money on X's pay-per-use API.
 */
export async function runXSync(
  onProgress: (progress: XSyncProgress) => void,
  fetchImpl: FetchImplementation = fetch,
): Promise<XSyncProgress> {
  let request: SyncRequest = { action: "start" };
  let continuationResponses = 0;

  while (true) {
    const progress = await postSyncRequest(request, fetchImpl);
    onProgress(progress);

    if (progress.status !== "running") return progress;
    if (continuationResponses >= MAX_CONTINUATION_RESPONSES) {
      throw new Error("X sync did not finish.");
    }

    continuationResponses += 1;
    request = { action: "continue", syncId: progress.syncId };
  }
}
