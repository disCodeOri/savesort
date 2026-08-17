import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireDesktopSession } from "@/lib/desktop/require-device";
import { syncError, unknownSyncError } from "@/lib/http/sync-responses";
import { listChanges, VaultNotFoundError } from "@/lib/obsidian/notes";

const changesQuerySchema = z.object({
  vaultId: z.uuid(),
  since: z.iso.datetime().nullable().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/**
 * The server's note manifest for reconciliation. Returns hashes and revisions
 * only, never note bodies.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await requireDesktopSession(request);
    const parsed = changesQuerySchema.safeParse({
      vaultId: request.nextUrl.searchParams.get("vaultId") ?? undefined,
      since: request.nextUrl.searchParams.get("since") ?? undefined,
      limit: request.nextUrl.searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      return syncError("invalid_request", "Check the changes request.");
    }

    const changes = await listChanges(
      session.userId,
      parsed.data.vaultId,
      parsed.data.since ?? null,
      parsed.data.limit,
    );
    return NextResponse.json({
      changes,
      cursor: changes.at(-1)?.updatedAt ?? parsed.data.since ?? null,
    });
  } catch (error) {
    if (error instanceof VaultNotFoundError) {
      return syncError("vault_not_found", error.message);
    }
    return unknownSyncError(error);
  }
}
