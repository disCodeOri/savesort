import "server-only";

import { mapWithConcurrency } from "@/lib/async/concurrency";
import { embedDocument } from "@/lib/embeddings/gemini";
import {
  buildNoteSearchableText,
  hashContent,
  noteTitle,
  obsidianOpenUrl,
} from "@/lib/obsidian/markdown";
import type { SyncFile } from "@/lib/obsidian/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

const EMBEDDING_CONCURRENCY = 4;
const INDEXING_ERROR = "Semantic indexing is temporarily unavailable.";

export type NoteResultStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "deleted"
  | "moved"
  | "missing"
  | "conflict"
  | "error";

export interface NoteResult {
  clientFileId: string;
  status: NoteResultStatus;
  revision: number | null;
  serverContentHash?: string;
  serverRelativePath?: string;
  message?: string;
}

export interface VaultSummary {
  vaultId: string;
  name: string;
  syncStatus: string;
  noteCount: number;
  lastSyncedAt: string | null;
  lastFullScanAt: string | null;
}

interface VaultRow {
  id: string;
  name: string;
  sync_status: string;
  note_count: number;
  last_synced_at: string | null;
  last_full_scan_at: string | null;
}

export class VaultNotFoundError extends Error {
  constructor() {
    super("That vault is not registered for this account.");
    this.name = "VaultNotFoundError";
  }
}

export async function registerVault(
  userId: string,
  deviceId: string,
  clientVaultId: string,
  name: string,
): Promise<VaultSummary> {
  const client = createAdminClient();
  const result = await client.rpc("register_obsidian_vault", {
    p_user_id: userId,
    p_device_id: deviceId,
    p_client_vault_id: clientVaultId,
    p_name: name,
  });
  if (result.error || !result.data) throw new Error("VAULT_REGISTER_FAILED");

  const row = result.data as {
    vault_id: string;
    name: string;
    sync_status: string;
    note_count: number;
    last_synced_at: string | null;
    last_full_scan_at: string | null;
  };
  return {
    vaultId: row.vault_id,
    name: row.name,
    syncStatus: row.sync_status,
    noteCount: row.note_count,
    lastSyncedAt: row.last_synced_at,
    lastFullScanAt: row.last_full_scan_at,
  };
}

async function loadVault(userId: string, vaultId: string): Promise<VaultRow> {
  const client = createAdminClient();
  const result = await client
    .from("obsidian_vaults")
    .select(
      "id, name, sync_status, note_count, last_synced_at, last_full_scan_at",
    )
    .eq("id", vaultId)
    .eq("user_id", userId)
    .maybeSingle();
  if (result.error) throw new Error("VAULT_LOOKUP_FAILED");
  if (!result.data) throw new VaultNotFoundError();
  return result.data as VaultRow;
}

export async function getVaultStatus(
  userId: string,
  vaultId: string,
): Promise<VaultSummary> {
  const vault = await loadVault(userId, vaultId);
  return {
    vaultId: vault.id,
    name: vault.name,
    syncStatus: vault.sync_status,
    noteCount: vault.note_count,
    lastSyncedAt: vault.last_synced_at,
    lastFullScanAt: vault.last_full_scan_at,
  };
}

interface PreparedNote {
  file: SyncFile;
  searchableText: string;
  embedding: string | null;
  indexingStatus: "ready" | "keyword_only";
  indexingError: string | null;
}

async function prepareNote(file: SyncFile): Promise<PreparedNote> {
  const searchableText = buildNoteSearchableText(
    file.relativePath,
    file.content,
  );
  try {
    const embedded = await embedDocument(searchableText);
    return {
      file,
      searchableText,
      embedding: embedded.embedding
        ? `[${embedded.embedding.join(",")}]`
        : null,
      indexingStatus: embedded.embedding ? "ready" : "keyword_only",
      indexingError: embedded.embedding ? null : INDEXING_ERROR,
    };
  } catch {
    return {
      file,
      searchableText,
      embedding: null,
      indexingStatus: "keyword_only",
      indexingError: INDEXING_ERROR,
    };
  }
}

/**
 * Applies a batch of notes. Each file succeeds or fails on its own so one bad
 * note never blocks the rest of the queue, which is what lets the client drain
 * a backlog after an outage instead of retrying the whole batch forever.
 */
export async function applyNoteBatch(
  userId: string,
  vaultId: string,
  files: SyncFile[],
): Promise<NoteResult[]> {
  const vault = await loadVault(userId, vaultId);
  const client = createAdminClient();

  // The hash is the idempotency key, so a mismatch would let a client mark a
  // note unchanged that is not. Reject it rather than trust the claim.
  const verified = files.map((file) => ({
    file,
    hashMatches: hashContent(file.content) === file.contentHash,
  }));

  const prepared = await mapWithConcurrency(
    verified.filter((entry) => entry.hashMatches).map((entry) => entry.file),
    EMBEDDING_CONCURRENCY,
    prepareNote,
  );
  const preparedByFileId = new Map(
    prepared.map((entry) => [entry.file.clientFileId, entry]),
  );

  const results: NoteResult[] = [];
  for (const entry of verified) {
    if (!entry.hashMatches) {
      results.push({
        clientFileId: entry.file.clientFileId,
        status: "error",
        revision: null,
        message: "Content hash did not match the uploaded note.",
      });
      continue;
    }

    const note = preparedByFileId.get(entry.file.clientFileId)!;
    const applied = await client.rpc("apply_obsidian_note", {
      p_user_id: userId,
      p_vault_id: vaultId,
      p_client_file_id: note.file.clientFileId,
      p_relative_path: note.file.relativePath,
      p_title: noteTitle(note.file.relativePath),
      p_content: note.file.content,
      p_content_hash: note.file.contentHash,
      p_base_revision: note.file.baseRevision ?? null,
      p_searchable_text: note.searchableText,
      p_embedding: note.embedding,
      p_indexing_status: note.indexingStatus,
      p_indexing_error: note.indexingError,
      p_open_url: obsidianOpenUrl(vault.name, note.file.relativePath),
    });

    if (applied.error || !applied.data) {
      results.push({
        clientFileId: note.file.clientFileId,
        status: "error",
        revision: null,
        message: "The server could not store this note.",
      });
      continue;
    }

    const row = applied.data as {
      status: NoteResultStatus;
      revision: number;
      serverContentHash?: string;
      serverRelativePath?: string;
    };
    results.push({
      clientFileId: note.file.clientFileId,
      status: row.status,
      revision: row.revision,
      ...(row.serverContentHash
        ? { serverContentHash: row.serverContentHash }
        : {}),
      ...(row.serverRelativePath
        ? { serverRelativePath: row.serverRelativePath }
        : {}),
    });
  }

  return results;
}

export async function deleteNotes(
  userId: string,
  vaultId: string,
  files: Array<{ clientFileId: string; baseRevision?: number | null }>,
): Promise<NoteResult[]> {
  await loadVault(userId, vaultId);
  const client = createAdminClient();
  const results: NoteResult[] = [];

  for (const file of files) {
    const deleted = await client.rpc("delete_obsidian_note", {
      p_user_id: userId,
      p_vault_id: vaultId,
      p_client_file_id: file.clientFileId,
      p_base_revision: file.baseRevision ?? null,
    });
    if (deleted.error || !deleted.data) {
      results.push({
        clientFileId: file.clientFileId,
        status: "error",
        revision: null,
        message: "The server could not remove this note.",
      });
      continue;
    }
    const row = deleted.data as {
      status: NoteResultStatus;
      revision: number;
      serverContentHash?: string;
    };
    results.push({
      clientFileId: file.clientFileId,
      status: row.status,
      revision: row.revision,
      ...(row.serverContentHash
        ? { serverContentHash: row.serverContentHash }
        : {}),
    });
  }

  return results;
}

export async function moveNotes(
  userId: string,
  vaultId: string,
  files: Array<{
    clientFileId: string;
    relativePath: string;
    baseRevision?: number | null;
  }>,
): Promise<NoteResult[]> {
  const vault = await loadVault(userId, vaultId);
  const client = createAdminClient();
  const results: NoteResult[] = [];

  for (const file of files) {
    const moved = await client.rpc("move_obsidian_note", {
      p_user_id: userId,
      p_vault_id: vaultId,
      p_client_file_id: file.clientFileId,
      p_relative_path: file.relativePath,
      p_title: noteTitle(file.relativePath),
      p_open_url: obsidianOpenUrl(vault.name, file.relativePath),
      p_base_revision: file.baseRevision ?? null,
    });
    if (moved.error || !moved.data) {
      results.push({
        clientFileId: file.clientFileId,
        status: "error",
        revision: null,
        message: "The server could not move this note.",
      });
      continue;
    }
    const row = moved.data as {
      status: NoteResultStatus;
      revision: number;
      serverRelativePath?: string;
    };
    results.push({
      clientFileId: file.clientFileId,
      status: row.status,
      revision: row.revision,
      ...(row.serverRelativePath
        ? { serverRelativePath: row.serverRelativePath }
        : {}),
    });
  }

  return results;
}

export interface RemoteChange {
  clientFileId: string;
  relativePath: string;
  contentHash: string;
  revision: number;
  deleted: boolean;
  updatedAt: string;
}

/**
 * The server's view of a vault, used by the client's reconciliation pass to
 * find notes a missed filesystem event left stale. Note bodies are never
 * returned; the client only needs hashes to decide what to re-upload.
 */
export async function listChanges(
  userId: string,
  vaultId: string,
  since: string | null,
  limit: number,
): Promise<RemoteChange[]> {
  await loadVault(userId, vaultId);
  const client = createAdminClient();
  let query = client
    .from("obsidian_notes")
    .select(
      "client_file_id, relative_path, content_hash, revision, deleted_at, updated_at",
    )
    .eq("vault_id", vaultId)
    .eq("user_id", userId)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (since) query = query.gt("updated_at", since);

  const result = await query;
  if (result.error) throw new Error("CHANGES_LOOKUP_FAILED");

  return (result.data ?? []).map((row) => {
    const note = row as {
      client_file_id: string;
      relative_path: string;
      content_hash: string;
      revision: number;
      deleted_at: string | null;
      updated_at: string;
    };
    return {
      clientFileId: note.client_file_id,
      relativePath: note.relative_path,
      contentHash: note.content_hash,
      revision: note.revision,
      deleted: note.deleted_at !== null,
      updatedAt: note.updated_at,
    };
  });
}

export async function markFullScanCompleted(
  userId: string,
  vaultId: string,
): Promise<void> {
  const client = createAdminClient();
  await client
    .from("obsidian_vaults")
    .update({ last_full_scan_at: new Date().toISOString() })
    .eq("id", vaultId)
    .eq("user_id", userId);
}
