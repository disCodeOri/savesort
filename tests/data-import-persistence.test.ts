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

import {
  applyImportBatch,
  buildImportSearchableText,
  describeRecord,
  fallbackLabel,
} from "@/lib/data-import/persistence";
import type { ImportRecordInput } from "@/lib/data-import/schemas";

import { LONG_BODY } from "./data-import-fixtures";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const IMPORT_ID = "22222222-2222-4222-8222-222222222222";

interface SavedRow {
  normalized_url: string;
  source: string;
  title: string | null;
  content: string | null;
  author: string | null;
  searchable_text: string;
  embedding: string | null;
  indexing_status: string;
  /** User-owned. An import must never touch either of these. */
  notes: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
}

interface ImportRecordRow {
  savedItemUrl: string;
  contentAvailability: string;
  classificationStatus: string;
}

/**
 * Mirrors what `apply_data_import_batch` enforces in SQL: identity resolves by
 * content key first and normalized URL second, richer stored values survive a
 * poorer import, and user-owned columns are never written.
 */
class AdminClientMock {
  readonly saved = new Map<string, SavedRow>();
  readonly records = new Map<string, ImportRecordRow>();

  rpc(name: string, values: Record<string, unknown>) {
    if (name !== "apply_data_import_batch") {
      return Promise.resolve({ data: null, error: null });
    }

    let created = 0;
    let updated = 0;

    for (const item of values.p_items as Array<Record<string, unknown>>) {
      const contentKey = String(item.content_key);
      const url = String(item.normalized_url);
      const incomingContent = (item.content as string | null) ?? null;

      const known = this.records.get(contentKey);
      const existing = known
        ? this.saved.get(known.savedItemUrl)
        : this.saved.get(url);

      if (!existing) {
        this.saved.set(url, {
          normalized_url: url,
          source: "reddit",
          title: (item.title as string | null) ?? null,
          content: incomingContent,
          author: (item.author as string | null) ?? null,
          searchable_text: String(item.searchable_text ?? ""),
          embedding: (item.embedding as string | null) ?? null,
          indexing_status: String(item.indexing_status ?? "pending"),
          notes: null,
          tags: [],
          metadata: (item.metadata as Record<string, unknown>) ?? {},
        });
        created += 1;
      } else {
        if (
          incomingContent &&
          (!existing.content ||
            incomingContent.length > existing.content.length)
        ) {
          existing.content = incomingContent;
        }
        if (item.title) existing.title = String(item.title);
        if (item.author) existing.author = String(item.author);
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

      const previous = this.records.get(contentKey);
      const availability = String(item.content_availability);
      this.records.set(contentKey, {
        savedItemUrl: known?.savedItemUrl ?? url,
        // A later export never downgrades what an earlier one established.
        contentAvailability:
          previous?.contentAvailability === "full"
            ? "full"
            : previous?.contentAvailability === "partial" &&
                availability === "reference_only"
              ? "partial"
              : availability,
        classificationStatus:
          previous?.classificationStatus === "ready"
            ? "ready"
            : String(item.classification_status),
      });
    }

    return Promise.resolve({ data: { created, updated }, error: null });
  }
}

function record(overrides: Partial<ImportRecordInput> = {}): ImportRecordInput {
  return {
    platform: "reddit",
    contentKey: "reddit:t3_abc123",
    contentType: "post",
    sourceId: "t3_abc123",
    canonicalUrl:
      "https://www.reddit.com/r/localfirst/comments/abc123/why_crdts_beat_ot",
    originalUrl: null,
    title: null,
    titleSource: null,
    rawText: null,
    userText: null,
    author: null,
    community: "localfirst",
    sourceCreatedAt: null,
    sourceSavedAt: null,
    sourceActedAt: null,
    externalUrl: null,
    categories: ["reddit_saved_post"],
    sourceFiles: ["saved_posts.csv"],
    ...overrides,
  };
}

let client: AdminClientMock;

beforeEach(() => {
  // Call counts are assertions in this file, so they must not leak between
  // tests.
  vi.clearAllMocks();
  client = new AdminClientMock();
  mocks.createAdminClient.mockReturnValue(client);
  mocks.embedDocument.mockResolvedValue({
    embedding: Array.from({ length: 768 }, () => 0.01),
    error: null,
  });
});

describe("display fields", () => {
  it("labels a title-less item neutrally rather than inventing one", () => {
    expect(fallbackLabel(record())).toBe("Saved Reddit post in r/localfirst");
    expect(
      fallbackLabel(record({ platform: "linkedin", community: null })),
    ).toBe("Saved LinkedIn item");
  });

  it("describes an item only from what the export supplied", () => {
    expect(describeRecord(record())).toContain("r/localfirst");
    expect(describeRecord(record())).toContain("Saved posts");
  });

  it("keeps a fallback label out of the indexed document", () => {
    // Otherwise every reference-only item would share the same words and
    // start matching each other in search.
    const text = buildImportSearchableText(record(), null);
    expect(text).not.toContain("Saved Reddit post in");
    expect(text).toContain("localfirst");
  });

  it("indexes generated topics and keywords alongside the source text", () => {
    const text = buildImportSearchableText(record({ rawText: LONG_BODY }), {
      summary: "A comparison of CRDTs and operational transforms.",
      topics: ["distributed systems"],
      category: "Technology",
      subcategories: [],
      keywords: ["crdt", "offline sync"],
      language: "en",
      model: "test",
      classifierVersion: "v1",
      taxonomyVersion: "v1",
    });

    expect(text).toContain("offline sync");
    expect(text).toContain("A comparison of CRDTs");
    expect(text).toContain(LONG_BODY);
  });
});

describe("applyImportBatch", () => {
  it("never embeds a reference-only record", async () => {
    const result = await applyImportBatch(USER_ID, IMPORT_ID, [
      record({ community: null }),
    ]);

    expect(mocks.embedDocument).not.toHaveBeenCalled();
    expect(result.referenceOnly).toBe(1);
    expect(result.classificationInsufficient).toBe(1);
    expect(result.classificationPending).toBe(0);
  });

  it("does not queue a subreddit-only item for classification", async () => {
    // Enough to display, not enough to summarise.
    const result = await applyImportBatch(USER_ID, IMPORT_ID, [record()]);
    expect(mocks.embedDocument).not.toHaveBeenCalled();
    expect(result.partial).toBe(1);
    expect(result.classificationInsufficient).toBe(1);
  });

  it("embeds and queues an item that has real text", async () => {
    const result = await applyImportBatch(USER_ID, IMPORT_ID, [
      record({ rawText: LONG_BODY }),
    ]);

    expect(mocks.embedDocument).toHaveBeenCalledTimes(1);
    expect(result.full).toBe(1);
    expect(result.embedded).toBe(1);
    expect(result.classificationPending).toBe(1);
  });

  it("ignores a client that claims more content than it sent", async () => {
    // Availability is re-derived server-side, so a lying client cannot buy an
    // embedding for a bare URL.
    await applyImportBatch(USER_ID, IMPORT_ID, [
      record({ community: null, title: null, rawText: null }),
    ]);
    expect(mocks.embedDocument).not.toHaveBeenCalled();
  });

  it("keeps a failed embedding keyword-searchable", async () => {
    mocks.embedDocument.mockResolvedValue({
      embedding: null,
      error: "Semantic indexing is temporarily unavailable.",
    });

    await applyImportBatch(USER_ID, IMPORT_ID, [
      record({ rawText: LONG_BODY }),
    ]);

    const row = [...client.saved.values()][0]!;
    expect(row.indexing_status).toBe("keyword_only");
    expect(row.searchable_text).toContain(LONG_BODY);
  });

  it("survives an embedding call that throws", async () => {
    mocks.embedDocument.mockRejectedValue(new Error("network"));
    const result = await applyImportBatch(USER_ID, IMPORT_ID, [
      record({ rawText: LONG_BODY }),
    ]);
    expect(result.created).toBe(1);
    expect(result.embedded).toBe(0);
  });

  it("writes provenance without dumping the export row", async () => {
    await applyImportBatch(USER_ID, IMPORT_ID, [
      record({ rawText: LONG_BODY, sourceSavedAt: null }),
    ]);

    const metadata = [...client.saved.values()][0]!.metadata as {
      import: Record<string, unknown>;
      platform: Record<string, unknown>;
    };
    expect(metadata.import.method).toBe("reddit_export");
    expect(metadata.import.importId).toBe(IMPORT_ID);
    expect(metadata.import.sourceFiles).toEqual(["saved_posts.csv"]);
    expect(metadata.platform.contentKey).toBe("reddit:t3_abc123");
    // A missing saved date stays missing rather than borrowing another one.
    expect(metadata.platform.sourceSavedAt).toBeNull();
  });

  it("never writes the user's tags", async () => {
    await applyImportBatch(USER_ID, IMPORT_ID, [
      record({ rawText: LONG_BODY }),
    ]);
    expect([...client.saved.values()][0]!.tags).toEqual([]);
  });
});

describe("repeat imports", () => {
  it("creates nothing the second time the same export is imported", async () => {
    const records = [
      record({ rawText: LONG_BODY }),
      record({
        contentKey: "reddit:t3_zzz999",
        canonicalUrl: "https://www.reddit.com/r/other/comments/zzz999/thing",
      }),
    ];

    const first = await applyImportBatch(USER_ID, IMPORT_ID, records);
    expect(first.created).toBe(2);

    const second = await applyImportBatch(USER_ID, IMPORT_ID, records);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(2);
    expect(client.saved.size).toBe(2);
  });

  it("preserves a note and manual tags added between imports", async () => {
    await applyImportBatch(USER_ID, IMPORT_ID, [record()]);
    const row = [...client.saved.values()][0]!;
    row.notes = "great post about CRDT sync";
    row.tags = ["reading-list"];

    await applyImportBatch(USER_ID, IMPORT_ID, [record()]);

    expect(row.notes).toBe("great post about CRDT sync");
    expect(row.tags).toEqual(["reading-list"]);
  });

  it("does not downgrade a rich item when a reference-only record arrives", async () => {
    await applyImportBatch(USER_ID, IMPORT_ID, [
      record({ rawText: LONG_BODY }),
    ]);
    await applyImportBatch(USER_ID, IMPORT_ID, [record({ rawText: null })]);

    const row = [...client.saved.values()][0]!;
    expect(row.content).toBe(LONG_BODY);
    expect(client.records.get("reddit:t3_abc123")!.contentAvailability).toBe(
      "full",
    );
  });

  it("upgrades a reference-only item when a later export carries the text", async () => {
    await applyImportBatch(USER_ID, IMPORT_ID, [record()]);
    expect([...client.saved.values()][0]!.content).toBeNull();

    await applyImportBatch(USER_ID, IMPORT_ID, [
      record({
        rawText: LONG_BODY,
        title: "Why CRDTs beat operational transforms",
      }),
    ]);

    const row = [...client.saved.values()][0]!;
    expect(row.content).toBe(LONG_BODY);
    expect(row.title).toBe("Why CRDTs beat operational transforms");
    expect(client.records.get("reddit:t3_abc123")!.contentAvailability).toBe(
      "full",
    );
  });

  it("does not duplicate when the same post arrives under a shorter permalink", async () => {
    // The content key is the identity, so a permalink written two ways still
    // resolves to one library row.
    await applyImportBatch(USER_ID, IMPORT_ID, [record()]);
    await applyImportBatch(USER_ID, IMPORT_ID, [
      record({ canonicalUrl: "https://www.reddit.com/comments/abc123" }),
    ]);

    expect(client.saved.size).toBe(1);
  });

  it("merges with an item the Reddit OAuth sync already created", async () => {
    // The connected account got there first; the export must enrich, not
    // duplicate. Identity falls through to the canonical permalink.
    const url =
      "https://www.reddit.com/r/localfirst/comments/abc123/why_crdts_beat_ot";
    client.saved.set(url, {
      normalized_url: url,
      source: "reddit",
      title: "Why CRDTs beat operational transforms",
      content: LONG_BODY,
      author: "someone",
      searchable_text: `Title: x\nContent: ${LONG_BODY}`,
      embedding: "[0.5]",
      indexing_status: "ready",
      notes: "worth rereading",
      tags: ["sync"],
      metadata: { reddit: { id: "abc123" } },
    });

    const result = await applyImportBatch(USER_ID, IMPORT_ID, [record()]);

    expect(result.created).toBe(0);
    expect(client.saved.size).toBe(1);
    const row = client.saved.get(url)!;
    expect(row.content).toBe(LONG_BODY);
    expect(row.embedding).toBe("[0.5]");
    expect(row.indexing_status).toBe("ready");
    expect(row.notes).toBe("worth rereading");
    expect(row.tags).toEqual(["sync"]);
    // Both provenances now sit side by side.
    expect(row.metadata).toHaveProperty("reddit");
    expect(row.metadata).toHaveProperty("import");
  });
});
