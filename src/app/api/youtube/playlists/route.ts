import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/require-user";
import { apiError, unknownApiError } from "@/lib/http/responses";
import { YOUTUBE_RECONNECT_MESSAGE } from "@/lib/youtube/connections";
import {
  listStoredPlaylists,
  refreshPlaylists,
  setPlaylistSelection,
} from "@/lib/youtube/playlists";

const selectionSchema = z.object({
  playlistIds: z.array(z.string().trim().min(1).max(128)).max(200),
});

function reconnectResponse(error: unknown) {
  if (error instanceof Error && error.message === YOUTUBE_RECONNECT_MESSAGE) {
    return apiError("YouTube access expired. Reconnect to continue.", 401);
  }
  return null;
}

/** `?refresh=1` re-reads playlists from YouTube; otherwise returns the cache. */
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireUser();
    const shouldRefresh = request.nextUrl.searchParams.get("refresh") === "1";
    const playlists = shouldRefresh
      ? await refreshPlaylists(user.id)
      : await listStoredPlaylists(user.id);
    return NextResponse.json({ playlists });
  } catch (error) {
    return reconnectResponse(error) ?? unknownApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireUser();

    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return apiError("Check the playlist selection and try again.");
    }

    const parsed = selectionSchema.safeParse(value);
    if (!parsed.success) {
      return apiError("Check the playlist selection and try again.");
    }

    await setPlaylistSelection(user.id, parsed.data.playlistIds);
    return NextResponse.json({ playlists: await listStoredPlaylists(user.id) });
  } catch (error) {
    return reconnectResponse(error) ?? unknownApiError(error);
  }
}
