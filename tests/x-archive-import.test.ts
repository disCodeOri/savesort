import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  embedDocument: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/embeddings/gemini", () => ({
  embedDocument: mocks.embedDocument,
}));

import { applyArchiveBatch } from "@/lib/x-archive/import";
import type { ArchiveRecordInput } from "@/lib/x-archive/schemas";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const IMPORT_ID = "22222222-2222-4222-8222-222222222222";
const LONG_TEXT =
  "A long thread explaining why most AI agent architectures do not need a vector database at all.";

interface SavedRow {
  normalized_url: string;
  content: string | null;
  searchable_text: string;
  embedding: string | null;
  indexing_status: string;
  notes: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
}

/** Mirrors the merge and idempotency rules apply_x_archive_batch enforces. */
class AdminClientMock {
  readonly saved = new Map<string, SavedRow>();
  readonly relationships = new Set<string>();
  readonly rpcCalls: Array<{ name: string; values: Record<string, unknown> }> =
    [];

  rpc(name: string, values: Record<string, unknown>) {
    this.rpcCalls.push({ name, values });
    if (name !== "apply_x_archive_batch") {
      return Promise.resolve({ data: null, error: null });
    }

    let created = 0;
    let updated = 0;
    let relationships = 0;

    for (const item of values.p_items as Array<Record<string, unknown>>) {
      const url = String(item.normalized_url);
      const existing = this.saved.get(url);
      const incomingContent = (item.content as string | null) ?? null;

      if (!existing) {
        this.saved.set(url, {
          normalized_url: url,
          content: incomingContent,
          searchable_text: String(item.searchable_text ?? ""),
          embedding: (item.embedding as string | null) ?? null,
          indexing_status: String(item.indexing_status ?? "pending"),
          notes: null,
          tags: [],
          metadata: (item.metadata as Record<string, unknown>) ?? {},
        });
        created += 1;
      } else {
        // Never downgrade richer stored data.
        if (
          incomingContent &&
          (!existing.content ||
            incomingContent.length > existing.content.length)
        ) {
          existing.content = incomingContent;
        }
        if (
          String(item.searchable_text ?? "").length >
          existing.searchable_text.length
        ) {
          existing.searchable_text = String(item.searchable_text);
        }
        existing.embedding =
          existing.embedding ?? (item.embedding as string | null) ?? null;
        if (existing.indexing_status !== "ready") {
          existing.indexing_status = String(
            item.indexing_status ?? existing.indexing_status,
          );
        }
        existing.metadata = {
          ...existing.metadata,
          ...((item.metadata as Record<string, unknown>) ?? {}),
        };
        updated += 1;
      }

      for (const relationship of (item.relationships as Array<{
        type: string;
      }>) ?? []) {
        const key = `${item.post_id}:${relationship.type}`;
        if (!this.relationships.has(key)) relationships += 1;
        this.relationships.add(key);
      }
    }

    return Promise.resolve({
      data: { created, updated, relationships },
      error: null,
    });
  }
}

function record(
  postId: string,
  overrides: Partial<ArchiveRecordInput> = {},
): ArchiveRecordInput {
  return {
    postId,
    canonicalUrl: `https://x.com/someone/status/${postId}`,
    text: null,
    authorUsername: "someone",
    authorName: "Some One",
    createdAt: null,
    conversationId: null,
    replyToPostId: null,
    quotedPostId: null,
    hashtags: [],
    mentions: [],
    externalUrls: [],
    mediaUrls: [],
    relationships: [{ type: "like", timestamp: null }],
    ...overrides,
  } as ArchiveRecordInput;
}

let admin: AdminClientMock;

beforeEach(() => {
  admin = new AdminClientMock();
  mocks.createAdminClient.mockReset().mockReturnValue(admin);
  mocks.embedDocument
    .mockReset()
    .mockResolvedValue({ embedding: [0.1, 0.2], error: null });
});

describe("applyArchiveBatch", () => {
  it("creates content and its relationship", async () => {
    const result = await applyArchiveBatch(USER_ID, IMPORT_ID, [
      record("1900000000000000001", { text: LONG_TEXT }),
    ]);

    expect(result.created).toBe(1);
    expect(result.relationships).toBe(1);
    expect(admin.saved.size).toBe(1);
  });

  it("never embeds a reference-only record", async () => {
    // A bare post id has no meaning; embedding it would be spend for nothing.
    const result = await applyArchiveBatch(USER_ID, IMPORT_ID, [
      record("1900000000000000001", { text: null }),
    ]);

    expect(mocks.embedDocument).not.toHaveBeenCalled();
    expect(result.embedded).toBe(0);
    expect(result.skippedForAi).toBe(1);
    const stored = [...admin.saved.values()][0]!;
    expect(stored.embedding).toBeNull();
    expect(stored.indexing_status).toBe("pending");
  });

  it("recomputes availability server-side rather than trusting the client", async () => {
    // The client cannot force AI spend by mislabelling an empty record.
    await applyArchiveBatch(USER_ID, IMPORT_ID, [
      record("1900000000000000001", { text: "   " }),
    ]);

    expect(mocks.embedDocument).not.toHaveBeenCalled();
  });

  it("embeds content that has real text", async () => {
    const result = await applyArchiveBatch(USER_ID, IMPORT_ID, [
      record("1900000000000000001", { text: LONG_TEXT }),
    ]);

    expect(mocks.embedDocument).toHaveBeenCalledTimes(1);
    expect(result.embedded).toBe(1);
  });

  it("is idempotent when the same archive is imported twice", async () => {
    const batch = [record("1900000000000000001", { text: LONG_TEXT })];

    await applyArchiveBatch(USER_ID, IMPORT_ID, batch);
    const second = await applyArchiveBatch(USER_ID, IMPORT_ID, batch);

    expect(admin.saved.size).toBe(1);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    // The relationship already existed, so it is not counted again.
    expect(second.relationships).toBe(0);
  });

  it("keeps one item when a post is both liked and bookmarked", async () => {
    await applyArchiveBatch(USER_ID, IMPORT_ID, [
      record("1900000000000000001", {
        text: LONG_TEXT,
        relationships: [
          { type: "like", timestamp: null },
          { type: "bookmark", timestamp: null },
        ],
      }),
    ]);

    expect(admin.saved.size).toBe(1);
    expect(admin.relationships.size).toBe(2);
  });

  it("does not overwrite richer API content with a null archive record", async () => {
    // Simulates the post already existing from the live X API sync.
    await applyArchiveBatch(USER_ID, IMPORT_ID, [
      record("1900000000000000001", { text: LONG_TEXT }),
    ]);

    await applyArchiveBatch(USER_ID, IMPORT_ID, [
      record("1900000000000000001", { text: null }),
    ]);

    const stored = [...admin.saved.values()][0]!;
    expect(stored.content).toBe(LONG_TEXT);
    expect(stored.embedding).not.toBeNull();
  });

  it("reuses an existing embedding rather than paying for it again", async () => {
    await applyArchiveBatch(USER_ID, IMPORT_ID, [
      record("1900000000000000001", { text: LONG_TEXT }),
    ]);
    const stored = [...admin.saved.values()][0]!;
    const firstEmbedding = stored.embedding;

    mocks.embedDocument.mockResolvedValue({ embedding: [9, 9], error: null });
    await applyArchiveBatch(USER_ID, IMPORT_ID, [
      record("1900000000000000001", { text: LONG_TEXT }),
    ]);

    expect(stored.embedding).toBe(firstEmbedding);
  });

  it("stores the record even when embedding fails", async () => {
    mocks.embedDocument.mockResolvedValue({ embedding: null, error: "down" });

    const result = await applyArchiveBatch(USER_ID, IMPORT_ID, [
      record("1900000000000000001", { text: LONG_TEXT }),
    ]);

    expect(result.created).toBe(1);
    const stored = [...admin.saved.values()][0]!;
    // Keyword search still works without a vector.
    expect(stored.indexing_status).toBe("keyword_only");
    expect(stored.searchable_text).toContain("vector database");
  });

  it("indexes the author so 'posts I liked from @someone' can match", async () => {
    await applyArchiveBatch(USER_ID, IMPORT_ID, [
      record("1900000000000000001", {
        text: LONG_TEXT,
        hashtags: ["AI"],
      }),
    ]);

    const stored = [...admin.saved.values()][0]!;
    expect(stored.searchable_text).toContain("@someone");
    expect(stored.searchable_text).toContain("AI");
  });

  it("records archive provenance on the item", async () => {
    await applyArchiveBatch(USER_ID, IMPORT_ID, [
      record("1900000000000000001", { text: LONG_TEXT }),
    ]);

    const stored = [...admin.saved.values()][0]!;
    const x = stored.metadata.x as Record<string, unknown>;
    expect(x.provenance).toEqual(["x_archive"]);
    expect(x.contentAvailability).toBe("full");
  });

  it("never presents a post's creation time as a relationship time", async () => {
    await applyArchiveBatch(USER_ID, IMPORT_ID, [
      record("1900000000000000001", {
        text: LONG_TEXT,
        createdAt: "2026-01-01T00:00:00.000Z",
        relationships: [{ type: "like", timestamp: null }],
      }),
    ]);

    const applied = admin.rpcCalls.find(
      (call) => call.name === "apply_x_archive_batch",
    )!;
    const item = (applied.values.p_items as Array<Record<string, unknown>>)[0]!;
    const relationships = item.relationships as Array<{
      timestamp: string | null;
    }>;
    expect(relationships[0]!.timestamp).toBeNull();
    expect((item.metadata as { x: { postedAt: string } }).x.postedAt).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });
});
