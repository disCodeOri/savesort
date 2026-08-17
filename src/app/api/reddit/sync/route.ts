import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/require-user";
import {
  continueRedditSync,
  RedditSyncError,
  startRedditSync,
} from "@/lib/reddit/sync";
import { apiError, unknownApiError } from "@/lib/http/responses";

const syncRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("continue"), syncId: z.uuid() }),
]);

function syncErrorResponse(error: RedditSyncError) {
  const status =
    error.kind === "conflict" ? 409 : error.kind === "rate_limited" ? 429 : 503;
  return apiError(error.message, status);
}

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireUser();

    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return apiError("Check the sync request and try again.");
    }

    const parsed = syncRequestSchema.safeParse(value);
    if (!parsed.success) {
      return apiError("Check the sync request and try again.");
    }

    const progress =
      parsed.data.action === "start"
        ? await startRedditSync(user.id)
        : await continueRedditSync(user.id, parsed.data.syncId);
    return NextResponse.json(progress);
  } catch (error) {
    if (error instanceof RedditSyncError) return syncErrorResponse(error);
    return unknownApiError(error);
  }
}
