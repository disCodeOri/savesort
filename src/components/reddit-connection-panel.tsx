"use client";

import { useEffect, useState } from "react";

import {
  runRedditSync,
  type RedditSyncProgress,
} from "@/lib/reddit/sync-client";

interface RedditConnection {
  connected: boolean;
  redditUsername: string;
  redditIconUrl: string | null;
  connectionStatus: "connected" | "reconnect_required";
  syncStatus: "idle" | "running" | "failed";
  lastSyncedAt: string | null;
  discoveredCount: number;
  savedCount: number;
  skippedCount: number;
  lastSyncError: string | null;
}

interface RedditConnectionPanelProps {
  onLibraryChanged(): void;
}

const FALLBACK_ERROR = "Reddit sync failed. Try again later.";

function syncErrorMessage(progress: RedditSyncProgress): string | null {
  if (progress.status === "complete") return null;
  if (progress.status === "reconnect_required") {
    return "Reddit access expired. Reconnect to resume syncing.";
  }
  if (progress.status === "not_connected") {
    return "Connect Reddit to start syncing.";
  }
  return FALLBACK_ERROR;
}

function formatLastSyncedAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return date.toLocaleString();
}

export function RedditConnectionPanel({
  onLibraryChanged,
}: RedditConnectionPanelProps) {
  const [connection, setConnection] = useState<RedditConnection | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    async function loadConnection() {
      try {
        const response = await fetch("/api/reddit/connection");
        const body = await response.json();
        if (!response.ok) {
          throw new Error(
            body.error ?? "Reddit connection could not be loaded.",
          );
        }
        setConnection(body.connection ?? null);
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : "Reddit connection could not be loaded.",
        );
      } finally {
        setLoaded(true);
      }
    }

    void loadConnection();
    window.addEventListener("savesort:changed", loadConnection);
    return () => window.removeEventListener("savesort:changed", loadConnection);
  }, []);

  const reconnectRequired =
    connection?.connectionStatus === "reconnect_required";
  const isConnected = connection?.connected && !reconnectRequired;
  const isSyncing = connection?.syncStatus === "running" || syncing;
  const lastSyncedAt = formatLastSyncedAt(connection?.lastSyncedAt ?? null);

  async function syncNow() {
    setSyncing(true);
    setMessage(null);

    try {
      const progress = await runRedditSync(() => undefined);
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

      setMessage(`Saved ${progress.savedCount} new posts`);
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
        "Disconnect Reddit? Your saved posts will stay in SaveSort.",
      )
    )
      return;

    setMessage(null);
    const response = await fetch("/api/reddit/connection", {
      method: "DELETE",
    });
    if (!response.ok) {
      const body = await response.json();
      setMessage(body.error ?? "Reddit could not be disconnected.");
      return;
    }
    setConnection(null);
  }

  if (!loaded) return null;

  return (
    <section className="connection-panel" aria-label="Reddit connection">
      {reconnectRequired ? (
        <div className="connection-panel-status">
          <p>Reddit access expired. Reconnect to resume syncing.</p>
          <a className="button button-secondary" href="/api/reddit/connect">
            Reconnect Reddit
          </a>
        </div>
      ) : isConnected ? (
        <div className="connection-panel-status">
          <div className="connection-panel-account">
            {connection.redditIconUrl ? (
              // Reddit serves this remote avatar directly; width and height bound its layout.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={connection.redditIconUrl}
                alt={`u/${connection.redditUsername}'s Reddit avatar`}
                width={36}
                height={36}
              />
            ) : null}
            <div>
              <strong>u/{connection.redditUsername}</strong>
              <p>Saved posts sync after login. You can also sync them now.</p>
              {lastSyncedAt ? <small>Last synced {lastSyncedAt}</small> : null}
            </div>
          </div>
          <div className="connection-panel-actions">
            <button
              className="button button-primary"
              type="button"
              disabled={syncing}
              onClick={() => void syncNow()}
            >
              Sync now
            </button>
            <button
              className="connection-panel-disconnect"
              type="button"
              onClick={() => void disconnect()}
            >
              Disconnect Reddit
            </button>
          </div>
        </div>
      ) : (
        <div className="connection-panel-status">
          <p>Connect Reddit to keep your saved posts searchable.</p>
          <a className="button button-secondary" href="/api/reddit/connect">
            Connect Reddit
          </a>
        </div>
      )}
      {isSyncing ? (
        <p className="connection-panel-progress" aria-live="polite">
          Syncing Reddit saves…
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
