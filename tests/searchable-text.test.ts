import { describe, expect, it } from "vitest";

import { buildSearchableText } from "@/lib/search/searchable-text";

describe("buildSearchableText", () => {
  it("combines useful fields in a stable human-readable order", () => {
    expect(
      buildSearchableText({
        title: "yt-dlp",
        source: "github",
        author: "yt-dlp",
        description: "Command-line audio/video downloader",
        tags: ["cli", "youtube"],
        notes: "The terminal tool I wanted",
        content: "Supports thousands of sites.",
      }),
    ).toBe(
      "Title: yt-dlp\nSource: github\nAuthor: yt-dlp\nDescription: Command-line audio/video downloader\nTags: cli, youtube\nNotes: The terminal tool I wanted\nContent: Supports thousands of sites.",
    );
  });

  it("omits empty fields and normalizes excessive whitespace", () => {
    expect(
      buildSearchableText({
        title: "  Lecture   transcription\n tool ",
        source: "website",
        tags: [],
      }),
    ).toBe("Title: Lecture transcription tool\nSource: website");
  });
});
