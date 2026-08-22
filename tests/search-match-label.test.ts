import { describe, expect, it } from "vitest";

import { resultMatchLabel } from "@/lib/search/match-label";
import type { SavedItem } from "@/lib/items/types";

function itemWith(overrides: Partial<SavedItem>): SavedItem {
  return {
    id: "item-1",
    url: "https://example.com",
    normalized_url: "https://example.com",
    source: "website",
    title: null,
    description: null,
    notes: null,
    content: null,
    author: null,
    thumbnail_url: null,
    tags: [],
    metadata: {},
    indexing_status: "ready",
    created_at: "2026-08-22T00:00:00Z",
    updated_at: "2026-08-22T00:00:00Z",
    ...overrides,
  };
}

describe("resultMatchLabel", () => {
  it("labels strong semantic matches without calling them probabilities", () => {
    expect(resultMatchLabel(itemWith({ similarity: 0.9 }))).toBe(
      "Strong match",
    );
    expect(resultMatchLabel(itemWith({ similarity: 0.65 }))).toBe(
      "Close match",
    );
    expect(resultMatchLabel(itemWith({ similarity: 0.4 }))).toBe(
      "Possible match",
    );
  });

  it("labels keyword-only hits from the keyword rank", () => {
    expect(
      resultMatchLabel(itemWith({ similarity: null, keyword_rank: 3 })),
    ).toBe("Keyword match");
  });

  it("shows no label for browse results without ranking data", () => {
    expect(resultMatchLabel(itemWith({}))).toBeNull();
  });
});
