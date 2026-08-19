import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { completeDataImport, getImport } from "@/lib/data-import/persistence";
import { completeImportSchema } from "@/lib/data-import/schemas";
import { apiError, unknownApiError } from "@/lib/http/responses";

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

    await completeDataImport(user.id, parsed.data.importId, {
      filesProcessed: parsed.data.filesProcessed,
      filesSkipped: parsed.data.filesSkipped,
      itemsUnresolved: parsed.data.itemsUnresolved,
      warnings: parsed.data.warnings,
      failed: parsed.data.failed,
    });

    // Returning the final row saves the client a round trip for the report.
    return NextResponse.json({
      import: await getImport(user.id, parsed.data.importId),
    });
  } catch (error) {
    return unknownApiError(error);
  }
}
