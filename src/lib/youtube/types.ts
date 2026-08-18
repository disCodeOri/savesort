export interface YouTubeOAuthToken {
  access_token: string;
  /** Google only returns this on the first consent, or with prompt=consent. */
  refresh_token?: string;
  expires_in: number;
  scope: string;
  /** JWT carrying the Google account id in its `sub` claim. */
  id_token?: string;
}

export interface YouTubeChannel {
  /** The Google account subject, stable across channel renames. */
  googleUserId: string;
  channelId: string | null;
  title: string | null;
  thumbnailUrl: string | null;
}

export interface YouTubePlaylist {
  playlistId: string;
  title: string;
  itemCount: number;
  thumbnailUrl: string | null;
}

export interface YouTubePlaylistPage {
  playlists: YouTubePlaylist[];
  nextPageToken: string | null;
}

/** A video id plus the playlist it was found in. */
export interface YouTubePlaylistItemPage {
  videoIds: string[];
  /** Entries the API returned that had no usable video id (private/deleted). */
  skippedCount: number;
  nextPageToken: string | null;
}

export interface YouTubeVideo {
  videoId: string;
  title: string;
  description: string | null;
  channelTitle: string | null;
  publishedAt: string | null;
  thumbnailUrl: string | null;
  durationIso: string | null;
  viewCount: number | null;
  tags: string[];
}
