import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { unknownApiError } from "@/lib/http/responses";
import { disconnectX, getXConnection } from "@/lib/x/connections";

export async function GET() {
  try {
    const { user } = await requireUser();
    const connection = await getXConnection(user.id);
    return NextResponse.json({ connection });
  } catch (error) {
    return unknownApiError(error);
  }
}

/** Removes credentials only. Imported items, notes and tags are preserved. */
export async function DELETE() {
  try {
    const { user } = await requireUser();
    await disconnectX(user.id);
    return NextResponse.json({ disconnected: true });
  } catch (error) {
    return unknownApiError(error);
  }
}
