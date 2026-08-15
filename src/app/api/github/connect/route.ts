import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { getGitHubServerConfig } from "@/lib/env";
import { createOAuthAttempt } from "@/lib/github/crypto";
import { setGitHubAttemptCookies } from "@/lib/github/oauth-cookies";
import { unknownApiError } from "@/lib/http/responses";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

export async function GET(request: NextRequest) {
  try {
    await requireUser();
    const { clientId } = getGitHubServerConfig();
    const callbackUrl = new URL("/api/github/callback", request.url);
    const attempt = createOAuthAttempt();
    const authorizeUrl = new URL(AUTHORIZE_URL);
    authorizeUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl.toString(),
      state: attempt.state,
      code_challenge: attempt.challenge,
      code_challenge_method: "S256",
    }).toString();

    const response = NextResponse.redirect(authorizeUrl);
    setGitHubAttemptCookies(response, attempt.state, attempt.verifier);
    return response;
  } catch (error) {
    return unknownApiError(error);
  }
}
