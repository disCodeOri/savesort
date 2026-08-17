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

import { hashContent } from "@/lib/obsidian/markdown";
import {
  applyNoteBatch,
  deleteNotes,
  listChanges,
  VaultNotFoundError,
} from "@/lib/obsidian/notes";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";

interface NoteRow {
  client_file_id: string;
  relative_path: string;
  content_hash: string;
  revision: number;
  deleted_at: string | null;
  updated_at: string;
}

/** Mirrors the revision and idempotency rules the SQL functions enforce. */
class AdminClientMock {
  vaultExists = true;
  readonly notes = new Map<string, NoteRow>();
  readonly rpcCalls: Array<{ name: string; values: Record<string, unknown> }> =
    [];
  failApply = false;

  from(table: string) {
    const builder = {
      select: () => builder,
      eq: () => builder,
      gt: () => builder,
      order: () => builder,
      limit: () => builder,
      update: () => builder,
      maybeSingle: () =>
        Promise.resolve({
          data:
            table === "obsidian_vaults" && this.vaultExists
              ? {
                  id: VAULT_ID,
                  name: "My Vault",
                  sync_status: "idle",
                  note_count: this.notes.size,
                  last_synced_at: null,
                  last_full_scan_at: null,
                }
              : null,
          error: null,
        }),
      then: (resolve: (result: unknown) => unknown) =>
        Promise.resolve({
          data: [...this.notes.values()],
          error: null,
        }).then(resolve),
    };
    return builder;
  }

  rpc(name: string, values: Record<string, unknown>) {
    this.rpcCalls.push({ name, values });
    if (name === "apply_obsidian_note") return this.applyNote(values);
    if (name === "delete_obsidian_note") return this.deleteNote(values);
    return Promise.resolve({ data: null, error: { message: "unknown RPC" } });
  }

  private applyNote(values: Record<string, unknown>) {
    if (this.failApply) {
      return Promise.resolve({ data: null, error: { message: "boom" } });
    }
    const fileId = String(values.p_client_file_id);
    const hash = String(values.p_content_hash);
    const path = String(values.p_relative_path);
    const base = values.p_base_revision as number | null;
    const existing = this.notes.get(fileId);

    if (existing && existing.deleted_at === null) {
      if (existing.content_hash === hash && existing.relative_path === path) {
        return Promise.resolve({
          data: { status: "unchanged", revision: existing.revision },
          error: null,
        });
      }
      if (base === null || base !== existing.revision) {
        return Promise.resolve({
          data: {
            status: "conflict",
            revision: existing.revision,
            serverContentHash: existing.content_hash,
            serverRelativePath: existing.relative_path,
          },
          error: null,
        });
      }
      existing.content_hash = hash;
      existing.relative_path = path;
      existing.revision += 1;
      existing.updated_at = new Date().toISOString();
      return Promise.resolve({
        data: { status: "updated", revision: existing.revision },
        error: null,
      });
    }

    this.notes.set(fileId, {
      client_file_id: fileId,
      relative_path: path,
      content_hash: hash,
      revision: 1,
      deleted_at: null,
      updated_at: new Date().toISOString(),
    });
    return Promise.resolve({
      data: { status: "created", revision: 1 },
      error: null,
    });
  }

  private deleteNote(values: Record<string, unknown>) {
    const existing = this.notes.get(String(values.p_client_file_id));
    if (!existing) {
      return Promise.resolve({
        data: { status: "unchanged", revision: 0 },
        error: null,
      });
    }
    if (existing.deleted_at !== null) {
      return Promise.resolve({
        data: { status: "unchanged", revision: existing.revision },
        error: null,
      });
    }
    existing.deleted_at = new Date().toISOString();
    existing.revision += 1;
    return Promise.resolve({
      data: { status: "deleted", revision: existing.revision },
      error: null,
    });
  }
}

function file(
  clientFileId: string,
  content: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    clientFileId,
    relativePath: `Projects/${clientFileId}.md`,
    content,
    contentHash: hashContent(content),
    ...overrides,
  } as Parameters<typeof applyNoteBatch>[2][number];
}

let admin: AdminClientMock;

beforeEach(() => {
  admin = new AdminClientMock();
  mocks.createAdminClient.mockReset().mockReturnValue(admin);
  mocks.embedDocument
    .mockReset()
    .mockResolvedValue({ embedding: [0.1, 0.2], error: null });
});

describe("applyNoteBatch", () => {
  it("creates notes and embeds them for semantic search", async () => {
    const results = await applyNoteBatch(USER_ID, VAULT_ID, [
      file("a", "# Alpha"),
      file("b", "# Beta"),
    ]);

    expect(results).toEqual([
      { clientFileId: "a", status: "created", revision: 1 },
      { clientFileId: "b", status: "created", revision: 1 },
    ]);
    const applied = admin.rpcCalls.filter(
      (call) => call.name === "apply_obsidian_note",
    );
    expect(applied[0]!.values.p_indexing_status).toBe("ready");
    expect(applied[0]!.values.p_title).toBe("a");
    expect(applied[0]!.values.p_open_url).toContain("obsidian://open");
  });

  it("reports an unchanged note on a retried upload without duplicating it", async () => {
    await applyNoteBatch(USER_ID, VAULT_ID, [file("a", "# Alpha")]);
    const retry = await applyNoteBatch(USER_ID, VAULT_ID, [
      file("a", "# Alpha"),
    ]);

    expect(retry[0]).toMatchObject({ status: "unchanged", revision: 1 });
    expect(admin.notes.size).toBe(1);
  });

  it("accepts an edit that is based on the current revision", async () => {
    await applyNoteBatch(USER_ID, VAULT_ID, [file("a", "# Alpha")]);

    const edited = await applyNoteBatch(USER_ID, VAULT_ID, [
      file("a", "# Alpha edited", { baseRevision: 1 }),
    ]);

    expect(edited[0]).toMatchObject({ status: "updated", revision: 2 });
  });

  it("reports a conflict instead of overwriting a newer server revision", async () => {
    await applyNoteBatch(USER_ID, VAULT_ID, [file("a", "# Alpha")]);
    await applyNoteBatch(USER_ID, VAULT_ID, [
      file("a", "# Changed elsewhere", { baseRevision: 1 }),
    ]);

    const stale = await applyNoteBatch(USER_ID, VAULT_ID, [
      file("a", "# My local edit", { baseRevision: 1 }),
    ]);

    expect(stale[0]).toMatchObject({
      status: "conflict",
      revision: 2,
      serverContentHash: hashContent("# Changed elsewhere"),
    });
    expect(admin.notes.get("a")!.content_hash).toBe(
      hashContent("# Changed elsewhere"),
    );
  });

  it("rejects a file whose content does not match its hash", async () => {
    const results = await applyNoteBatch(USER_ID, VAULT_ID, [
      file("a", "# Alpha", { contentHash: hashContent("something else") }),
    ]);

    expect(results[0]).toMatchObject({ status: "error", revision: null });
    expect(admin.notes.size).toBe(0);
  });

  it("fails one file without dropping the rest of the batch", async () => {
    const results = await applyNoteBatch(USER_ID, VAULT_ID, [
      file("a", "# Alpha"),
      file("b", "# Beta", { contentHash: hashContent("mismatch") }),
      file("c", "# Gamma"),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "created",
      "error",
      "created",
    ]);
    expect(admin.notes.size).toBe(2);
  });

  it("still stores the note when embedding is unavailable", async () => {
    mocks.embedDocument.mockResolvedValue({
      embedding: null,
      error: "down",
    });

    const results = await applyNoteBatch(USER_ID, VAULT_ID, [
      file("a", "# Alpha"),
    ]);

    expect(results[0]!.status).toBe("created");
    const applied = admin.rpcCalls.find(
      (call) => call.name === "apply_obsidian_note",
    )!;
    expect(applied.values.p_indexing_status).toBe("keyword_only");
    expect(applied.values.p_embedding).toBeNull();
  });

  it("surfaces a storage failure as a per-file error", async () => {
    admin.failApply = true;

    const results = await applyNoteBatch(USER_ID, VAULT_ID, [
      file("a", "# Alpha"),
    ]);

    expect(results[0]).toMatchObject({ status: "error", revision: null });
    expect(results[0]!.message).not.toContain("# Alpha");
  });

  it("refuses to touch a vault that is not registered to the user", async () => {
    admin.vaultExists = false;

    await expect(
      applyNoteBatch(USER_ID, VAULT_ID, [file("a", "# Alpha")]),
    ).rejects.toBeInstanceOf(VaultNotFoundError);
  });
});

describe("deleteNotes", () => {
  it("removes a note and treats a repeated delete as a no-op", async () => {
    await applyNoteBatch(USER_ID, VAULT_ID, [file("a", "# Alpha")]);

    const first = await deleteNotes(USER_ID, VAULT_ID, [{ clientFileId: "a" }]);
    const second = await deleteNotes(USER_ID, VAULT_ID, [
      { clientFileId: "a" },
    ]);

    expect(first[0]!.status).toBe("deleted");
    expect(second[0]!.status).toBe("unchanged");
  });

  it("is a no-op for a note the server never had", async () => {
    const results = await deleteNotes(USER_ID, VAULT_ID, [
      { clientFileId: "never-synced" },
    ]);

    expect(results[0]!.status).toBe("unchanged");
  });
});

describe("listChanges", () => {
  it("returns hashes and revisions but never note contents", async () => {
    await applyNoteBatch(USER_ID, VAULT_ID, [file("a", "# Secret diary")]);

    const changes = await listChanges(USER_ID, VAULT_ID, null, 100);

    expect(changes[0]).toMatchObject({
      clientFileId: "a",
      relativePath: "Projects/a.md",
      contentHash: hashContent("# Secret diary"),
      revision: 1,
      deleted: false,
    });
    expect(JSON.stringify(changes)).not.toContain("Secret diary");
  });
});
