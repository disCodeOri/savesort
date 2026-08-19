import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  classifyImportedItem: vi.fn(),
  embedDocument: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/data-import/classification", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  classifyImportedItem: mocks.classifyImportedItem,
}));
vi.mock("@/lib/embeddings/gemini", () => ({
  embedDocument: mocks.embedDocument,
}));

import { runClassificationPass } from "@/lib/data-import/classify-pass";

import { LONG_BODY } from "./data-import-fixtures";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "99999999-9999-4999-8999-999999999999";
const IMPORT_ID = "22222222-2222-4222-8222-222222222222";

interface ItemRow {
  id: string;
  user_id: string;
  title: string | null;
  content: string | null;
  author: string | null;
  searchable_text: string;
  embedding: string | null;
  indexing_status: string;
  metadata: Record<string, unknown>;
}

interface RecordRow {
  user_id: string;
  import_id: string;
  platform: string;
  content_key: string;
  saved_item_id: string | null;
  classification_status: string;
}

/** A small stand-in for the two tables and one RPC this pass touches. */
class AdminClientMock {
  imports: Array<{ id: string; user_id: string; platform: string }> = [
    { id: IMPORT_ID, user_id: USER_ID, platform: "reddit" },
  ];
  items: ItemRow[] = [];
  records: RecordRow[] = [];
  readonly rpcCalls: Array<Record<string, unknown>> = [];

  from(table: string) {
    return new QueryMock(this, table);
  }

  rpc(name: string, values: Record<string, unknown>) {
    if (name === "record_data_import_classification") {
      this.rpcCalls.push(values);
      const record = this.records.find(
        (candidate) =>
          candidate.user_id === values.p_user_id &&
          candidate.content_key === values.p_content_key,
      );
      if (record) record.classification_status = String(values.p_status);
    }
    return Promise.resolve({ data: null, error: null });
  }
}

class QueryMock {
  private filters: Array<[string, unknown]> = [];
  private limitValue = Infinity;
  private inFilter: [string, unknown[]] | null = null;
  private headOnly = false;
  private pendingUpdate: Record<string, unknown> | null = null;

  constructor(
    private readonly client: AdminClientMock,
    private readonly table: string,
  ) {}

  select(_columns: string, options?: { head?: boolean }) {
    this.headOnly = Boolean(options?.head);
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }

  in(column: string, values: unknown[]) {
    this.inFilter = [column, values];
    return this;
  }

  limit(value: number) {
    this.limitValue = value;
    return this;
  }

  update(values: Record<string, unknown>) {
    this.pendingUpdate = values;
    return this;
  }

  private rows(): Array<Record<string, unknown>> {
    const source =
      this.table === "data_imports"
        ? this.client.imports
        : this.table === "saved_items"
          ? this.client.items
          : this.client.records;

    return (source as Array<Record<string, unknown>>)
      .filter((row) =>
        this.filters.every(([column, value]) => row[column] === value),
      )
      .filter((row) =>
        this.inFilter ? this.inFilter[1].includes(row[this.inFilter[0]]) : true,
      )
      .slice(0, this.limitValue === Infinity ? undefined : this.limitValue);
  }

  maybeSingle() {
    return Promise.resolve({ data: this.rows()[0] ?? null, error: null });
  }

  then(
    resolve: (value: { data: unknown; error: null; count?: number }) => void,
  ) {
    const rows = this.rows();
    if (this.pendingUpdate) {
      for (const row of rows) Object.assign(row, this.pendingUpdate);
      resolve({ data: null, error: null });
      return;
    }
    resolve({
      data: this.headOnly ? null : rows,
      error: null,
      count: rows.length,
    });
  }
}

function seed(client: AdminClientMock, overrides: Partial<ItemRow> = {}) {
  const item: ItemRow = {
    id: "item-1",
    user_id: USER_ID,
    title: "Saved Reddit post in r/localfirst",
    content: LONG_BODY,
    author: null,
    searchable_text: `Content: ${LONG_BODY}`,
    embedding: null,
    indexing_status: "keyword_only",
    metadata: {
      import: { method: "reddit_export" },
      platform: {
        contentType: "post",
        community: "localfirst",
        sourceTitle: "Why CRDTs beat operational transforms",
        userText: null,
        categories: ["reddit_saved_post"],
      },
    },
    ...overrides,
  };
  client.items.push(item);
  client.records.push({
    user_id: USER_ID,
    import_id: IMPORT_ID,
    platform: "reddit",
    content_key: "reddit:t3_abc123",
    saved_item_id: item.id,
    classification_status: "pending",
  });
  return item;
}

let client: AdminClientMock;

beforeEach(() => {
  vi.clearAllMocks();
  client = new AdminClientMock();
  mocks.createAdminClient.mockReturnValue(client);
  mocks.embedDocument.mockResolvedValue({
    embedding: Array.from({ length: 768 }, () => 0.02),
    error: null,
  });
  mocks.classifyImportedItem.mockResolvedValue({
    status: "ready",
    classification: {
      summary: "A comparison of CRDTs and operational transforms.",
      topics: ["distributed systems"],
      category: "Technology",
      subcategories: [],
      keywords: ["crdt", "offline sync"],
      language: "en",
      model: "test",
      classifierVersion: "v1",
      taxonomyVersion: "v1",
    },
  });
});

describe("runClassificationPass", () => {
  it("classifies, re-indexes and re-embeds an eligible item", async () => {
    const item = seed(client);
    const result = await runClassificationPass(USER_ID, IMPORT_ID, 8);

    expect(result.ready).toBe(1);
    expect(result.remaining).toBe(0);
    expect(item.indexing_status).toBe("ready");
    expect(item.embedding).toContain("0.02");
    // Generated terms reach the index, not the source columns.
    expect(item.searchable_text).toContain("offline sync");
    expect(item.content).toBe(LONG_BODY);
  });

  it("stores generated output under its own key and leaves source fields alone", async () => {
    const item = seed(client);
    await runClassificationPass(USER_ID, IMPORT_ID, 8);

    const metadata = item.metadata as { generated?: { summary: string } };
    expect(metadata.generated?.summary).toContain("CRDTs");
    expect(item.title).toBe("Saved Reddit post in r/localfirst");
    expect(item.content).toBe(LONG_BODY);
  });

  it("shows the classifier the real title, never the display fallback", async () => {
    seed(client);
    await runClassificationPass(USER_ID, IMPORT_ID, 8);

    const input = mocks.classifyImportedItem.mock.calls[0]![0];
    expect(input.title).toBe("Why CRDTs beat operational transforms");
    expect(input.title).not.toContain("Saved Reddit post");
  });

  it("never calls the model for an item with no real text", async () => {
    seed(client, { content: null });
    const result = await runClassificationPass(USER_ID, IMPORT_ID, 8);

    expect(mocks.classifyImportedItem).not.toHaveBeenCalled();
    expect(result.insufficient).toBe(1);
    expect(client.records[0]!.classification_status).toBe(
      "insufficient_content",
    );
  });

  it("keeps the item searchable when classification fails", async () => {
    mocks.classifyImportedItem.mockResolvedValue({
      status: "failed",
      error: "Classification is temporarily unavailable.",
    });
    const item = seed(client);
    const result = await runClassificationPass(USER_ID, IMPORT_ID, 8);

    expect(result.failed).toBe(1);
    // The import stands; only the enrichment did not happen.
    expect(item.content).toBe(LONG_BODY);
    expect(item.searchable_text).toContain(LONG_BODY);
    expect(client.records[0]!.classification_status).toBe("failed");
  });

  it("keeps the item searchable when the embedding fails", async () => {
    mocks.embedDocument.mockResolvedValue({
      embedding: null,
      error: "Semantic indexing is temporarily unavailable.",
    });
    const item = seed(client);
    await runClassificationPass(USER_ID, IMPORT_ID, 8);

    expect(item.indexing_status).toBe("keyword_only");
    expect(item.searchable_text).toContain(LONG_BODY);
  });

  it("does nothing when there is nothing pending", async () => {
    const result = await runClassificationPass(USER_ID, IMPORT_ID, 8);
    expect(result.processed).toBe(0);
    expect(mocks.classifyImportedItem).not.toHaveBeenCalled();
  });

  it("refuses an import id belonging to another user", async () => {
    client.imports = [
      { id: IMPORT_ID, user_id: OTHER_USER, platform: "reddit" },
    ];
    await expect(runClassificationPass(USER_ID, IMPORT_ID, 8)).rejects.toThrow(
      /not found/i,
    );
  });

  it("never touches another user's saved item", async () => {
    const foreign = seed(client, { id: "item-2", user_id: OTHER_USER });
    await runClassificationPass(USER_ID, IMPORT_ID, 8);

    // The row is scoped to its owner, so the pass could not read it and had
    // nothing to classify.
    expect(foreign.indexing_status).toBe("keyword_only");
    expect(mocks.classifyImportedItem).not.toHaveBeenCalled();
  });
});
