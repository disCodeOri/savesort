import { describe, expect, it } from "vitest";

import { updateItemSchema } from "@/lib/items/schemas";

describe("updateItemSchema", () => {
  it("allows a user to clear notes and content", () => {
    expect(updateItemSchema.parse({ notes: "", content: "" })).toEqual({
      notes: null,
      content: null,
    });
  });
});
