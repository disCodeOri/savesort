import "server-only";

import type { NextResponse } from "next/server";

import { isExpectedOAuthState } from "@/lib/crypto/secret-box";

export const GITHUB_STATE_COOKIE = "savesort_github_state";
export const GITHUB_PKCE_COOKIE = "savesort_github_pkce";

const ATTEMPT_LIFETIME_SECONDS = 600;

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

export function setGitHubAttemptCookies(
  response: NextResponse,
  state: string,
  verifier: string,
): void {
  const options = cookieOptions(ATTEMPT_LIFETIME_SECONDS);
  response.cookies.set(GITHUB_STATE_COOKIE, state, options);
  response.cookies.set(GITHUB_PKCE_COOKIE, verifier, options);
}

export function clearGitHubAttemptCookies(response: NextResponse): void {
  const options = cookieOptions(0);
  response.cookies.set(GITHUB_STATE_COOKIE, "", options);
  response.cookies.set(GITHUB_PKCE_COOKIE, "", options);
}

export function isExpectedGitHubState(
  receivedState: string,
  expectedState: string,
): boolean {
  return isExpectedOAuthState(receivedState, expectedState);
}
