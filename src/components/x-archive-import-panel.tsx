"use client";

import { useEffect, useRef, useState } from "react";

import {
  runArchiveImport,
  type ImportProgress,
  type ImportSummary,
} from "@/lib/x-archive/import-client";

interface XArchiveImportPanelProps {
  onLibraryChanged(): void;
}

const STAGE_LABEL: Record<ImportProgress["stage"], string> = {
  reading: "Reading archive…",
  analyzing: "Analysing files…",
  merging: "Merging duplicate posts…",
  importing: "Importing content…",
  done: "Complete",
};

const RELATIONSHIP_LABEL: Record<string, string> = {
  bookmark: "Bookmarks",
  like: "Likes",
  own_post: "Own posts",
  repost: "Reposts",
  reply: "Replies",
  quote_post: "Quote posts",
};

interface StoredImport {
  importId: string;
  status: string;
  archiveName: string | null;
  contentCreated: number;
  relationshipsCreated: number;
  completedAt: string | null;
}

export function XArchiveImportPanel({
  onLibraryChanged,
}: XArchiveImportPanelProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [previous, setPrevious] = useState<StoredImport | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Restores the last import so a completed run is still visible after a
    // reload, and an interrupted one is not silently forgotten.
    async function loadPrevious() {
      try {
        const response = await fetch("/api/x/archive/status");
        if (!response.ok) return;
        const body = await response.json();
        setPrevious(body.import ?? null);
      } catch {
        // A missing status is not worth surfacing; the panel still works.
      }
    }
    void loadPrevious();
  }, []);

  async function importArchive(file: File) {
    setBusy(true);
    setMessage(null);
    setSummary(null);

    try {
      const result = await runArchiveImport(file, setProgress);
      setSummary(result);
      onLibraryChanged();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The archive could not be imported.",
      );
    } finally {
      setBusy(false);
      setProgress(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function revert() {
    const importId = summary?.importId ?? previous?.importId;
    if (!importId) return;
    if (
      !window.confirm(
        "Remove this import? Posts that also came from your connected X account will stay in your library, along with any notes and tags you added.",
      )
    )
      return;

    setBusy(true);
    try {
      const response = await fetch("/api/x/archive/status", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ importId }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error ?? "The import could not be removed.");
      }
      setMessage(`Removed ${body.relationshipsRemoved ?? 0} imported entries.`);
      setSummary(null);
      setPrevious(null);
      onLibraryChanged();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The import could not be removed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="connection-panel" aria-label="X historical archive">
      <div className="connection-panel-status">
        <div>
          <strong>Import historical archive</strong>
          <p>
            Upload the ZIP that X provides to bring in older bookmarks, likes
            and posts. Your archive is read on this device — direct messages and
            account data are never uploaded.
          </p>
          {previous?.completedAt ? (
            <small>
              Last import: {new Date(previous.completedAt).toLocaleDateString()}
              {previous.relationshipsCreated
                ? ` · ${previous.relationshipsCreated} items`
                : null}
            </small>
          ) : null}
        </div>
        <div className="connection-panel-actions">
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importArchive(file);
            }}
          />
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            Choose archive…
          </button>
          {summary || previous ? (
            <button
              className="connection-panel-disconnect"
              type="button"
              disabled={busy}
              onClick={() => void revert()}
            >
              Remove import
            </button>
          ) : null}
        </div>
      </div>

      {progress ? (
        <p className="connection-panel-progress" aria-live="polite">
          {STAGE_LABEL[progress.stage]}
          {progress.stage === "importing" && progress.itemsTotal > 0
            ? ` ${progress.itemsProcessed} / ${progress.itemsTotal}`
            : null}
        </p>
      ) : null}

      {summary ? (
        <div className="x-archive-report">
          <p>
            <strong>Import complete.</strong> {summary.itemsTotal} posts
            recovered from {summary.filesProcessed} files.
          </p>
          <ul>
            {Object.entries(summary.byRelationship)
              // Only categories actually present are shown.
              .filter(([, count]) => count > 0)
              .map(([type, count]) => (
                <li key={type}>
                  <span>{RELATIONSHIP_LABEL[type] ?? type}</span>
                  <small>{count}</small>
                </li>
              ))}
            {summary.referenceOnly > 0 ? (
              <li>
                <span>Reference only (no text in archive)</span>
                <small>{summary.referenceOnly}</small>
              </li>
            ) : null}
            {summary.filesSkipped > 0 ? (
              <li>
                <span>Files skipped</span>
                <small>{summary.filesSkipped}</small>
              </li>
            ) : null}
          </ul>
          {summary.warnings.length > 0 ? (
            <p className="notice notice-info" role="status">
              Import completed with warnings. Some files could not be read.
            </p>
          ) : null}
        </div>
      ) : null}

      {message ? (
        <p className="notice notice-info" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
