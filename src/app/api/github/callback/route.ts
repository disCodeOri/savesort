import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/require-user";
import {
  exchangeOAuthCode,
  getAuthenticatedGitHubUser,
} from "@/lib/github/api";
import { saveGitHubConnection } from "@/lib/github/connections";
import {
  clearGitHubAttemptCookies,
  GITHUB_PKCE_COOKIE,
  GITHUB_STATE_COOKIE,
  isExpectedGitHubState,
} from "@/lib/github/oauth-cookies";

const callbackSchema = z.object({
  code: z.string().min(1).max(512),
  state: z.string().min(1).max(256),
});

const attemptCookieSchema = z.object({
  expectedState: z.string().min(1).max(256),
  verifier: z.string().min(1).max(256),
});

function callbackRedirect(request: NextRequest, success: boolean) {
  const destination = success
    ? "/library?githubSync=connect"
    : "/library?githubError=authorization_failed";
  const response = NextResponse.redirect(new URL(destination, request.url));
  clearGitHubAttemptCookies(response);
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
    const attempt = attemptCookieSchema.safeParse({
      expectedState: cookieStore.get(GITHUB_STATE_COOKIE)?.value,
      verifier: cookieStore.get(GITHUB_PKCE_COOKIE)?.value,
    });
    if (
      !attempt.success ||
      !isExpectedGitHubState(parsed.data.state, attempt.data.expectedState)
    ) {
      return callbackRedirect(request, false);
    }

    const callbackUrl = new URL("/api/github/callback", request.url);
    const token = await exchangeOAuthCode(
      parsed.data.code,
      attempt.data.verifier,
      callbackUrl.toString(),
    );
    const githubUser = await getAuthenticatedGitHubUser(token.access_token);
    await saveGitHubConnection(user.id, githubUser, token);
    return callbackRedirect(request, true);
  } catch {
    return callbackRedirect(request, false);
  }
}
