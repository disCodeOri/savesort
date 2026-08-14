import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { embedDocument } from "@/lib/embeddings/gemini";
import { apiError, unknownApiError } from "@/lib/http/responses";
import { updateItemSchema } from "@/lib/items/schemas";
import { buildSearchableText } from "@/lib/search/searchable-text";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { supabase } = await requireUser();
    const { data, error } = await supabase
      .from("saved_items")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return apiError("That saved item was not found.", 404);
    return NextResponse.json({ item: data });
  } catch (error) {
    return unknownApiError(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const parsed = updateItemSchema.safeParse(await request.json());
    if (!parsed.success)
      return apiError(
        parsed.error.issues[0]?.message ?? "Check the form and try again.",
      );

    const { id } = await context.params;
    const { supabase } = await requireUser();
    const current = await supabase
      .from("saved_items")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (current.error) throw current.error;
    if (!current.data) return apiError("That saved item was not found.", 404);

    const next = { ...current.data, ...parsed.data };
    const searchableText = buildSearchableText({
      title: next.title,
      source: next.source,
      author: next.author,
      description: next.description,
      tags: next.tags,
      notes: next.notes,
      content: next.content,
    });
    const embedded = await embedDocument(searchableText);
    const update = {
      ...parsed.data,
      searchable_text: searchableText,
      embedding: embedded.embedding,
      indexing_status: embedded.embedding ? "ready" : "keyword_only",
      indexing_error: embedded.error,
    };
    const result = await supabase
      .from("saved_items")
      .update(update)
      .eq("id", id)
      .select("*")
      .single();
    if (result.error) throw result.error;
    return NextResponse.json({ item: result.data });
  } catch (error) {
    return unknownApiError(error);
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { supabase } = await requireUser();
    const result = await supabase
      .from("saved_items")
      .delete()
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) return apiError("That saved item was not found.", 404);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return unknownApiError(error);
  }
}
