import "server-only";

import { getGitHubServerConfig } from "@/lib/env";
import type {
  GitHubAuthenticatedUser,
  GitHubOAuthToken,
  GitHubStarredRepository,
} from "@/lib/github/types";

const API_URL = "https://api.github.com";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const TIMEOUT_MS = 6_000;
const API_VERSION = "2026-03-10";

export type GitHubApiErrorKind =
  "unauthorized" | "rate_limited" | "provider_error";

export class GitHubApiError extends Error {
  constructor(public readonly kind: GitHubApiErrorKind) {
    super(messageForErrorKind(kind));
    this.name = "GitHubApiError";
  }
}

function messageForErrorKind(kind: GitHubApiErrorKind): string {
  if (kind === "unauthorized") {
    return "GitHub authorization was rejected. Please reconnect GitHub.";
  }
  if (kind === "rate_limited") {
    return "GitHub is rate limited. Please try again later.";
  }
  return "GitHub is unavailable. Please try again later.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

function hasNumber(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "number" && Number.isFinite(value[key]);
}

function parseToken(value: unknown): GitHubOAuthToken | null {
  if (!isRecord(value)) return null;
  const accessToken = value.access_token;
  const expiresIn = value.expires_in;
  const refreshToken = value.refresh_token;
  const refreshTokenExpiresIn = value.refresh_token_expires_in;
  if (
    typeof accessToken !== "string" ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    (refreshToken !== undefined && typeof refreshToken !== "string") ||
    (refreshTokenExpiresIn !== undefined &&
      (typeof refreshTokenExpiresIn !== "number" ||
        !Number.isFinite(refreshTokenExpiresIn)))
  ) {
    return null;
  }

  return {
    access_token: accessToken,
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    expires_in: expiresIn,
    ...(refreshTokenExpiresIn === undefined
      ? {}
      : { refresh_token_expires_in: refreshTokenExpiresIn }),
  };
}

function parseUser(value: unknown): GitHubAuthenticatedUser | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  const login = value.login;
  const avatarUrl = value.avatar_url;
  if (
    typeof id !== "number" ||
    !Number.isFinite(id) ||
    typeof login !== "string" ||
    typeof avatarUrl !== "string"
  ) {
    return null;
  }

  return { id, login, avatar_url: avatarUrl };
}

function parseStarredRepository(
  value: unknown,
): GitHubStarredRepository | null {
  if (
    !isRecord(value) ||
    !hasString(value, "starred_at") ||
    !isRecord(value.repo)
  ) {
    return null;
  }

  const repo = value.repo;
  if (
    !hasNumber(repo, "id") ||
    !hasString(repo, "name") ||
    !hasString(repo, "full_name") ||
    !hasString(repo, "html_url") ||
    !isStringOrNull(repo.description) ||
    !isStringOrNull(repo.homepage) ||
    !isStringOrNull(repo.language) ||
    !Array.isArray(repo.topics) ||
    !repo.topics.every((topic) => typeof topic === "string") ||
    !hasNumber(repo, "stargazers_count") ||
    !hasNumber(repo, "forks_count") ||
    typeof repo.archived !== "boolean" ||
    !hasString(repo, "visibility") ||
    !isRecord(repo.owner) ||
    !hasString(repo.owner, "login") ||
    (repo.license !== undefined &&
      repo.license !== null &&
      (!isRecord(repo.license) ||
        (repo.license.spdx_id !== undefined &&
          !isStringOrNull(repo.license.spdx_id))))
  ) {
    return null;
  }

  return value as unknown as GitHubStarredRepository;
}

function errorForResponse(response: Response): GitHubApiError {
  if (response.status === 401) return new GitHubApiError("unauthorized");
  if (
    response.status === 429 ||
    (response.status === 403 &&
      response.headers.get("x-ratelimit-remaining") === "0")
  ) {
    return new GitHubApiError("rate_limited");
  }
  return new GitHubApiError("provider_error");
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
    throw new GitHubApiError("provider_error");
  }

  if (!response.ok) throw errorForResponse(response);

  try {
    return await response.json();
  } catch {
    throw new GitHubApiError("provider_error");
  }
}

function apiHeaders(accessToken: string, accept: string): HeadersInit {
  return {
    Accept: accept,
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "SaveSort/0.1",
    "X-GitHub-Api-Version": API_VERSION,
  };
}

async function requestToken(form: URLSearchParams): Promise<GitHubOAuthToken> {
  const value = await requestJson(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "SaveSort/0.1",
    },
    body: form,
    cache: "no-store",
  });
  const token = parseToken(value);
  if (!token) throw new GitHubApiError("provider_error");
  return token;
}

export async function exchangeOAuthCode(
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<GitHubOAuthToken> {
  const config = getGitHubServerConfig();
  return requestToken(
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  );
}

export async function refreshOAuthToken(
  refreshToken: string,
): Promise<GitHubOAuthToken> {
  const config = getGitHubServerConfig();
  return requestToken(
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
}

export async function getAuthenticatedGitHubUser(
  accessToken: string,
): Promise<GitHubAuthenticatedUser> {
  const value = await requestJson(`${API_URL}/user`, {
    headers: apiHeaders(accessToken, "application/vnd.github+json"),
    cache: "no-store",
  });
  const user = parseUser(value);
  if (!user) throw new GitHubApiError("provider_error");
  return user;
}

export async function listStarredRepositoriesPage(
  accessToken: string,
  page: number,
): Promise<{
  repositories: GitHubStarredRepository[];
  nextPage: number | null;
}> {
  if (!Number.isInteger(page) || page < 1) {
    throw new GitHubApiError("provider_error");
  }

  const value = await requestJson(
    `${API_URL}/user/starred?per_page=100&page=${page}`,
    {
      headers: apiHeaders(accessToken, "application/vnd.github.star+json"),
      cache: "no-store",
    },
  );
  if (!Array.isArray(value)) throw new GitHubApiError("provider_error");

  const repositories = value.map(parseStarredRepository);
  if (repositories.some((repository) => repository === null)) {
    throw new GitHubApiError("provider_error");
  }

  return {
    repositories: repositories as GitHubStarredRepository[],
    nextPage: repositories.length === 100 ? page + 1 : null,
  };
}
