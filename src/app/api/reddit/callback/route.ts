import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/require-user";
import { exchangeOAuthCode, getRedditIdentity } from "@/lib/reddit/api";
import {
  isPermanentGrant,
  saveRedditConnection,
} from "@/lib/reddit/connections";
import {
  clearRedditAttemptCookies,
  isExpectedRedditState,
  REDDIT_STATE_COOKIE,
} from "@/lib/reddit/oauth-cookies";

const callbackSchema = z.object({
  code: z.string().min(1).max(512),
  state: z.string().min(1).max(256),
});

const attemptCookieSchema = z.object({
  expectedState: z.string().min(1).max(256),
});

function callbackRedirect(request: NextRequest, success: boolean) {
  const destination = success
    ? "/library?redditSync=connect"
    : "/library?redditError=authorization_failed";
  const response = NextResponse.redirect(new URL(destination, request.url));
  clearRedditAttemptCookies(response);
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
      expectedState: cookieStore.get(REDDIT_STATE_COOKIE)?.value,
    });
    if (
      !attempt.success ||
      !isExpectedRedditState(parsed.data.state, attempt.data.expectedState)
    ) {
      return callbackRedirect(request, false);
    }

    const callbackUrl = new URL("/api/reddit/callback", request.url);
    const token = await exchangeOAuthCode(
      parsed.data.code,
      callbackUrl.toString(),
    );
    // Without a refresh token the connection would break after one hour, so
    // treat a temporary grant as a failed authorization and ask again.
    if (!isPermanentGrant(token)) return callbackRedirect(request, false);

    const identity = await getRedditIdentity(token.access_token);
    await saveRedditConnection(user.id, identity, token);
    return callbackRedirect(request, true);
  } catch {
    return callbackRedirect(request, false);
  }
}
