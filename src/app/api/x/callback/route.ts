import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/require-user";
import { exchangeOAuthCode, getAuthenticatedAccount } from "@/lib/x/api";
import { hasRefreshToken, saveXConnection } from "@/lib/x/connections";
import {
  clearXAttemptCookies,
  isExpectedXState,
  X_PKCE_COOKIE,
  X_STATE_COOKIE,
} from "@/lib/x/oauth-cookies";

const callbackSchema = z.object({
  code: z.string().min(1).max(512),
  state: z.string().min(1).max(256),
});

const attemptCookieSchema = z.object({
  expectedState: z.string().min(1).max(256),
  verifier: z.string().min(32).max(256),
});

function callbackRedirect(request: NextRequest, success: boolean) {
  const destination = success
    ? "/library?xConnected=1"
    : "/library?xError=authorization_failed";
  const response = NextResponse.redirect(new URL(destination, request.url));
  // Cleared on every path so an attempt can never be replayed.
  clearXAttemptCookies(response);
  return response;
}

export async function GET(request: NextRequest) {
  try {
    // The connection is bound to the *current* GRAPPlin session, so a callback
    // cannot attach an X account to a different user.
    const { user } = await requireUser();

    const parsed = callbackSchema.safeParse({
      code: request.nextUrl.searchParams.get("code"),
      state: request.nextUrl.searchParams.get("state"),
    });
    // Covers a user cancelling on X, which returns no code.
    if (!parsed.success) return callbackRedirect(request, false);

    const cookieStore = await cookies();
    const attempt = attemptCookieSchema.safeParse({
      expectedState: cookieStore.get(X_STATE_COOKIE)?.value,
      verifier: cookieStore.get(X_PKCE_COOKIE)?.value,
    });
    if (
      !attempt.success ||
      !isExpectedXState(parsed.data.state, attempt.data.expectedState)
    ) {
      return callbackRedirect(request, false);
    }

    const callbackUrl = new URL("/api/x/callback", request.url);
    const token = await exchangeOAuthCode(
      parsed.data.code,
      attempt.data.verifier,
      callbackUrl.toString(),
    );
    // Without offline.access the connection would die in hours; treat that as
    // a failed authorization rather than saving something short-lived.
    if (!hasRefreshToken(token)) return callbackRedirect(request, false);

    const account = await getAuthenticatedAccount(token.access_token);
    await saveXConnection(user.id, account, token);

    // The import deliberately does not run here: the callback stays short, and
    // the library orchestrates the bounded sync instead.
    return callbackRedirect(request, true);
  } catch {
    return callbackRedirect(request, false);
  }
}
