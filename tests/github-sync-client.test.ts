import { describe, expect, it, vi } from "vitest";

import { runGitHubSync } from "@/lib/github/sync-client";

const runningProgress = {
  status: "running" as const,
  syncId: "1e4d9e32-169e-42a2-98b2-ddb82c27d261",
  nextPage: 2,
  discoveredCount: 100,
  savedCount: 98,
  skippedCount: 2,
};

const completeProgress = {
  status: "complete" as const,
  discoveredCount: 102,
  savedCount: 100,
  skippedCount: 2,
};

describe("runGitHubSync", () => {
  it("starts a sync and continues it until completion", async () => {
    const fetchImpl = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(runningProgress), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(completeProgress), { status: 200 }),
      );
    const onProgress = vi.fn();

    await expect(runGitHubSync(onProgress, fetchImpl)).resolves.toEqual(
      completeProgress,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/api/github/sync",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/api/github/sync",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "continue",
          syncId: runningProgress.syncId,
        }),
      }),
    );
    expect(onProgress).toHaveBeenNthCalledWith(1, runningProgress);
    expect(onProgress).toHaveBeenNthCalledWith(2, completeProgress);
  });

  it("uses the API's safe error message when a sync request fails", async () => {
    const fetchImpl = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: "GitHub is rate limited. Try again later." }),
          { status: 429 },
        ),
      );

    await expect(runGitHubSync(vi.fn(), fetchImpl)).rejects.toThrow(
      "GitHub is rate limited. Try again later.",
    );
  });

  it("stops after 1000 continuation responses", async () => {
    const fetchImpl = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementation(
        async () => new Response(JSON.stringify(runningProgress)),
      );

    await expect(runGitHubSync(vi.fn(), fetchImpl)).rejects.toThrow(
      "GitHub sync did not finish.",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1_001);
  });
});
