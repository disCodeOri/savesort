import { describe, expect, it } from "vitest";

import { reciprocalRank } from "@/lib/search/ranking";

describe("reciprocalRank", () => {
  it("applies the smoothing constant and optional weight", () => {
    expect(reciprocalRank(1)).toBeCloseTo(1 / 61);
    expect(reciprocalRank(4, 2, 10)).toBeCloseTo(2 / 14);
  });

  it("returns zero when an item is absent from a ranking", () => {
    expect(reciprocalRank(null)).toBe(0);
  });
});
