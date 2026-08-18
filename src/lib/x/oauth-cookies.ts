import "server-only";

import type { NextResponse } from "next/server";

import { isExpectedOAuthState } from "@/lib/crypto/secret-box";

export const X_STATE_COOKIE = "savesort_x_state";
export const X_PKCE_COOKIE = "savesort_x_pkce";

/**
 * Short lifetime keeps the authorization attempt genuinely single-use in
 * practice: an abandoned attempt expires rather than lingering as a replayable
 * credential.
 */
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

export function setXAttemptCookies(
  response: NextResponse,
  state: string,
  verifier: string,
): void {
  const options = cookieOptions(ATTEMPT_LIFETIME_SECONDS);
  response.cookies.set(X_STATE_COOKIE, state, options);
  response.cookies.set(X_PKCE_COOKIE, verifier, options);
}

/** Always cleared on the callback, success or failure, so it cannot be reused. */
export function clearXAttemptCookies(response: NextResponse): void {
  const options = cookieOptions(0);
  response.cookies.set(X_STATE_COOKIE, "", options);
  response.cookies.set(X_PKCE_COOKIE, "", options);
}

export function isExpectedXState(
  receivedState: string,
  expectedState: string,
): boolean {
  return isExpectedOAuthState(receivedState, expectedState);
}
