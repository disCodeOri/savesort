import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { apiError, unknownApiError } from "@/lib/http/responses";
import { applyArchiveBatch } from "@/lib/x-archive/import";
import { batchSchema } from "@/lib/x-archive/schemas";

/**
 * Applies one bounded batch of parsed records.
 *
 * Records arrive from the browser, so nothing here is trusted: the schema
 * validates every field, and the RPC re-checks that the import belongs to
 * this user and is still active. Re-posting the same batch is safe because
 * content and relationships both upsert on their natural keys.
 */
export async function POST(request: NextRequest) {
  try {
    const { user } = await requireUser();

    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return apiError("Check the import batch and try again.");
    }

    const parsed = batchSchema.safeParse(value);
    if (!parsed.success) {
      return apiError(
        parsed.error.issues[0]?.message ??
          "Check the import batch and try again.",
      );
    }

    const result = await applyArchiveBatch(
      user.id,
      parsed.data.importId,
      parsed.data.records,
    );
    return NextResponse.json(result);
  } catch (error) {
    return unknownApiError(error);
  }
}
