import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { getXServerConfig } from "@/lib/env";
import { unknownApiError } from "@/lib/http/responses";
import { AUTHORIZE_URL, OAUTH_SCOPES } from "@/lib/x/api";
import { createOAuthAttempt } from "@/lib/x/crypto";
import { setXAttemptCookies } from "@/lib/x/oauth-cookies";

export async function GET(request: NextRequest) {
  try {
    // X is an external account link, never a GRAPPlin login: the user must
    // already be signed in so the connection binds to the right account.
    await requireUser();
    const { clientId } = getXServerConfig();
    const callbackUrl = new URL("/api/x/callback", request.url);
    const attempt = createOAuthAttempt();

    const authorizeUrl = new URL(AUTHORIZE_URL);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: callbackUrl.toString(),
      scope: OAUTH_SCOPES,
      state: attempt.state,
      code_challenge: attempt.challenge,
      code_challenge_method: "S256",
    }).toString();

    const response = NextResponse.redirect(authorizeUrl);
    // The verifier stays in an HttpOnly cookie: it is never in a URL, never in
    // browser JavaScript, and never logged.
    setXAttemptCookies(response, attempt.state, attempt.verifier);
    return response;
  } catch (error) {
    return unknownApiError(error);
  }
}
