import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { embedDocument } from "@/lib/embeddings/gemini";
import { apiError, unknownApiError } from "@/lib/http/responses";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { supabase } = await requireUser();
    const current = await supabase
      .from("saved_items")
      .select("searchable_text")
      .eq("id", id)
      .maybeSingle();
    if (current.error) throw current.error;
    if (!current.data) return apiError("That saved item was not found.", 404);

    const embedded = await embedDocument(current.data.searchable_text);
    const result = await supabase
      .from("saved_items")
      .update({
        embedding: embedded.embedding,
        indexing_status: embedded.embedding ? "ready" : "keyword_only",
        indexing_error: embedded.error,
      })
      .eq("id", id)
      .select("*")
      .single();
    if (result.error) throw result.error;
    return NextResponse.json({ item: result.data });
  } catch (error) {
    return unknownApiError(error);
  }
}
