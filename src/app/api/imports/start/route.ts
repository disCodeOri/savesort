import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { startDataImport } from "@/lib/data-import/persistence";
import { startImportSchema } from "@/lib/data-import/schemas";
import { apiError, unknownApiError } from "@/lib/http/responses";

/**
 * Opens an import.
 *
 * The export itself is never uploaded. The browser reads it locally and posts
 * only the allowlisted records it extracted, so this receives a description of
 * the file rather than the file.
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

    const importId = await startDataImport(user.id, {
      platform: parsed.data.platform,
      safeFilename: parsed.data.safeFilename,
      fileSizeBytes: parsed.data.fileSizeBytes,
      fileHash: parsed.data.fileHash,
      selectedCategories: parsed.data.selectedCategories,
      detectedCategories: parsed.data.detectedCategories,
      itemsDetected: parsed.data.itemsDetected,
      itemsSelected: parsed.data.itemsSelected,
      filesDetected: parsed.data.filesDetected,
    });
    return NextResponse.json({ importId });
  } catch (error) {
    return unknownApiError(error);
  }
}
