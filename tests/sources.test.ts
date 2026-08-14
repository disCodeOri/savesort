import { describe, expect, it } from "vitest";

import {
  detectSource,
  isRestrictedPlatformUrl,
  parseGitHubRepositoryUrl,
} from "@/lib/sources/detect-source";

describe("detectSource", () => {
  it.each([
    ["https://github.com/owner/repo", "github"],
    ["https://www.instagram.com/reel/abc", "instagram"],
    ["https://youtu.be/abc", "youtube"],
    ["https://www.youtube.com/watch?v=abc", "youtube"],
    ["https://old.reddit.com/r/webdev", "reddit"],
    ["https://twitter.com/user/status/1", "x"],
    ["https://x.com/user/status/1", "x"],
    ["https://example.com/article", "website"],
  ])("detects %s as %s", (url, source) => {
    expect(detectSource(url)).toBe(source);
  });
});

describe("isRestrictedPlatformUrl", () => {
  it.each([
    "https://instagram.com/reel/abc",
    "https://x.com/user/status/1",
    "https://tiktok.com/@user/video/1",
    "https://facebook.com/watch/1",
  ])("marks restricted platform URL %s for manual enrichment", (url) => {
    expect(isRestrictedPlatformUrl(url)).toBe(true);
  });

  it("allows safe public integrations to use enrichment", () => {
    expect(isRestrictedPlatformUrl("https://github.com/owner/repo")).toBe(
      false,
    );
  });
});

describe("parseGitHubRepositoryUrl", () => {
  it("extracts the owner and repository from a public repository URL", () => {
    expect(
      parseGitHubRepositoryUrl("https://github.com/yt-dlp/yt-dlp"),
    ).toEqual({
      owner: "yt-dlp",
      repository: "yt-dlp",
    });
  });

  it.each([
    "https://github.com/owner",
    "https://github.com/owner/repo/issues/1",
    "https://gitlab.com/owner/repo",
  ])("rejects non-repository URLs: %s", (url) => {
    expect(parseGitHubRepositoryUrl(url)).toBeNull();
  });
});
