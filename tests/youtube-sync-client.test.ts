import { describe, expect, it, vi } from "vitest";

import {
  runYouTubeEnrichment,
  runYouTubeSync,
} from "@/lib/youtube/sync-client";

const SYNC_ID = "33333333-3333-4333-8333-333333333333";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function running(nextPage: number) {
  return {
    status: "running",
    syncId: SYNC_ID,
    nextPage,
    discoveredCount: nextPage * 50,
    savedCount: nextPage * 50,
    skippedCount: 0,
  };
}

const complete = {
  status: "complete",
  discoveredCount: 120,
  savedCount: 120,
  skippedCount: 0,
};

describe("runYouTubeSync", () => {
  it("continues the same sync until every playlist is imported", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(running(2)))
      .mockResolvedValueOnce(jsonResponse(running(3)))
      .mockResolvedValueOnce(jsonResponse(complete));

    const result = await runYouTubeSync(() => undefined, fetchImpl);

    expect(result.status).toBe("complete");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body))).toEqual({
      action: "continue",
      syncId: SYNC_ID,
    });
  });

  it("stops when no playlists are selected", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        status: "no_playlists",
        discoveredCount: 0,
        savedCount: 0,
        skippedCount: 0,
      }),
    );

    const result = await runYouTubeSync(() => undefined, fetchImpl);

    expect(result.status).toBe("no_playlists");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces a quota error from the server", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          { error: "The YouTube API quota is exhausted. Try again later." },
          429,
        ),
      );

    await expect(runYouTubeSync(() => undefined, fetchImpl)).rejects.toThrow(
      "The YouTube API quota is exhausted. Try again later.",
    );
  });

  it("hides transport failures behind a safe message", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("ECONNRESET at 10.0.0.1"));

    await expect(runYouTubeSync(() => undefined, fetchImpl)).rejects.toThrow(
      "YouTube sync is temporarily unavailable. Try again later.",
    );
  });
});

describe("runYouTubeEnrichment", () => {
  it("keeps requesting batches until nothing remains", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          processed: 3,
          ready: 3,
          failed: 0,
          unsupported: 0,
          remaining: 2,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          processed: 2,
          ready: 2,
          failed: 0,
          unsupported: 0,
          remaining: 0,
        }),
      );

    const result = await runYouTubeEnrichment(() => undefined, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.remaining).toBe(0);
  });

  it("stops when a batch makes no progress rather than looping forever", async () => {
    // A permanently stuck queue must not spin: processed === 0 ends the loop
    // even though work is still reported as remaining.
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          processed: 0,
          ready: 0,
          failed: 0,
          unsupported: 0,
          remaining: 5,
        }),
      ),
    );

    const result = await runYouTubeEnrichment(() => undefined, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.remaining).toBe(5);
  });

  it("reports progress for each batch", async () => {
    const seen: number[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          processed: 3,
          ready: 3,
          failed: 0,
          unsupported: 0,
          remaining: 1,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          processed: 1,
          ready: 1,
          failed: 0,
          unsupported: 0,
          remaining: 0,
        }),
      );

    await runYouTubeEnrichment(
      (progress) => seen.push(progress.remaining),
      fetchImpl,
    );

    expect(seen).toEqual([1, 0]);
  });
});
