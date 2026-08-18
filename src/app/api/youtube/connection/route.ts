import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { unknownApiError } from "@/lib/http/responses";
import {
  disconnectYouTube,
  getYouTubeConnection,
} from "@/lib/youtube/connections";

export async function GET() {
  try {
    const { user } = await requireUser();
    const connection = await getYouTubeConnection(user.id);
    return NextResponse.json({ connection });
  } catch (error) {
    return unknownApiError(error);
  }
}

export async function DELETE() {
  try {
    const { user } = await requireUser();
    await disconnectYouTube(user.id);
    return NextResponse.json({ disconnected: true });
  } catch (error) {
    return unknownApiError(error);
  }
}
