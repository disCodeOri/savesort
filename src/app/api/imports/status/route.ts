import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import {
  getLatestImport,
  revertDataImport,
} from "@/lib/data-import/persistence";
import { revertImportSchema } from "@/lib/data-import/schemas";
import { apiError, unknownApiError } from "@/lib/http/responses";

/** The most recent import, so the panel can restore state after a reload. */
export async function GET() {
  try {
    const { user } = await requireUser();
    return NextResponse.json({ import: await getLatestImport(user.id) });
  } catch (error) {
    return unknownApiError(error);
  }
}

/**
 * Removes one import. Only the records it created are deleted; an item that
 * also came from the connected Reddit account, or that carries a note or a
 * manual tag, is preserved.
 */
export async function DELETE(request: NextRequest) {
  try {
    const { user } = await requireUser();

    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return apiError("Check the request and try again.");
    }

    const parsed = revertImportSchema.safeParse(value);
    if (!parsed.success) return apiError("Check the request and try again.");

    const result = await revertDataImport(user.id, parsed.data.importId);
    return NextResponse.json(result);
  } catch (error) {
    return unknownApiError(error);
  }
}
