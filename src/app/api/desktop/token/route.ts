import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  redeemAuthorizationCode,
  rotateRefreshToken,
} from "@/lib/desktop/sessions";
import { isLoopbackRedirectUri } from "@/lib/desktop/tokens";
import { syncError } from "@/lib/http/sync-responses";

const tokenRequestSchema = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().min(1).max(512),
    code_verifier: z.string().min(32).max(256),
    redirect_uri: z.string().min(1).max(512).refine(isLoopbackRedirectUri),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().min(1).max(512),
  }),
]);

export async function POST(request: NextRequest) {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return syncError("invalid_request", "Check the token request.");
  }

  const parsed = tokenRequestSchema.safeParse(value);
  if (!parsed.success) {
    return syncError("invalid_request", "Check the token request.");
  }

  try {
    const tokens =
      parsed.data.grant_type === "authorization_code"
        ? await redeemAuthorizationCode(
            parsed.data.code,
            parsed.data.code_verifier,
            parsed.data.redirect_uri,
          )
        : await rotateRefreshToken(parsed.data.refresh_token);

    return NextResponse.json(
      {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    // Every failure looks the same so a caller cannot probe which codes exist.
    return syncError("unauthenticated", "That sign-in could not be completed.");
  }
}
