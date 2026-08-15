"use client";

import { useEffect, useState } from "react";

import {
  runGitHubSync,
  type GitHubSyncProgress,
} from "@/lib/github/sync-client";

interface GitHubConnection {
  connected: boolean;
  githubLogin: string;
  githubAvatarUrl: string | null;
  connectionStatus: "connected" | "reconnect_required";
  syncStatus: "idle" | "running" | "failed";
  lastSyncedAt: string | null;
  discoveredCount: number;
  savedCount: number;
  skippedCount: number;
  lastSyncError: string | null;
}

interface GitHubConnectionPanelProps {
  onLibraryChanged(): void;
}

const FALLBACK_ERROR = "GitHub sync failed. Try again later.";

function syncErrorMessage(progress: GitHubSyncProgress): string | null {
  if (progress.status === "complete") return null;
  if (progress.status === "reconnect_required") {
    return "GitHub access expired. Reconnect to resume syncing.";
  }
  if (progress.status === "not_connected") {
    return "Connect GitHub to start syncing.";
  }
  return FALLBACK_ERROR;
}

function formatLastSyncedAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return date.toLocaleString();
}

export function GitHubConnectionPanel({
  onLibraryChanged,
}: GitHubConnectionPanelProps) {
  const [connection, setConnection] = useState<GitHubConnection | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    async function loadConnection() {
      try {
        const response = await fetch("/api/github/connection");
        const body = await response.json();
        if (!response.ok) {
          throw new Error(
            body.error ?? "GitHub connection could not be loaded.",
          );
        }
        setConnection(body.connection ?? null);
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : "GitHub connection could not be loaded.",
        );
      } finally {
        setLoaded(true);
      }
    }

    void loadConnection();
  }, []);

  const reconnectRequired =
    connection?.connectionStatus === "reconnect_required";
  const isConnected = connection?.connected && !reconnectRequired;
  const isSyncing = syncing || connection?.syncStatus === "running";
  const lastSyncedAt = formatLastSyncedAt(connection?.lastSyncedAt ?? null);

  async function syncNow() {
    setSyncing(true);
    setMessage(null);

    try {
      const progress = await runGitHubSync(() => undefined);
      const error = syncErrorMessage(progress);
      if (error) {
        setMessage(error);
        if (progress.status === "reconnect_required") {
          setConnection((current) =>
            current
              ? {
                  ...current,
                  connected: false,
                  connectionStatus: "reconnect_required",
                }
              : current,
          );
        }
        return;
      }

      setMessage(`Saved ${progress.savedCount} new repositories`);
      onLibraryChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : FALLBACK_ERROR);
    } finally {
      setSyncing(false);
    }
  }

  async function disconnect() {
    if (
      !window.confirm(
        "Disconnect GitHub? Your saved repositories will stay in SaveSort.",
      )
    )
      return;

    setMessage(null);
    const response = await fetch("/api/github/connection", {
      method: "DELETE",
    });
    if (!response.ok) {
      const body = await response.json();
      setMessage(body.error ?? "GitHub could not be disconnected.");
      return;
    }
    setConnection(null);
  }

  if (!loaded) return null;

  return (
    <section className="github-connection-panel" aria-label="GitHub connection">
      {reconnectRequired ? (
        <div className="github-connection-status">
          <p>GitHub access expired. Reconnect to resume syncing.</p>
          <a className="button button-secondary" href="/api/github/connect">
            Reconnect GitHub
          </a>
        </div>
      ) : isConnected ? (
        <div className="github-connection-status">
          <div className="github-connection-account">
            {connection.githubAvatarUrl ? (
              // GitHub serves this remote avatar directly; width and height bound its layout.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={connection.githubAvatarUrl}
                alt={`${connection.githubLogin}'s GitHub avatar`}
                width={36}
                height={36}
              />
            ) : null}
            <div>
              <strong>{connection.githubLogin}</strong>
              <p>Stars sync after login. You can also sync them now.</p>
              {lastSyncedAt ? <small>Last synced {lastSyncedAt}</small> : null}
            </div>
          </div>
          <div className="github-connection-actions">
            <button
              className="button button-primary"
              type="button"
              disabled={isSyncing}
              onClick={() => void syncNow()}
            >
              Sync now
            </button>
            <button
              className="github-connection-disconnect"
              type="button"
              onClick={() => void disconnect()}
            >
              Disconnect GitHub
            </button>
          </div>
        </div>
      ) : (
        <div className="github-connection-status">
          <p>Connect GitHub to keep your starred repositories searchable.</p>
          <a className="button button-secondary" href="/api/github/connect">
            Connect GitHub
          </a>
        </div>
      )}
      {isSyncing ? (
        <p className="github-connection-progress" aria-live="polite">
          Syncing GitHub stars…
        </p>
      ) : null}
      {message ? (
        <p className="notice notice-info" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
