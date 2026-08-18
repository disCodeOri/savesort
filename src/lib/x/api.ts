import "server-only";

import { getXServerConfig } from "@/lib/env";
import type {
  XAccount,
  XBookmarkPage,
  XMedia,
  XOAuthToken,
  XPost,
  XRateLimit,
} from "@/lib/x/types";

const API_URL = "https://api.x.com/2";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const REVOKE_URL = "https://api.x.com/2/oauth2/revoke";
export const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";

/** Read-only. tweet.write / bookmark.write are deliberately never requested. */
export const OAUTH_SCOPES = [
  "tweet.read",
  "users.read",
  "bookmark.read",
  "offline.access",
].join(" ");

const TIMEOUT_MS = 15_000;
/**
 * X bills per post returned, not per request, so a larger page is not more
 * expensive — but it does mean an oversized page wastes quota if the sync is
 * abandoned. 100 is the documented maximum and the best cost/round-trip ratio.
 */
export const PAGE_SIZE = 100;

export type XApiErrorKind =
  "unauthorized" | "forbidden" | "rate_limited" | "provider_error";

export class XApiError extends Error {
  constructor(
    public readonly kind: XApiErrorKind,
    public readonly rateLimit: XRateLimit | null = null,
    /** Non-sensitive detail for the UI; never raw provider JSON. */
    public readonly detail: string | null = null,
  ) {
    super(messageForErrorKind(kind, detail));
    this.name = "XApiError";
  }
}

function messageForErrorKind(
  kind: XApiErrorKind,
  detail: string | null,
): string {
  if (kind === "unauthorized") {
    return "X authorization was rejected. Please reconnect X.";
  }
  if (kind === "forbidden") {
    return detail ?? "X refused this request.";
  }
  if (kind === "rate_limited") {
    return "X has temporarily limited requests. Syncing can continue after the limit resets.";
  }
  return "X is unavailable. Please try again later.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getOAuthConfig() {
  try {
    return getXServerConfig();
  } catch {
    throw new XApiError("provider_error");
  }
}

export function parseRateLimit(headers: Headers): XRateLimit {
  const toNumber = (value: string | null) => {
    const parsed = Number(value);
    return value !== null && Number.isFinite(parsed) ? parsed : null;
  };
  const reset = toNumber(headers.get("x-rate-limit-reset"));
  return {
    limit: toNumber(headers.get("x-rate-limit-limit")),
    remaining: toNumber(headers.get("x-rate-limit-remaining")),
    resetAt: reset === null ? null : new Date(reset * 1_000),
  };
}

/**
 * A 403 has several causes that need different user guidance, so it is worth
 * distinguishing them rather than blanket-marking the connection dead.
 */
function forbiddenDetail(body: unknown): string {
  if (isRecord(body)) {
    const detail = optionalString(body.detail) ?? optionalString(body.title);
    if (detail && /scope/i.test(detail)) {
      return "X did not grant the permissions GRAPPlin needs. Reconnect and approve bookmark access.";
    }
    if (detail && /(product|access level|plan|tier)/i.test(detail)) {
      return "Your X API access level does not permit reading bookmarks.";
    }
  }
  return "X refused this request. Check your X app's permissions and access level.";
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
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
    throw new XApiError("provider_error");
  }

  const rateLimit = parseRateLimit(response.headers);

  if (response.status === 429) {
    throw new XApiError("rate_limited", rateLimit);
  }
  if (response.status === 401) {
    throw new XApiError("unauthorized", rateLimit);
  }
  if (response.status === 403) {
    throw new XApiError(
      "forbidden",
      rateLimit,
      forbiddenDetail(await readJson(response)),
    );
  }
  if (!response.ok) {
    throw new XApiError("provider_error", rateLimit);
  }

  const body = await readJson(response);
  if (body === null) throw new XApiError("provider_error", rateLimit);
  return body;
}

/**
 * X authenticates confidential clients with HTTP Basic at the token endpoint.
 * The secret never leaves the server.
 */
function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

async function requestToken(form: URLSearchParams): Promise<XOAuthToken> {
  const config = getOAuthConfig();
  form.set("client_id", config.clientId);

  const value = await requestJson(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: basicAuthHeader(config.clientId, config.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
    cache: "no-store",
  });

  if (!isRecord(value)) throw new XApiError("provider_error");
  const accessToken = value.access_token;
  const expiresIn = value.expires_in;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn)
  ) {
    throw new XApiError("provider_error");
  }

  return {
    access_token: accessToken,
    ...(typeof value.refresh_token === "string" &&
    value.refresh_token.length > 0
      ? { refresh_token: value.refresh_token }
      : {}),
    expires_in: expiresIn,
    scope: typeof value.scope === "string" ? value.scope : "",
    token_type:
      typeof value.token_type === "string" ? value.token_type : "bearer",
  };
}

export async function exchangeOAuthCode(
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<XOAuthToken> {
  return requestToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  );
}

export async function refreshOAuthToken(
  refreshToken: string,
): Promise<XOAuthToken> {
  return requestToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
}

/** Best-effort: a failed revoke must not block local disconnection. */
export async function revokeToken(token: string): Promise<void> {
  const config = getOAuthConfig();
  try {
    await fetch(REVOKE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: basicAuthHeader(config.clientId, config.clientSecret),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        token,
        client_id: config.clientId,
        token_type_hint: "access_token",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    // Ignored deliberately; see disconnectX.
  }
}

function apiHeaders(accessToken: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

function parseAccount(value: unknown): XAccount | null {
  if (!isRecord(value)) return null;
  const id = optionalString(value.id);
  const username = optionalString(value.username);
  if (!id || !username) return null;
  return {
    id,
    username,
    name: optionalString(value.name),
    profileImageUrl: optionalString(value.profile_image_url),
  };
}

/** The connected identity always comes from the token, never from the client. */
export async function getAuthenticatedAccount(
  accessToken: string,
): Promise<XAccount> {
  const value = await requestJson(
    `${API_URL}/users/me?user.fields=profile_image_url,name,username`,
    { headers: apiHeaders(accessToken), cache: "no-store" },
  );
  const account = isRecord(value) ? parseAccount(value.data) : null;
  if (!account) throw new XApiError("provider_error");
  return account;
}

function parsePost(value: unknown): XPost | null {
  if (!isRecord(value)) return null;
  const id = optionalString(value.id);
  if (!id) return null;

  const entities = isRecord(value.entities) ? value.entities : {};
  const urls = Array.isArray(entities.urls)
    ? entities.urls.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        // expanded_url is the real destination; unwound_url is better still
        // when X has followed the redirect chain for us.
        const expanded =
          optionalString(entry.unwound_url) ??
          optionalString(entry.expanded_url);
        return expanded ? [expanded] : [];
      })
    : [];

  const attachments = isRecord(value.attachments) ? value.attachments : {};
  const mediaKeys = Array.isArray(attachments.media_keys)
    ? attachments.media_keys.filter(
        (key): key is string => typeof key === "string",
      )
    : [];

  const referencedPostIds = Array.isArray(value.referenced_tweets)
    ? value.referenced_tweets.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const referencedId = optionalString(entry.id);
        return referencedId ? [referencedId] : [];
      })
    : [];

  return {
    id,
    text: typeof value.text === "string" ? value.text : "",
    authorId: optionalString(value.author_id),
    createdAt: optionalString(value.created_at),
    lang: optionalString(value.lang),
    conversationId: optionalString(value.conversation_id),
    urls: [...new Set(urls)],
    mediaKeys,
    referencedPostIds,
  };
}

function parseMedia(value: unknown): XMedia | null {
  if (!isRecord(value)) return null;
  const mediaKey = optionalString(value.media_key);
  if (!mediaKey) return null;
  return {
    mediaKey,
    type: optionalString(value.type) ?? "unknown",
    previewImageUrl:
      optionalString(value.preview_image_url) ?? optionalString(value.url),
    altText: optionalString(value.alt_text),
  };
}

/**
 * One page of the authenticated user's bookmarks.
 *
 * Every field requested here earns its place in retrieval. Engagement metrics
 * are deliberately omitted: they cost payload and tell search nothing.
 * Authors, media and referenced posts come back as expansions in this same
 * response, so no follow-up lookups are ever needed — which matters because X
 * bills per post returned.
 */
export async function listBookmarksPage(
  accessToken: string,
  xUserId: string,
  paginationToken: string | null,
): Promise<XBookmarkPage> {
  const params = new URLSearchParams({
    max_results: String(PAGE_SIZE),
    "tweet.fields": [
      "id",
      "text",
      "author_id",
      "created_at",
      "lang",
      "conversation_id",
      "entities",
      "referenced_tweets",
      "attachments",
    ].join(","),
    expansions: [
      "author_id",
      "attachments.media_keys",
      "referenced_tweets.id",
      "referenced_tweets.id.author_id",
    ].join(","),
    "user.fields": ["username", "name", "profile_image_url"].join(","),
    "media.fields": [
      "media_key",
      "type",
      "preview_image_url",
      "url",
      "alt_text",
    ].join(","),
  });
  if (paginationToken) params.set("pagination_token", paginationToken);

  const value = await requestJson(
    `${API_URL}/users/${encodeURIComponent(xUserId)}/bookmarks?${params.toString()}`,
    { headers: apiHeaders(accessToken), cache: "no-store" },
  );

  if (!isRecord(value)) throw new XApiError("provider_error");

  const data = Array.isArray(value.data) ? value.data : [];
  const includes = isRecord(value.includes) ? value.includes : {};
  const meta = isRecord(value.meta) ? value.meta : {};

  const authorsById = new Map<string, XAccount>();
  if (Array.isArray(includes.users)) {
    for (const entry of includes.users) {
      const account = parseAccount(entry);
      if (account) authorsById.set(account.id, account);
    }
  }

  const mediaByKey = new Map<string, XMedia>();
  if (Array.isArray(includes.media)) {
    for (const entry of includes.media) {
      const media = parseMedia(entry);
      if (media) mediaByKey.set(media.mediaKey, media);
    }
  }

  const referencedPostsById = new Map<string, XPost>();
  if (Array.isArray(includes.tweets)) {
    for (const entry of includes.tweets) {
      const post = parsePost(entry);
      if (post) referencedPostsById.set(post.id, post);
    }
  }

  const posts = data.flatMap((entry) => {
    const post = parsePost(entry);
    return post ? [post] : [];
  });

  return {
    posts,
    authorsById,
    mediaByKey,
    referencedPostsById,
    nextToken: optionalString(meta.next_token),
    resultCount: data.length,
  };
}
