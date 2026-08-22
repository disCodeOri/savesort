import type { SavedItem } from "@/lib/items/types";

// Honest relevance labels from the hybrid-search RPC. Browse results carry no
// ranks, so callers show no badge instead of a fabricated one. Cosine
// similarity is never presented as a probability.
export function resultMatchLabel(item: SavedItem): string | null {
  if (typeof item.similarity === "number") {
    if (item.similarity >= 0.8) return "Strong match";
    if (item.similarity >= 0.65) return "Close match";
    return "Possible match";
  }
  if (typeof item.keyword_rank === "number") return "Keyword match";
  return null;
}
