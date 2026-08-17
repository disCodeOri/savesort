import { describe, expect, it, vi } from "vitest";

import { runRedditSync } from "@/lib/reddit/sync-client";

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
    discoveredCount: nextPage * 100,
    savedCount: nextPage * 100,
    skippedCount: 0,
  };
}

function complete() {
  return {
    status: "complete",
    discoveredCount: 250,
    savedCount: 250,
    skippedCount: 0,
  };
}

describe("runRedditSync", () => {
  it("continues the same sync until the listing is finished", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(running(2)))
      .mockResolvedValueOnce(jsonResponse(running(3)))
      .mockResolvedValueOnce(jsonResponse(complete()));
    const progress: string[] = [];

    const result = await runRedditSync(
      (value) => progress.push(value.status),
      fetchImpl,
    );

    expect(result.status).toBe("complete");
    expect(progress).toEqual(["running", "running", "complete"]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toEqual({
      action: "start",
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body))).toEqual({
      action: "continue",
      syncId: SYNC_ID,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe("/api/reddit/sync");
  });

  it("stops on a terminal status without continuing", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        status: "reconnect_required",
        discoveredCount: 0,
        savedCount: 0,
        skippedCount: 0,
      }),
    );

    const result = await runRedditSync(() => undefined, fetchImpl);

    expect(result.status).toBe("reconnect_required");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces the server's error message", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          { error: "Reddit is rate limited. Try again later." },
          429,
        ),
      );

    await expect(runRedditSync(() => undefined, fetchImpl)).rejects.toThrow(
      "Reddit is rate limited. Try again later.",
    );
  });

  it("rejects a response that is not recognizable progress", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ status: "running" }));

    await expect(runRedditSync(() => undefined, fetchImpl)).rejects.toThrow(
      "Reddit sync is temporarily unavailable. Try again later.",
    );
  });

  it("hides transport failures behind a safe message", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("ECONNRESET at 10.0.0.1"));

    await expect(runRedditSync(() => undefined, fetchImpl)).rejects.toThrow(
      "Reddit sync is temporarily unavailable. Try again later.",
    );
  });

  it("gives up rather than paging forever", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse(running(2))));

    await expect(runRedditSync(() => undefined, fetchImpl)).rejects.toThrow(
      "Reddit sync did not finish.",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1_001);
  });
});
