import { NextRequest, NextResponse } from "next/server";

import { requireDesktopSession } from "@/lib/desktop/require-device";
import { revokeDevice } from "@/lib/desktop/sessions";
import { unknownSyncError } from "@/lib/http/sync-responses";

/** Signing out on the desktop revokes only that device's tokens. */
export async function POST(request: NextRequest) {
  try {
    const session = await requireDesktopSession(request);
    await revokeDevice(session.deviceId);
    return NextResponse.json({ revoked: true });
  } catch (error) {
    return unknownSyncError(error);
  }
}
