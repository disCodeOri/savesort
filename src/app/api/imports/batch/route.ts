import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { applyImportBatch } from "@/lib/data-import/persistence";
import { batchSchema } from "@/lib/data-import/schemas";
import { apiError, unknownApiError } from "@/lib/http/responses";

/**
 * Applies one bounded batch of parsed records.
 *
 * Records arrive from the browser, so nothing here is trusted: the schema
 * validates every field, the server re-derives content availability and AI
 * eligibility itself, and the RPC re-checks that the import belongs to this
 * user and is still active. Re-posting the same batch is safe because content
 * and records both upsert on their natural keys.
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

    const result = await applyImportBatch(
      user.id,
      parsed.data.importId,
      parsed.data.records,
    );
    return NextResponse.json(result);
  } catch (error) {
    return unknownApiError(error);
  }
}
