import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/require-user";
import { apiError, unknownApiError } from "@/lib/http/responses";
import { getLatestImport, revertArchiveImport } from "@/lib/x-archive/import";

const revertSchema = z.object({ importId: z.uuid() });

/** The most recent import, so the panel can restore progress after a reload. */
export async function GET() {
  try {
    const { user } = await requireUser();
    return NextResponse.json({ import: await getLatestImport(user.id) });
  } catch (error) {
    return unknownApiError(error);
  }
}

/**
 * Reverts one import. Only the relationships it created are removed; content
 * shared with the X API sync or another import is preserved, as are any notes
 * and tags the user added.
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

    const parsed = revertSchema.safeParse(value);
    if (!parsed.success) return apiError("Check the request and try again.");

    const result = await revertArchiveImport(user.id, parsed.data.importId);
    return NextResponse.json(result);
  } catch (error) {
    return unknownApiError(error);
  }
}
