import { NextResponse } from "next/server";

import { DEVICE_AUTH_REQUIRED } from "@/lib/desktop/require-device";

/**
 * Sync errors carry a stable machine-readable code so the client can decide
 * between retrying, backing off, and asking the user to sign in again. Messages
 * stay generic: a sync response must never echo note contents.
 */
export type SyncErrorCode =
  | "invalid_request"
  | "unauthenticated"
  | "vault_not_found"
  | "conflict"
  | "rate_limited"
  | "server_error";

const STATUS_BY_CODE: Record<SyncErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  vault_not_found: 404,
  conflict: 409,
  rate_limited: 429,
  server_error: 500,
};

export function syncError(code: SyncErrorCode, message: string) {
  return NextResponse.json(
    { error: { code, message } },
    { status: STATUS_BY_CODE[code] },
  );
}

export function unknownSyncError(error: unknown) {
  if (error instanceof Error && error.message === DEVICE_AUTH_REQUIRED) {
    return syncError("unauthenticated", "Sign in again on this device.");
  }
  return syncError("server_error", "Sync is temporarily unavailable.");
}
