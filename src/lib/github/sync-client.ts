export type GitHubSyncProgress =
  | {
      status: "running";
      syncId: string;
      nextPage: number;
      discoveredCount: number;
      savedCount: number;
      skippedCount: number;
    }
  | {
      status: "complete" | "not_connected" | "reconnect_required" | "failed";
      discoveredCount: number;
      savedCount: number;
      skippedCount: number;
    };

type GitHubSyncRequest =
  | { action: "start" }
  | { action: "continue"; syncId: string };

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const MAX_CONTINUATION_RESPONSES = 1_000;
const SAFE_SYNC_ERROR = "GitHub sync is temporarily unavailable. Try again later.";

function isProgress(value: unknown): value is GitHubSyncProgress {
  if (!value || typeof value !== "object") return false;

  const progress = value as Partial<GitHubSyncProgress>;
  if (
    typeof progress.discoveredCount !== "number" ||
    typeof progress.savedCount !== "number" ||
    typeof progress.skippedCount !== "number"
  ) {
    return false;
  }

  if (progress.status === "running") {
    return (
      typeof progress.syncId === "string" && typeof progress.nextPage === "number"
    );
  }

  return ["complete", "not_connected", "reconnect_required", "failed"].includes(
    progress.status ?? "",
  );
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
  request: GitHubSyncRequest,
  fetchImpl: FetchImplementation,
): Promise<GitHubSyncProgress> {
  let response: Response;
  try {
    response = await fetchImpl("/api/github/sync", {
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

export async function runGitHubSync(
  onProgress: (progress: GitHubSyncProgress) => void,
  fetchImpl: FetchImplementation = fetch,
): Promise<GitHubSyncProgress> {
  let request: GitHubSyncRequest = { action: "start" };
  let continuationResponses = 0;

  while (true) {
    const progress = await postSyncRequest(request, fetchImpl);
    onProgress(progress);

    if (progress.status !== "running") return progress;
    if (continuationResponses >= MAX_CONTINUATION_RESPONSES) {
      throw new Error("GitHub sync did not finish.");
    }

    continuationResponses += 1;
    request = { action: "continue", syncId: progress.syncId };
  }
}
