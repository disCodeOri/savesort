"use client";

import { useEffect, useState } from "react";

import { runXSync, type XSyncProgress } from "@/lib/x/sync-client";

interface XConnection {
  connected: boolean;
  username: string;
  displayName: string | null;
  profileImageUrl: string | null;
  connectionStatus: "connected" | "reconnect_required";
  syncStatus: "idle" | "running" | "failed" | "rate_limited";
  lastSyncedAt: string | null;
  discoveredCount: number;
  savedCount: number;
  updatedCount: number;
  skippedCount: number;
  lastSyncError: string | null;
  rateLimitResetAt: string | null;
}

interface XConnectionPanelProps {
  onLibraryChanged(): void;
}

const FALLBACK_ERROR = "X sync failed. Try again later.";

function formatTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toLocaleString();
}

function syncOutcomeMessage(progress: XSyncProgress): string {
  if (progress.status === "complete") {
    const imported = `Imported ${progress.savedCount} new bookmark${progress.savedCount === 1 ? "" : "s"}`;
    return progress.updatedCount > 0
      ? `${imported}, refreshed ${progress.updatedCount}`
      : imported;
  }
  if (progress.status === "rate_limited") {
    const resumeAt = formatTimestamp(progress.rateLimitResetAt);
    return resumeAt
      ? `X limited requests. Sync can continue after ${resumeAt}.`
      : "X limited requests. You can continue shortly.";
  }
  if (progress.status === "reconnect_required") {
    return "Your X authorization has expired or been revoked.";
  }
  if (progress.status === "not_connected") return "Connect X to start syncing.";
  return FALLBACK_ERROR;
}

export function XConnectionPanel({ onLibraryChanged }: XConnectionPanelProps) {
  const [connection, setConnection] = useState<XConnection | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    // Reads connection state only. Syncing is never triggered by a render,
    // because every X page costs money.
    async function loadConnection() {
      try {
        const response = await fetch("/api/x/connection");
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.error ?? "X connection could not be loaded.");
        }
        setConnection(body.connection ?? null);
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : "X connection could not be loaded.",
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
  const lastSyncedAt = formatTimestamp(connection?.lastSyncedAt ?? null);
  const rateLimitedUntil = formatTimestamp(
    connection?.syncStatus === "rate_limited"
      ? connection?.rateLimitResetAt
      : null,
  );

  async function syncNow() {
    setSyncing(true);
    setMessage(null);

    try {
      const progress = await runXSync((update) => {
        if (update.status === "running") {
          setMessage(`Importing bookmarks… ${update.savedCount} saved so far`);
        }
      });
      setMessage(syncOutcomeMessage(progress));
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
        return;
      }
      if (progress.status === "complete") onLibraryChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : FALLBACK_ERROR);
    } finally {
      setSyncing(false);
    }
  }

  async function disconnect() {
    if (
      !window.confirm(
        "Disconnect X?\n\nGRAPPlin will stop syncing X bookmarks. Previously imported items, notes and tags will remain in your library.",
      )
    )
      return;

    setMessage(null);
    const response = await fetch("/api/x/connection", { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json();
      setMessage(body.error ?? "X could not be disconnected.");
      return;
    }
    setConnection(null);
  }

  if (!loaded) return null;

  return (
    <section className="connection-panel" aria-label="X connection">
      {reconnectRequired ? (
        <div className="connection-panel-status">
          <div>
            <strong>Reconnect X</strong>
            <p>Your X authorization has expired or been revoked.</p>
          </div>
          <a className="button button-secondary" href="/api/x/connect">
            Reconnect X
          </a>
        </div>
      ) : isConnected ? (
        <div className="connection-panel-status">
          <div className="connection-panel-account">
            {connection.profileImageUrl ? (
              // X serves this remote avatar directly; width and height bound its layout.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={connection.profileImageUrl}
                alt={`@${connection.username} profile image`}
                width={36}
                height={36}
              />
            ) : null}
            <div>
              <strong>@{connection.username}</strong>
              <p>
                {connection.savedCount > 0
                  ? `${connection.savedCount} bookmarks imported`
                  : "Connected. Sync to import your bookmarks."}
              </p>
              {lastSyncedAt ? <small>Last synced {lastSyncedAt}</small> : null}
              {rateLimitedUntil ? (
                <small>X limited requests until {rateLimitedUntil}</small>
              ) : null}
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
              Disconnect X
            </button>
          </div>
        </div>
      ) : (
        <div className="connection-panel-status">
          <p>Connect your X account to import your bookmarks.</p>
          <a className="button button-secondary" href="/api/x/connect">
            Connect X
          </a>
        </div>
      )}
      {syncing ? (
        <p className="connection-panel-progress" aria-live="polite">
          Importing X bookmarks…
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
