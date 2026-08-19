import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { runClassificationPass } from "@/lib/data-import/classify-pass";
import { classifySchema } from "@/lib/data-import/schemas";
import { apiError, unknownApiError } from "@/lib/http/responses";

/**
 * Runs one bounded classification pass.
 *
 * The client calls this repeatedly until `remaining` is zero. Items are
 * already in the library and already keyword-searchable, so stopping early —
 * by closing the tab, or because the model is down — costs findability, never
 * data.
 */
export async function POST(request: NextRequest) {
  try {
    const { user } = await requireUser();

    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return apiError("Check the request and try again.");
    }

    const parsed = classifySchema.safeParse(value);
    if (!parsed.success) return apiError("Check the request and try again.");

    const result = await runClassificationPass(
      user.id,
      parsed.data.importId,
      parsed.data.limit,
    );
    return NextResponse.json(result);
  } catch (error) {
    return unknownApiError(error);
  }
}
