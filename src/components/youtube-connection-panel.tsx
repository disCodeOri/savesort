"use client";

import { useEffect, useState } from "react";

import {
  runYouTubeEnrichment,
  runYouTubeSync,
  type YouTubeSyncProgress,
} from "@/lib/youtube/sync-client";

interface YouTubeConnection {
  connected: boolean;
  channelId: string | null;
  channelTitle: string | null;
  channelThumbnailUrl: string | null;
  connectionStatus: "connected" | "reconnect_required";
  syncStatus: "idle" | "running" | "failed";
  lastSyncedAt: string | null;
  discoveredCount: number;
  savedCount: number;
  skippedCount: number;
  lastSyncError: string | null;
}

interface Playlist {
  playlistId: string;
  title: string;
  itemCount: number;
  thumbnailUrl: string | null;
  selected: boolean;
}

interface YouTubeConnectionPanelProps {
  onLibraryChanged(): void;
}

const FALLBACK_ERROR = "YouTube sync failed. Try again later.";

function syncErrorMessage(progress: YouTubeSyncProgress): string | null {
  if (progress.status === "complete") return null;
  if (progress.status === "reconnect_required") {
    return "YouTube access expired. Reconnect to resume syncing.";
  }
  if (progress.status === "not_connected") {
    return "Connect YouTube to start syncing.";
  }
  if (progress.status === "no_playlists") {
    return "Choose at least one playlist to sync.";
  }
  return FALLBACK_ERROR;
}

function formatLastSyncedAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toLocaleString();
}

export function YouTubeConnectionPanel({
  onLibraryChanged,
}: YouTubeConnectionPanelProps) {
  const [connection, setConnection] = useState<YouTubeConnection | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    async function loadConnection() {
      try {
        const response = await fetch("/api/youtube/connection");
        const body = await response.json();
        if (!response.ok) {
          throw new Error(
            body.error ?? "YouTube connection could not be loaded.",
          );
        }
        setConnection(body.connection ?? null);
        if (body.connection?.connected) {
          const stored = await fetch("/api/youtube/playlists");
          const playlistBody = await stored.json();
          if (stored.ok) setPlaylists(playlistBody.playlists ?? []);
        }
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : "YouTube connection could not be loaded.",
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
  const lastSyncedAt = formatLastSyncedAt(connection?.lastSyncedAt ?? null);
  const selectedCount = playlists.filter(
    (playlist) => playlist.selected,
  ).length;

  async function refreshPlaylists() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/youtube/playlists?refresh=1");
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error ?? "Playlists could not be loaded.");
      }
      setPlaylists(body.playlists ?? []);
      setMessage(`Found ${body.playlists?.length ?? 0} playlists`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : FALLBACK_ERROR);
    } finally {
      setBusy(false);
    }
  }

  async function togglePlaylist(playlistId: string) {
    const next = playlists.map((playlist) =>
      playlist.playlistId === playlistId
        ? { ...playlist, selected: !playlist.selected }
        : playlist,
    );
    setPlaylists(next);

    const response = await fetch("/api/youtube/playlists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playlistIds: next
          .filter((playlist) => playlist.selected)
          .map((playlist) => playlist.playlistId),
      }),
    });
    if (!response.ok) {
      setMessage("Playlist selection could not be saved.");
      // Re-read through the shared event so the panel and the rest of the
      // library stay consistent after a rejected change.
      window.dispatchEvent(new Event("savesort:changed"));
    }
  }

  async function syncNow() {
    setBusy(true);
    setMessage(null);

    try {
      const progress = await runYouTubeSync(() => undefined);
      const error = syncErrorMessage(progress);
      if (error) {
        setMessage(error);
        return;
      }

      setMessage(`Imported ${progress.savedCount} videos. Analysing…`);
      onLibraryChanged();

      // Videos are already searchable by title; this pass adds the Gemini
      // description so they are findable by content too.
      const enrichment = await runYouTubeEnrichment((batch) => {
        setMessage(`Analysing videos… ${batch.remaining} remaining`);
      });
      setMessage(
        `Imported ${progress.savedCount} videos, analysed ${enrichment.ready}`,
      );
      onLibraryChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : FALLBACK_ERROR);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (
      !window.confirm(
        "Disconnect YouTube? Your imported videos will stay in SaveSort.",
      )
    )
      return;

    setMessage(null);
    const response = await fetch("/api/youtube/connection", {
      method: "DELETE",
    });
    if (!response.ok) {
      const body = await response.json();
      setMessage(body.error ?? "YouTube could not be disconnected.");
      return;
    }
    setConnection(null);
    setPlaylists([]);
  }

  if (!loaded) return null;

  return (
    <section className="connection-panel" aria-label="YouTube connection">
      {reconnectRequired ? (
        <div className="connection-panel-status">
          <p>YouTube access expired. Reconnect to resume syncing.</p>
          <a className="button button-secondary" href="/api/youtube/connect">
            Reconnect YouTube
          </a>
        </div>
      ) : isConnected ? (
        <>
          <div className="connection-panel-status">
            <div className="connection-panel-account">
              {connection.channelThumbnailUrl ? (
                // YouTube serves this remote avatar directly; width and height bound its layout.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={connection.channelThumbnailUrl}
                  alt={`${connection.channelTitle ?? "YouTube"} channel avatar`}
                  width={36}
                  height={36}
                />
              ) : null}
              <div>
                <strong>
                  {connection.channelTitle ?? "YouTube connected"}
                </strong>
                <p>
                  {selectedCount > 0
                    ? `${selectedCount} playlist${selectedCount === 1 ? "" : "s"} selected`
                    : "Choose playlists to sync."}
                </p>
                {lastSyncedAt ? (
                  <small>Last synced {lastSyncedAt}</small>
                ) : null}
              </div>
            </div>
            <div className="connection-panel-actions">
              <button
                className="button button-primary"
                type="button"
                disabled={busy || selectedCount === 0}
                onClick={() => void syncNow()}
              >
                Sync now
              </button>
              <button
                className="button button-secondary"
                type="button"
                disabled={busy}
                onClick={() => void refreshPlaylists()}
              >
                Refresh playlists
              </button>
              <button
                className="connection-panel-disconnect"
                type="button"
                onClick={() => void disconnect()}
              >
                Disconnect YouTube
              </button>
            </div>
          </div>
          {playlists.length > 0 ? (
            <ul className="youtube-playlist-list">
              {playlists.map((playlist) => (
                <li key={playlist.playlistId}>
                  <label>
                    <input
                      type="checkbox"
                      checked={playlist.selected}
                      disabled={busy}
                      onChange={() => void togglePlaylist(playlist.playlistId)}
                    />
                    <span>{playlist.title}</span>
                    <small>{playlist.itemCount} videos</small>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <div className="connection-panel-status">
          <p>Connect YouTube to make your saved playlists searchable.</p>
          <a className="button button-secondary" href="/api/youtube/connect">
            Connect YouTube
          </a>
        </div>
      )}
      {busy ? (
        <p className="connection-panel-progress" aria-live="polite">
          Working…
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
