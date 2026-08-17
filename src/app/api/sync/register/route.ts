import { NextRequest, NextResponse } from "next/server";

import { requireDesktopSession } from "@/lib/desktop/require-device";
import { syncError, unknownSyncError } from "@/lib/http/sync-responses";
import { registerVault } from "@/lib/obsidian/notes";
import { registerVaultSchema } from "@/lib/obsidian/schemas";

export async function POST(request: NextRequest) {
  try {
    const session = await requireDesktopSession(request);

    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return syncError("invalid_request", "Check the vault registration.");
    }

    const parsed = registerVaultSchema.safeParse(value);
    if (!parsed.success) {
      return syncError("invalid_request", "Check the vault registration.");
    }

    const vault = await registerVault(
      session.userId,
      session.deviceId,
      parsed.data.clientVaultId,
      parsed.data.name,
    );
    return NextResponse.json({ vault });
  } catch (error) {
    return unknownSyncError(error);
  }
}
