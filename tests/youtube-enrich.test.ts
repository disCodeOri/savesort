import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  embedDocument: vi.fn(),
  analyzeYouTubeVideo: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));

vi.mock("@/lib/embeddings/gemini", () => ({
  embedDocument: mocks.embedDocument,
}));

vi.mock("@/lib/youtube/analysis", () => ({
  analyzeYouTubeVideo: mocks.analyzeYouTubeVideo,
}));

import { enrichPendingVideos } from "@/lib/youtube/enrich";

const USER_ID = "11111111-1111-4111-8111-111111111111";

interface VideoRow {
  video_id: string;
  saved_item_id: string | null;
  enrichment_status: "pending" | "ready" | "failed" | "unsupported";
  enrichment_error: string | null;
}

/** Mirrors the enrichment rules the SQL function enforces. */
class AdminClientMock {
  readonly videos = new Map<string, VideoRow>();
  readonly rpcCalls: Array<{ name: string; values: Record<string, unknown> }> =
    [];
  failApply = false;
  savedItem: Record<string, unknown> | null = {
    title: "Local-first sync explained",
    author: "Some Channel",
    description: "A talk",
    tags: ["databases"],
    metadata: {},
  };

  private pendingRows(limit: number) {
    return [...this.videos.values()]
      .filter((row) => row.enrichment_status === "pending")
      .slice(0, limit);
  }

  from(table: string) {
    let limitValue = 100;
    let headOnly = false;
    const builder = {
      select: (_columns: string, options?: { head?: boolean }) => {
        headOnly = options?.head === true;
        return builder;
      },
      eq: () => builder,
      limit: (value: number) => {
        limitValue = value;
        return builder;
      },
      maybeSingle: () =>
        Promise.resolve({
          data: table === "saved_items" ? this.savedItem : null,
          error: null,
        }),
      then: (resolve: (result: unknown) => unknown) => {
        if (table === "youtube_videos" && headOnly) {
          return Promise.resolve({
            data: null,
            error: null,
            count: [...this.videos.values()].filter(
              (row) => row.enrichment_status === "pending",
            ).length,
          }).then(resolve);
        }
        return Promise.resolve({
          data: table === "youtube_videos" ? this.pendingRows(limitValue) : [],
          error: null,
        }).then(resolve);
      },
    };
    return builder;
  }

  rpc(name: string, values: Record<string, unknown>) {
    this.rpcCalls.push({ name, values });
    if (name !== "apply_youtube_enrichment") {
      return Promise.resolve({ data: null, error: { message: "unknown RPC" } });
    }
    if (this.failApply) {
      return Promise.resolve({ data: null, error: { message: "boom" } });
    }
    const row = this.videos.get(String(values.p_video_id));
    if (row) {
      row.enrichment_status = values.p_status as VideoRow["enrichment_status"];
      row.enrichment_error = (values.p_error as string | null) ?? null;
    }
    return Promise.resolve({ data: true, error: null });
  }
}

let admin: AdminClientMock;

function seedPending(...videoIds: string[]) {
  for (const videoId of videoIds) {
    admin.videos.set(videoId, {
      video_id: videoId,
      saved_item_id: `item-${videoId}`,
      enrichment_status: "pending",
      enrichment_error: null,
    });
  }
}

beforeEach(() => {
  admin = new AdminClientMock();
  mocks.createAdminClient.mockReset().mockReturnValue(admin);
  mocks.embedDocument
    .mockReset()
    .mockResolvedValue({ embedding: [0.1, 0.2], error: null });
  mocks.analyzeYouTubeVideo.mockReset().mockResolvedValue({
    status: "ready",
    analysis: "The speaker demonstrates conflict-free replicated data types.",
    model: "gemini-2.5-flash",
  });
});

describe("enrichPendingVideos", () => {
  it("analyses pending videos and marks them ready", async () => {
    seedPending("a", "b");

    const progress = await enrichPendingVideos(USER_ID, 5);

    expect(progress).toMatchObject({ processed: 2, ready: 2, remaining: 0 });
    expect(admin.videos.get("a")!.enrichment_status).toBe("ready");
  });

  it("never re-analyses a video that is already done", async () => {
    seedPending("a");
    await enrichPendingVideos(USER_ID, 5);
    mocks.analyzeYouTubeVideo.mockClear();

    const second = await enrichPendingVideos(USER_ID, 5);

    expect(mocks.analyzeYouTubeVideo).not.toHaveBeenCalled();
    expect(second.processed).toBe(0);
  });

  it("stores the analysis as the searchable body", async () => {
    seedPending("a");

    await enrichPendingVideos(USER_ID, 5);

    const applied = admin.rpcCalls.find(
      (call) => call.name === "apply_youtube_enrichment",
    )!;
    expect(applied.values.p_content).toContain(
      "conflict-free replicated data types",
    );
    expect(String(applied.values.p_searchable_text)).toContain(
      "Title: Local-first sync explained",
    );
    expect(applied.values.p_indexing_status).toBe("ready");
  });

  it("respects the batch size so one call stays within a request budget", async () => {
    seedPending("a", "b", "c", "d");

    const progress = await enrichPendingVideos(USER_ID, 2);

    expect(progress.processed).toBe(2);
    expect(progress.remaining).toBe(2);
  });

  it("marks an unplayable video unsupported so it is not retried forever", async () => {
    seedPending("a");
    mocks.analyzeYouTubeVideo.mockResolvedValue({
      status: "unsupported",
      error: "This video could not be analysed.",
    });

    const progress = await enrichPendingVideos(USER_ID, 5);

    expect(progress).toMatchObject({ unsupported: 1, ready: 0 });
    expect(admin.videos.get("a")!.enrichment_status).toBe("unsupported");
    expect(progress.remaining).toBe(0);
  });

  it("records a transient failure without claiming success", async () => {
    seedPending("a");
    mocks.analyzeYouTubeVideo.mockResolvedValue({
      status: "failed",
      error: "Video analysis is temporarily unavailable.",
    });

    const progress = await enrichPendingVideos(USER_ID, 5);

    expect(progress).toMatchObject({ failed: 1, ready: 0 });
    expect(admin.videos.get("a")!.enrichment_status).toBe("failed");
  });

  it("still stores the analysis when embedding is unavailable", async () => {
    seedPending("a");
    mocks.embedDocument.mockResolvedValue({ embedding: null, error: "down" });

    const progress = await enrichPendingVideos(USER_ID, 5);

    expect(progress.ready).toBe(1);
    const applied = admin.rpcCalls.find(
      (call) => call.name === "apply_youtube_enrichment",
    )!;
    expect(applied.values.p_indexing_status).toBe("keyword_only");
    expect(applied.values.p_embedding).toBeNull();
  });

  it("leaves a video pending when the write fails so it retries", async () => {
    seedPending("a");
    admin.failApply = true;

    const progress = await enrichPendingVideos(USER_ID, 5);

    expect(progress.failed).toBe(1);
    expect(admin.videos.get("a")!.enrichment_status).toBe("pending");
  });

  it("does nothing when there is no pending work", async () => {
    const progress = await enrichPendingVideos(USER_ID, 5);

    expect(progress).toMatchObject({ processed: 0, remaining: 0 });
    expect(mocks.analyzeYouTubeVideo).not.toHaveBeenCalled();
  });
});
