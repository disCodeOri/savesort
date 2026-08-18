import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/require-user";
import {
  exchangeOAuthCode,
  getConnectedChannel,
  googleUserIdFromIdToken,
} from "@/lib/youtube/api";
import {
  hasRefreshToken,
  saveYouTubeConnection,
} from "@/lib/youtube/connections";
import {
  clearYouTubeAttemptCookies,
  isExpectedYouTubeState,
  YOUTUBE_STATE_COOKIE,
} from "@/lib/youtube/oauth-cookies";

const callbackSchema = z.object({
  code: z.string().min(1).max(512),
  state: z.string().min(1).max(256),
});

function callbackRedirect(request: NextRequest, success: boolean) {
  const destination = success
    ? "/library?youtubeConnected=1"
    : "/library?youtubeError=authorization_failed";
  const response = NextResponse.redirect(new URL(destination, request.url));
  clearYouTubeAttemptCookies(response);
  return response;
}

export async function GET(request: NextRequest) {
  try {
    const { user } = await requireUser();
    const parsed = callbackSchema.safeParse({
      code: request.nextUrl.searchParams.get("code"),
      state: request.nextUrl.searchParams.get("state"),
    });
    if (!parsed.success) return callbackRedirect(request, false);

    const cookieStore = await cookies();
    const expectedState = cookieStore.get(YOUTUBE_STATE_COOKIE)?.value;
    if (
      !expectedState ||
      !isExpectedYouTubeState(parsed.data.state, expectedState)
    ) {
      return callbackRedirect(request, false);
    }

    const callbackUrl = new URL("/api/youtube/callback", request.url);
    const token = await exchangeOAuthCode(
      parsed.data.code,
      callbackUrl.toString(),
    );
    // Without a refresh token the connection expires in an hour, so treat it
    // as a failed authorization rather than saving something short-lived.
    if (!hasRefreshToken(token)) return callbackRedirect(request, false);

    const googleUserId = token.id_token
      ? googleUserIdFromIdToken(token.id_token)
      : null;
    if (!googleUserId) return callbackRedirect(request, false);

    const channel = await getConnectedChannel(token.access_token, googleUserId);
    await saveYouTubeConnection(user.id, channel, token);
    return callbackRedirect(request, true);
  } catch {
    return callbackRedirect(request, false);
  }
}
