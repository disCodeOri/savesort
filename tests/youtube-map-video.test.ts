import { describe, expect, it } from "vitest";

import {
  buildEnrichedSearchableText,
  mapYouTubeVideo,
  youtubeWatchUrl,
} from "@/lib/youtube/map-video";
import type { YouTubeVideo } from "@/lib/youtube/types";

function video(overrides: Partial<YouTubeVideo> = {}): YouTubeVideo {
  return {
    videoId: "dQw4w9WgXcQ",
    title: "Local-first  sync   explained",
    description: "A talk about keeping offline databases in step.",
    channelTitle: "Some Channel",
    publishedAt: "2026-01-01T00:00:00Z",
    thumbnailUrl: "https://img.test/v.jpg",
    durationIso: "PT12M30S",
    viewCount: 1234,
    tags: ["databases", "sync"],
    ...overrides,
  };
}

describe("mapYouTubeVideo", () => {
  it("uses the canonical watch URL as the item identity", () => {
    const item = mapYouTubeVideo(video(), "PL1");

    expect(item.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(item.normalized_url).toBe(item.url);
    expect(item.source).toBe("youtube");
    expect(item.video_id).toBe("dQw4w9WgXcQ");
    expect(item.playlist_id).toBe("PL1");
  });

  it("collapses whitespace in the title", () => {
    expect(mapYouTubeVideo(video(), null).title).toBe(
      "Local-first sync explained",
    );
  });

  it("leaves content null so a re-sync cannot erase an existing analysis", () => {
    // Enrichment writes content; import must never overwrite it.
    expect(mapYouTubeVideo(video(), null).content).toBeNull();
  });

  it("truncates a long description rather than storing the whole thing", () => {
    const item = mapYouTubeVideo(video({ description: "x".repeat(900) }), null);

    expect(item.description).toHaveLength(500);
    expect(item.description?.endsWith("…")).toBe(true);
  });

  it("records provider metadata for later display", () => {
    const item = mapYouTubeVideo(video(), "PL1");

    expect(item.metadata.youtube).toMatchObject({
      videoId: "dQw4w9WgXcQ",
      channelTitle: "Some Channel",
      durationIso: "PT12M30S",
      viewCount: 1234,
    });
  });

  it("caps provider tags and drops duplicates", () => {
    const item = mapYouTubeVideo(
      video({
        tags: [...Array.from({ length: 20 }, (_, i) => `tag${i}`), "tag0"],
      }),
      null,
    );

    expect(item.tags).toHaveLength(12);
    expect(new Set(item.tags).size).toBe(item.tags.length);
  });

  it("falls back to the video id when a title is empty", () => {
    expect(mapYouTubeVideo(video({ title: "   " }), null).title).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("indexes the title, channel and description before enrichment", () => {
    const item = mapYouTubeVideo(video(), null);

    expect(item.searchable_text).toContain("Title: Local-first sync explained");
    expect(item.searchable_text).toContain("Source: youtube");
    expect(item.searchable_text).toContain("Author: Some Channel");
  });
});

describe("buildEnrichedSearchableText", () => {
  it("indexes the analysis alongside the original metadata", () => {
    const text = buildEnrichedSearchableText(
      {
        title: "Local-first sync explained",
        author: "Some Channel",
        description: "A talk",
        tags: ["databases"],
      },
      "The speaker demonstrates conflict-free replicated data types and offline reconciliation.",
    );

    expect(text).toContain("Title: Local-first sync explained");
    expect(text).toContain("Content: The speaker demonstrates");
    // This is the point of enrichment: a term that never appears in the title
    // becomes searchable.
    expect(text).toContain("conflict-free replicated data types");
  });

  it("caps the indexed document like every other source", () => {
    const text = buildEnrichedSearchableText(
      { title: "T", author: null, description: null, tags: [] },
      "y".repeat(50_000),
    );

    expect(text.length).toBeLessThanOrEqual(12_000);
  });
});

describe("youtubeWatchUrl", () => {
  it("builds the standard watch URL", () => {
    expect(youtubeWatchUrl("abc123")).toBe(
      "https://www.youtube.com/watch?v=abc123",
    );
  });
});
