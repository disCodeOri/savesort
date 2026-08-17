import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { getRedditServerConfig } from "@/lib/env";
import { AUTHORIZE_URL, OAUTH_SCOPES } from "@/lib/reddit/api";
import { createOAuthAttempt } from "@/lib/reddit/crypto";
import { setRedditAttemptCookies } from "@/lib/reddit/oauth-cookies";
import { unknownApiError } from "@/lib/http/responses";

export async function GET(request: NextRequest) {
  try {
    await requireUser();
    const { clientId } = getRedditServerConfig();
    const callbackUrl = new URL("/api/reddit/callback", request.url);
    const attempt = createOAuthAttempt();
    const authorizeUrl = new URL(AUTHORIZE_URL);
    authorizeUrl.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      state: attempt.state,
      redirect_uri: callbackUrl.toString(),
      // Permanent grants return a refresh token, which is what lets a later
      // sync run without sending the user back through Reddit.
      duration: "permanent",
      scope: OAUTH_SCOPES,
    }).toString();

    const response = NextResponse.redirect(authorizeUrl);
    setRedditAttemptCookies(response, attempt.state);
    return response;
  } catch (error) {
    return unknownApiError(error);
  }
}
