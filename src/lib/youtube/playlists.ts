import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { listPlaylistsPage } from "@/lib/youtube/api";
import { getValidYouTubeAccessToken } from "@/lib/youtube/connections";

const MAX_PLAYLIST_PAGES = 20;

export interface StoredPlaylist {
  playlistId: string;
  title: string;
  itemCount: number;
  thumbnailUrl: string | null;
  selected: boolean;
}

/**
 * Re-reads every playlist from YouTube and stores it, keeping whichever ones
 * the user had already selected. Playlists deleted upstream disappear here.
 */
export async function refreshPlaylists(
  userId: string,
): Promise<StoredPlaylist[]> {
  const accessToken = await getValidYouTubeAccessToken(userId);
  const discovered = [];
  let pageToken: string | null = null;

  for (let page = 0; page < MAX_PLAYLIST_PAGES; page += 1) {
    const result = await listPlaylistsPage(accessToken, pageToken);
    discovered.push(...result.playlists);
    pageToken = result.nextPageToken;
    if (!pageToken) break;
  }

  const client = createAdminClient();
  const stored = await client.rpc("replace_youtube_playlists", {
    p_user_id: userId,
    p_playlists: discovered,
  });
  if (stored.error) throw new Error("Playlists could not be stored.");

  return listStoredPlaylists(userId);
}

export async function listStoredPlaylists(
  userId: string,
): Promise<StoredPlaylist[]> {
  const client = createAdminClient();
  const result = await client
    .from("youtube_playlists")
    .select("playlist_id, title, item_count, thumbnail_url, selected")
    .eq("user_id", userId)
    .order("title", { ascending: true });
  if (result.error) throw new Error("Playlists could not be loaded.");

  return (result.data ?? []).map((row) => {
    const playlist = row as {
      playlist_id: string;
      title: string;
      item_count: number;
      thumbnail_url: string | null;
      selected: boolean;
    };
    return {
      playlistId: playlist.playlist_id,
      title: playlist.title,
      itemCount: playlist.item_count,
      thumbnailUrl: playlist.thumbnail_url,
      selected: playlist.selected,
    };
  });
}

export async function setPlaylistSelection(
  userId: string,
  playlistIds: string[],
): Promise<void> {
  const client = createAdminClient();
  const result = await client.rpc("set_youtube_playlist_selection", {
    p_user_id: userId,
    p_playlist_ids: playlistIds,
  });
  if (result.error) throw new Error("Playlist selection could not be saved.");
}

export async function selectedPlaylistIds(userId: string): Promise<string[]> {
  const client = createAdminClient();
  const result = await client
    .from("youtube_playlists")
    .select("playlist_id")
    .eq("user_id", userId)
    .eq("selected", true)
    .order("playlist_id", { ascending: true });
  if (result.error) throw new Error("Playlist selection could not be loaded.");
  return (result.data ?? []).map(
    (row) => (row as { playlist_id: string }).playlist_id,
  );
}
