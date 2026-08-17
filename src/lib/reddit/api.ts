import "server-only";

import { getRedditServerConfig } from "@/lib/env";
import type {
  RedditIdentity,
  RedditOAuthToken,
  RedditSavedPage,
  RedditSavedPost,
} from "@/lib/reddit/types";

const API_URL = "https://oauth.reddit.com";
const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
export const AUTHORIZE_URL = "https://www.reddit.com/api/v1/authorize";
export const OAUTH_SCOPES = "identity history";
const TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 256;

export type RedditApiErrorKind =
  "unauthorized" | "rate_limited" | "provider_error";

export class RedditApiError extends Error {
  constructor(public readonly kind: RedditApiErrorKind) {
    super(messageForErrorKind(kind));
    this.name = "RedditApiError";
  }
}

function messageForErrorKind(kind: RedditApiErrorKind): string {
  if (kind === "unauthorized") {
    return "Reddit authorization was rejected. Please reconnect Reddit.";
  }
  if (kind === "rate_limited") {
    return "Reddit is rate limited. Please try again later.";
  }
  return "Reddit is unavailable. Please try again later.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getOAuthConfig() {
  try {
    return getRedditServerConfig();
  } catch {
    throw new RedditApiError("provider_error");
  }
}

function errorForResponse(response: Response): RedditApiError {
  if (response.status === 401 || response.status === 403) {
    return new RedditApiError("unauthorized");
  }
  if (response.status === 429) return new RedditApiError("rate_limited");
  return new RedditApiError("provider_error");
}

/**
 * Reddit answers a rejected code or a revoked refresh token with HTTP 200 and
 * an `error` field, so a successful status alone does not mean success.
 */
function errorForTokenBody(value: Record<string, unknown>): RedditApiError {
  const code = value.error;
  if (code === "invalid_grant" || code === "unsupported_grant_type") {
    return new RedditApiError("unauthorized");
  }
  return new RedditApiError("provider_error");
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
    throw new RedditApiError("provider_error");
  }

  if (!response.ok) throw errorForResponse(response);

  try {
    return await response.json();
  } catch {
    throw new RedditApiError("provider_error");
  }
}

function apiHeaders(accessToken: string, userAgent: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": userAgent,
  };
}

async function requestToken(form: URLSearchParams): Promise<RedditOAuthToken> {
  const config = getOAuthConfig();
  const basic = Buffer.from(
    `${config.clientId}:${config.clientSecret}`,
  ).toString("base64");
  const value = await requestJson(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": config.userAgent,
    },
    body: form,
    cache: "no-store",
  });

  if (!isRecord(value)) throw new RedditApiError("provider_error");
  if (value.error !== undefined) throw errorForTokenBody(value);

  const accessToken = value.access_token;
  const expiresIn = value.expires_in;
  const refreshToken = value.refresh_token;
  const scope = value.scope;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    typeof scope !== "string" ||
    (refreshToken !== undefined && typeof refreshToken !== "string")
  ) {
    throw new RedditApiError("provider_error");
  }

  return {
    access_token: accessToken,
    ...(typeof refreshToken === "string" && refreshToken.length > 0
      ? { refresh_token: refreshToken }
      : {}),
    expires_in: expiresIn,
    scope,
  };
}

export async function exchangeOAuthCode(
  code: string,
  redirectUri: string,
): Promise<RedditOAuthToken> {
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
): Promise<RedditOAuthToken> {
  return requestToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
}

/**
 * Resolves the connected account from the token itself. The username is never
 * accepted from the client, because saved listings are private per account.
 */
export async function getRedditIdentity(
  accessToken: string,
): Promise<RedditIdentity> {
  const config = getOAuthConfig();
  const value = await requestJson(`${API_URL}/api/v1/me?raw_json=1`, {
    headers: apiHeaders(accessToken, config.userAgent),
    cache: "no-store",
  });

  if (!isRecord(value)) throw new RedditApiError("provider_error");
  const id = value.id;
  const name = value.name;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof name !== "string" ||
    name.length === 0
  ) {
    throw new RedditApiError("provider_error");
  }

  const iconImg = optionalString(value.icon_img);
  return {
    id,
    name,
    icon_img: iconImg && iconImg.length > 0 ? iconImg : null,
  };
}

function parseSavedPost(child: unknown): RedditSavedPost | null {
  if (!isRecord(child) || child.kind !== "t3" || !isRecord(child.data)) {
    return null;
  }

  const data = child.data;
  const id = data.id;
  const name = data.name;
  const permalink = data.permalink;
  const title = data.title;
  const subreddit = data.subreddit;
  const author = data.author;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof permalink !== "string" ||
    // A protocol-relative path would resolve to another host entirely.
    !permalink.startsWith("/") ||
    permalink.startsWith("//") ||
    typeof title !== "string" ||
    typeof subreddit !== "string" ||
    typeof author !== "string"
  ) {
    return null;
  }

  return {
    id,
    name,
    permalink,
    title,
    subreddit,
    subreddit_name_prefixed:
      optionalString(data.subreddit_name_prefixed) ?? `r/${subreddit}`,
    author,
    url: optionalString(data.url),
    selftext: optionalString(data.selftext),
    link_flair_text: optionalString(data.link_flair_text),
    thumbnail: optionalString(data.thumbnail),
    score: finiteNumber(data.score),
    num_comments: finiteNumber(data.num_comments),
    created_utc: finiteNumber(data.created_utc),
    over_18: data.over_18 === true,
    is_self: data.is_self === true,
  };
}

function parseNextCursor(value: unknown, requestedCursor: string | null) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > MAX_CURSOR_LENGTH) {
    throw new RedditApiError("provider_error");
  }
  // A cursor that does not move would page forever, so stop instead.
  return value === requestedCursor ? null : value;
}

/**
 * Reads one page of the connected account's saved link posts. `type=links`
 * drops saved comments, which SaveSort has no URL to index.
 */
export async function listSavedPostsPage(
  accessToken: string,
  username: string,
  cursor: string | null,
): Promise<RedditSavedPage> {
  if (!username) throw new RedditApiError("provider_error");
  const config = getOAuthConfig();
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    type: "links",
    raw_json: "1",
  });
  if (cursor) params.set("after", cursor);

  const value = await requestJson(
    `${API_URL}/user/${encodeURIComponent(username)}/saved?${params.toString()}`,
    {
      headers: apiHeaders(accessToken, config.userAgent),
      cache: "no-store",
    },
  );

  if (!isRecord(value) || value.kind !== "Listing" || !isRecord(value.data)) {
    throw new RedditApiError("provider_error");
  }

  const children = value.data.children;
  if (!Array.isArray(children) || children.length > PAGE_SIZE) {
    throw new RedditApiError("provider_error");
  }

  return {
    posts: children
      .map(parseSavedPost)
      .filter((post): post is RedditSavedPost => post !== null),
    discoveredCount: children.length,
    nextCursor: parseNextCursor(value.data.after, cursor),
  };
}
