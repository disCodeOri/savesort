import "server-only";

import type { NextRequest } from "next/server";

import {
  resolveAccessToken,
  type DesktopSession,
} from "@/lib/desktop/sessions";

export const DEVICE_AUTH_REQUIRED = "DEVICE_AUTH_REQUIRED";

function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) return null;
  return value.trim() || null;
}

/**
 * Authenticates a sync request from the desktop client. Browser routes keep
 * using requireUser and cookies; only the sync surface accepts device tokens.
 */
export async function requireDesktopSession(
  request: NextRequest,
): Promise<DesktopSession> {
  const token = bearerToken(request);
  if (!token) throw new Error(DEVICE_AUTH_REQUIRED);
  const session = await resolveAccessToken(token);
  if (!session) throw new Error(DEVICE_AUTH_REQUIRED);
  return session;
}
