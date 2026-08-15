import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import {
  disconnectGitHub,
  getGitHubConnection,
} from "@/lib/github/connections";
import { unknownApiError } from "@/lib/http/responses";

export async function GET() {
  try {
    const { user } = await requireUser();
    const connection = await getGitHubConnection(user.id);
    return NextResponse.json({ connection });
  } catch (error) {
    return unknownApiError(error);
  }
}

export async function DELETE() {
  try {
    const { user } = await requireUser();
    await disconnectGitHub(user.id);
    return NextResponse.json({ disconnected: true });
  } catch (error) {
    return unknownApiError(error);
  }
}
