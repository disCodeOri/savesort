import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { apiError, unknownApiError } from "@/lib/http/responses";
import { completeArchiveImport, getLatestImport } from "@/lib/x-archive/import";
import { completeImportSchema } from "@/lib/x-archive/schemas";

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireUser();

    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return apiError("Check the import request and try again.");
    }

    const parsed = completeImportSchema.safeParse(value);
    if (!parsed.success) {
      return apiError("Check the import request and try again.");
    }

    await completeArchiveImport(user.id, parsed.data.importId, {
      filesProcessed: parsed.data.filesProcessed,
      filesSkipped: parsed.data.filesSkipped,
      recordsDiscovered: parsed.data.recordsDiscovered,
      warnings: parsed.data.warnings,
      failed: parsed.data.failed,
    });

    // Returning the final row saves the client a second round trip for the
    // completion report.
    return NextResponse.json({ import: await getLatestImport(user.id) });
  } catch (error) {
    return unknownApiError(error);
  }
}
