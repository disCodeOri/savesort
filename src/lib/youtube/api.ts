import "server-only";

import { getYouTubeServerConfig } from "@/lib/env";
import type {
  YouTubeChannel,
  YouTubeOAuthToken,
  YouTubePlaylistItemPage,
  YouTubePlaylistPage,
  YouTubeVideo,
} from "@/lib/youtube/types";

const API_URL = "https://www.googleapis.com/youtube/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
/** Read-only is all the import needs; never request write scopes. */
export const OAUTH_SCOPES =
  "https://www.googleapis.com/auth/youtube.readonly openid";
const TIMEOUT_MS = 10_000;
const PAGE_SIZE = 50;

export type YouTubeApiErrorKind =
  "unauthorized" | "rate_limited" | "provider_error";

export class YouTubeApiError extends Error {
  constructor(public readonly kind: YouTubeApiErrorKind) {
    super(messageForErrorKind(kind));
    this.name = "YouTubeApiError";
  }
}

function messageForErrorKind(kind: YouTubeApiErrorKind): string {
  if (kind === "unauthorized") {
    return "YouTube authorization was rejected. Please reconnect YouTube.";
  }
  if (kind === "rate_limited") {
    return "The YouTube API quota is exhausted. Please try again later.";
  }
  return "YouTube is unavailable. Please try again later.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getOAuthConfig() {
  try {
    return getYouTubeServerConfig();
  } catch {
    throw new YouTubeApiError("provider_error");
  }
}

function errorForResponse(response: Response): YouTubeApiError {
  if (response.status === 401) return new YouTubeApiError("unauthorized");
  // Google reports both quota exhaustion and permission problems as 403; the
  // caller cannot fix a quota error by reconnecting, so keep them distinct.
  if (response.status === 403) return new YouTubeApiError("rate_limited");
  if (response.status === 429) return new YouTubeApiError("rate_limited");
  return new YouTubeApiError("provider_error");
}

async function requestJson(
  url: string,
  options: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new YouTubeApiError("provider_error");
  }

  if (!response.ok) throw errorForResponse(response);

  try {
    return await response.json();
  } catch {
    throw new YouTubeApiError("provider_error");
  }
}

async function requestToken(form: URLSearchParams): Promise<YouTubeOAuthToken> {
  const config = getOAuthConfig();
  form.set("client_id", config.clientId);
  form.set("client_secret", config.clientSecret);

  const value = await requestJson(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
    cache: "no-store",
  });

  if (!isRecord(value)) throw new YouTubeApiError("provider_error");
  const accessToken = value.access_token;
  const expiresIn = value.expires_in;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn)
  ) {
    throw new YouTubeApiError("provider_error");
  }

  return {
    access_token: accessToken,
    ...(typeof value.refresh_token === "string" &&
    value.refresh_token.length > 0
      ? { refresh_token: value.refresh_token }
      : {}),
    expires_in: expiresIn,
    scope: typeof value.scope === "string" ? value.scope : "",
    ...(typeof value.id_token === "string" ? { id_token: value.id_token } : {}),
  };
}

export async function exchangeOAuthCode(
  code: string,
  redirectUri: string,
): Promise<YouTubeOAuthToken> {
  return requestToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  );
}

export async function refreshOAuthToken(
  refreshToken: string,
): Promise<YouTubeOAuthToken> {
  return requestToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
}

/**
 * Reads the Google account id out of the id_token. The signature is not
 * verified because the token came straight from Google's token endpoint over
 * TLS in a request we initiated — it is not attacker-supplied input.
 */
export function googleUserIdFromIdToken(idToken: string): string | null {
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return isRecord(decoded) && typeof decoded.sub === "string"
      ? decoded.sub
      : null;
  } catch {
    return null;
  }
}

function thumbnailFrom(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const size of ["medium", "high", "default", "standard", "maxres"]) {
    const entry = value[size];
    if (isRecord(entry) && typeof entry.url === "string") return entry.url;
  }
  return null;
}

function apiHeaders(accessToken: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

/** The connected user's own channel, used to label the connection. */
export async function getConnectedChannel(
  accessToken: string,
  googleUserId: string,
): Promise<YouTubeChannel> {
  const value = await requestJson(
    `${API_URL}/channels?part=snippet&mine=true`,
    { headers: apiHeaders(accessToken), cache: "no-store" },
  );

  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new YouTubeApiError("provider_error");
  }

  // A Google account without a YouTube channel is still a valid connection —
  // playlists can be empty but the account authorises fine.
  const first = value.items[0];
  if (!isRecord(first)) {
    return { googleUserId, channelId: null, title: null, thumbnailUrl: null };
  }
  const snippet = isRecord(first.snippet) ? first.snippet : {};
  return {
    googleUserId,
    channelId: optionalString(first.id),
    title: optionalString(snippet.title),
    thumbnailUrl: thumbnailFrom(snippet.thumbnails),
  };
}

export async function listPlaylistsPage(
  accessToken: string,
  pageToken: string | null,
): Promise<YouTubePlaylistPage> {
  const params = new URLSearchParams({
    part: "snippet,contentDetails",
    mine: "true",
    maxResults: String(PAGE_SIZE),
  });
  if (pageToken) params.set("pageToken", pageToken);

  const value = await requestJson(`${API_URL}/playlists?${params.toString()}`, {
    headers: apiHeaders(accessToken),
    cache: "no-store",
  });

  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new YouTubeApiError("provider_error");
  }

  const playlists = value.items.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string") return [];
    const snippet = isRecord(item.snippet) ? item.snippet : {};
    const details = isRecord(item.contentDetails) ? item.contentDetails : {};
    return [
      {
        playlistId: item.id,
        title: optionalString(snippet.title) ?? "Untitled playlist",
        itemCount:
          typeof details.itemCount === "number" &&
          Number.isFinite(details.itemCount)
            ? details.itemCount
            : 0,
        thumbnailUrl: thumbnailFrom(snippet.thumbnails),
      },
    ];
  });

  return {
    playlists,
    nextPageToken: optionalString(value.nextPageToken),
  };
}

export async function listPlaylistItemsPage(
  accessToken: string,
  playlistId: string,
  pageToken: string | null,
): Promise<YouTubePlaylistItemPage> {
  const params = new URLSearchParams({
    part: "contentDetails",
    playlistId,
    maxResults: String(PAGE_SIZE),
  });
  if (pageToken) params.set("pageToken", pageToken);

  const value = await requestJson(
    `${API_URL}/playlistItems?${params.toString()}`,
    { headers: apiHeaders(accessToken), cache: "no-store" },
  );

  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new YouTubeApiError("provider_error");
  }

  const videoIds: string[] = [];
  for (const item of value.items) {
    const details =
      isRecord(item) && isRecord(item.contentDetails)
        ? item.contentDetails
        : null;
    const videoId = details ? optionalString(details.videoId) : null;
    if (videoId) videoIds.push(videoId);
  }

  return {
    videoIds,
    skippedCount: value.items.length - videoIds.length,
    nextPageToken: optionalString(value.nextPageToken),
  };
}

/**
 * Official metadata for up to 50 ids in one call. Batching here is what keeps
 * the integration on cheap list quota instead of per-video requests.
 */
export async function listVideos(
  accessToken: string,
  videoIds: string[],
): Promise<YouTubeVideo[]> {
  if (videoIds.length === 0) return [];
  if (videoIds.length > PAGE_SIZE) {
    throw new YouTubeApiError("provider_error");
  }

  const params = new URLSearchParams({
    part: "snippet,contentDetails,statistics,status",
    id: videoIds.join(","),
    maxResults: String(PAGE_SIZE),
  });

  const value = await requestJson(`${API_URL}/videos?${params.toString()}`, {
    headers: apiHeaders(accessToken),
    cache: "no-store",
  });

  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new YouTubeApiError("provider_error");
  }

  return value.items.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string") return [];
    const snippet = isRecord(item.snippet) ? item.snippet : {};
    const details = isRecord(item.contentDetails) ? item.contentDetails : {};
    const statistics = isRecord(item.statistics) ? item.statistics : {};
    const viewCount = Number(statistics.viewCount);

    return [
      {
        videoId: item.id,
        title: optionalString(snippet.title) ?? item.id,
        description: optionalString(snippet.description),
        channelTitle: optionalString(snippet.channelTitle),
        publishedAt: optionalString(snippet.publishedAt),
        thumbnailUrl: thumbnailFrom(snippet.thumbnails),
        durationIso: optionalString(details.duration),
        viewCount: Number.isFinite(viewCount) ? viewCount : null,
        tags: Array.isArray(snippet.tags)
          ? snippet.tags.filter((tag): tag is string => typeof tag === "string")
          : [],
      },
    ];
  });
}
