import { NextRequest, NextResponse } from "next/server";

import { requireDesktopSession } from "@/lib/desktop/require-device";
import { syncError, unknownSyncError } from "@/lib/http/sync-responses";
import { deleteNotes, VaultNotFoundError } from "@/lib/obsidian/notes";
import { syncDeleteSchema } from "@/lib/obsidian/schemas";

export async function POST(request: NextRequest) {
  try {
    const session = await requireDesktopSession(request);

    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return syncError("invalid_request", "Check the delete request.");
    }

    const parsed = syncDeleteSchema.safeParse(value);
    if (!parsed.success) {
      return syncError("invalid_request", "Check the delete request.");
    }

    const results = await deleteNotes(
      session.userId,
      parsed.data.vaultId,
      parsed.data.files,
    );
    return NextResponse.json({ results });
  } catch (error) {
    if (error instanceof VaultNotFoundError) {
      return syncError("vault_not_found", error.message);
    }
    return unknownSyncError(error);
  }
}
