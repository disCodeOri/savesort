import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireDesktopSession } from "@/lib/desktop/require-device";
import { syncError, unknownSyncError } from "@/lib/http/sync-responses";
import {
  getVaultStatus,
  markFullScanCompleted,
  VaultNotFoundError,
} from "@/lib/obsidian/notes";

const statusQuerySchema = z.object({
  vaultId: z.uuid(),
  fullScanCompleted: z.enum(["true", "false"]).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const session = await requireDesktopSession(request);
    const parsed = statusQuerySchema.safeParse({
      vaultId: request.nextUrl.searchParams.get("vaultId") ?? undefined,
      fullScanCompleted:
        request.nextUrl.searchParams.get("fullScanCompleted") ?? undefined,
    });
    if (!parsed.success) {
      return syncError("invalid_request", "Check the status request.");
    }

    if (parsed.data.fullScanCompleted === "true") {
      await markFullScanCompleted(session.userId, parsed.data.vaultId);
    }
    const vault = await getVaultStatus(session.userId, parsed.data.vaultId);
    return NextResponse.json({ vault });
  } catch (error) {
    if (error instanceof VaultNotFoundError) {
      return syncError("vault_not_found", error.message);
    }
    return unknownSyncError(error);
  }
}
