import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { apiError, unknownApiError } from "@/lib/http/responses";
import { startArchiveImport } from "@/lib/x-archive/import";
import { startImportSchema } from "@/lib/x-archive/schemas";

/**
 * Opens an import. The archive itself is never uploaded: the browser parses
 * it locally and posts only allowlisted records, so this receives metadata
 * about the archive rather than the archive.
 */
export async function POST(request: NextRequest) {
  try {
    const { user } = await requireUser();

    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return apiError("Check the import request and try again.");
    }

    const parsed = startImportSchema.safeParse(value);
    if (!parsed.success) {
      return apiError("Check the import request and try again.");
    }

    const importId = await startArchiveImport(
      user.id,
      parsed.data.archiveName,
      parsed.data.archiveSizeBytes,
      parsed.data.filesDetected,
    );
    return NextResponse.json({ importId });
  } catch (error) {
    return unknownApiError(error);
  }
}
