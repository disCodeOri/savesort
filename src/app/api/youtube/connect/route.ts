import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { getYouTubeServerConfig } from "@/lib/env";
import { unknownApiError } from "@/lib/http/responses";
import { AUTHORIZE_URL, OAUTH_SCOPES } from "@/lib/youtube/api";
import { createOAuthAttempt } from "@/lib/youtube/crypto";
import { setYouTubeAttemptCookies } from "@/lib/youtube/oauth-cookies";

export async function GET(request: NextRequest) {
  try {
    await requireUser();
    const { clientId } = getYouTubeServerConfig();
    const callbackUrl = new URL("/api/youtube/callback", request.url);
    const attempt = createOAuthAttempt();

    const authorizeUrl = new URL(AUTHORIZE_URL);
    authorizeUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl.toString(),
      response_type: "code",
      scope: OAUTH_SCOPES,
      state: attempt.state,
      // Google returns a refresh token only for an offline grant, and only on
      // the first consent unless prompt=consent forces it every time. Without
      // both, the connection would silently die after one hour.
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    }).toString();

    const response = NextResponse.redirect(authorizeUrl);
    setYouTubeAttemptCookies(response, attempt.state);
    return response;
  } catch (error) {
    return unknownApiError(error);
  }
}
