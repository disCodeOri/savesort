import "server-only";

import type { NextResponse } from "next/server";

import { isExpectedOAuthState } from "@/lib/crypto/secret-box";

export const REDDIT_STATE_COOKIE = "savesort_reddit_state";

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

export function setRedditAttemptCookies(
  response: NextResponse,
  state: string,
): void {
  response.cookies.set(
    REDDIT_STATE_COOKIE,
    state,
    cookieOptions(ATTEMPT_LIFETIME_SECONDS),
  );
}

export function clearRedditAttemptCookies(response: NextResponse): void {
  response.cookies.set(REDDIT_STATE_COOKIE, "", cookieOptions(0));
}

export function isExpectedRedditState(
  receivedState: string,
  expectedState: string,
): boolean {
  return isExpectedOAuthState(receivedState, expectedState);
}
