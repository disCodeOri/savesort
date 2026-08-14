import { NextResponse } from "next/server";

export function apiError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export function unknownApiError(error: unknown) {
  if (error instanceof Error && error.message === "AUTH_REQUIRED") {
    return apiError("Please sign in to continue.", 401);
  }
  return apiError("Something went wrong. Please try again.", 500);
}
