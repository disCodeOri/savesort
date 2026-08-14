import { NextRequest, NextResponse } from "next/server";

import { apiError, unknownApiError } from "@/lib/http/responses";
import { ingestSavedItem } from "@/lib/ingestion/ingest";
import { createItemSchema, sourceFilterSchema } from "@/lib/items/schemas";
import { requireUser } from "@/lib/auth/require-user";
import { normalizeUrl } from "@/lib/urls/normalize";

export async function GET(request: NextRequest) {
  try {
    const { supabase } = await requireUser();
    const parsedSource = sourceFilterSchema.safeParse(
      request.nextUrl.searchParams.get("source") ?? undefined,
    );
    if (!parsedSource.success)
      return apiError("That source filter is not supported.");

    let query = supabase
      .from("saved_items")
      .select("*")
      .order("created_at", { ascending: false });
    if (parsedSource.data) query = query.eq("source", parsedSource.data);
    const { data, error } = await query.limit(100);
    if (error) throw error;
    return NextResponse.json({ items: data ?? [] });
  } catch (error) {
    return unknownApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const parsed = createItemSchema.safeParse(await request.json());
    if (!parsed.success)
      return apiError(
        parsed.error.issues[0]?.message ?? "Check the form and try again.",
      );

    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeUrl(parsed.data.url);
    } catch (error) {
      return apiError(
        error instanceof Error ? error.message : "That URL doesn't look valid.",
      );
    }

    const { supabase, user } = await requireUser();
    const duplicate = await supabase
      .from("saved_items")
      .select("id")
      .eq("normalized_url", normalizedUrl)
      .maybeSingle();
    if (duplicate.error) throw duplicate.error;
    if (duplicate.data) return apiError("You've already saved this item.", 409);

    const item = await ingestSavedItem(parsed.data);
    const { data, error } = await supabase
      .from("saved_items")
      .insert({ ...item, user_id: user.id })
      .select("*")
      .single();

    if (error?.code === "23505")
      return apiError("You've already saved this item.", 409);
    if (error) throw error;
    return NextResponse.json({ item: data }, { status: 201 });
  } catch (error) {
    return unknownApiError(error);
  }
}
