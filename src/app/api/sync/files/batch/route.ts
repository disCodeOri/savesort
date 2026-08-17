import { NextRequest, NextResponse } from "next/server";

import { requireDesktopSession } from "@/lib/desktop/require-device";
import { syncError, unknownSyncError } from "@/lib/http/sync-responses";
import { applyNoteBatch, VaultNotFoundError } from "@/lib/obsidian/notes";
import { syncFilesBatchSchema } from "@/lib/obsidian/schemas";

/**
 * Upserts a batch of Markdown notes. Always returns 200 with a per-file result
 * unless the whole request is unusable, so the client can commit the files that
 * succeeded and retry only the ones that did not.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireDesktopSession(request);

    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return syncError("invalid_request", "Check the upload request.");
    }

    const parsed = syncFilesBatchSchema.safeParse(value);
    if (!parsed.success) {
      return syncError(
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Check the upload request.",
      );
    }

    const results = await applyNoteBatch(
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
