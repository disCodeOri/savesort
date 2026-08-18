import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { unknownApiError } from "@/lib/http/responses";
import { enrichPendingVideos } from "@/lib/youtube/enrich";

/**
 * Analyses one small batch of pending videos per call. The client polls this
 * until `remaining` reaches zero, which keeps each request well inside a
 * serverless execution limit no matter how large the playlist was.
 */
export async function POST() {
  try {
    const { user } = await requireUser();
    const progress = await enrichPendingVideos(user.id);
    return NextResponse.json(progress);
  } catch (error) {
    return unknownApiError(error);
  }
}
