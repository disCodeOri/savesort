import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { embedQuery } from "@/lib/embeddings/gemini";
import { apiError, unknownApiError } from "@/lib/http/responses";
import { searchSchema } from "@/lib/items/schemas";

export async function POST(request: NextRequest) {
  try {
    const parsed = searchSchema.safeParse(await request.json());
    if (!parsed.success)
      return apiError(
        parsed.error.issues[0]?.message ?? "Enter a search query.",
      );

    const { supabase } = await requireUser();
    const embedded = await embedQuery(parsed.data.query);
    const { data, error } = await supabase.rpc("hybrid_search_saved_items", {
      query_text: parsed.data.query,
      query_embedding: embedded.embedding,
      filter_source: parsed.data.source ?? null,
      limit_count: parsed.data.limit,
    });
    if (error) throw error;

    return NextResponse.json({
      items: data ?? [],
      warning: embedded.embedding
        ? null
        : "Semantic search is temporarily unavailable, so we're showing keyword results.",
    });
  } catch (error) {
    return unknownApiError(error);
  }
}
