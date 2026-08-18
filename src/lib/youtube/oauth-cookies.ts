import "server-only";

import type { NextResponse } from "next/server";

import { isExpectedOAuthState } from "@/lib/crypto/secret-box";

export const YOUTUBE_STATE_COOKIE = "savesort_youtube_state";

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

export function setYouTubeAttemptCookies(
  response: NextResponse,
  state: string,
): void {
  response.cookies.set(
    YOUTUBE_STATE_COOKIE,
    state,
    cookieOptions(ATTEMPT_LIFETIME_SECONDS),
  );
}

export function clearYouTubeAttemptCookies(response: NextResponse): void {
  response.cookies.set(YOUTUBE_STATE_COOKIE, "", cookieOptions(0));
}

export function isExpectedYouTubeState(
  receivedState: string,
  expectedState: string,
): boolean {
  return isExpectedOAuthState(receivedState, expectedState);
}
