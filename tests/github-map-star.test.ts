import { describe, expect, it } from "vitest";

import { mapGitHubStar, mergeGitHubProviderItem } from "@/lib/github/map-star";
import type { GitHubStarredRepository } from "@/lib/github/types";

function starredRepository(
  overrides: Partial<GitHubStarredRepository["repo"]> = {},
): GitHubStarredRepository {
  return {
    starred_at: "2026-08-15T10:30:00Z",
    repo: {
      id: 42,
      name: "find-it",
      full_name: "acme/find-it",
      html_url: "https://github.com/acme/find-it/?utm_source=github#readme",
      description: "Find useful things.",
      homepage: "https://find-it.example",
      language: "TypeScript",
      topics: ["search", "search"],
      stargazers_count: 123,
      forks_count: 7,
      archived: true,
      visibility: "public",
      owner: { login: "acme" },
      license: { spdx_id: "MIT" },
      ...overrides,
    },
  };
}

describe("mapGitHubStar", () => {
  it("maps a starred repository to canonical saved-item provider fields", () => {
    const mapped = mapGitHubStar(starredRepository());

    expect(mapped).toMatchObject({
      url: "https://github.com/acme/find-it/?utm_source=github#readme",
      normalized_url: "https://github.com/acme/find-it",
      source: "github",
      title: "acme/find-it",
      description: "Find useful things.",
      notes: null,
      content: null,
      author: "acme",
      thumbnail_url: null,
      tags: ["search", "TypeScript"],
      metadata: {
        github: {
          id: 42,
          name: "find-it",
          fullName: "acme/find-it",
          homepage: "https://find-it.example",
          stars: 123,
          forks: 7,
          visibility: "public",
          license: "MIT",
          starredAt: "2026-08-15T10:30:00Z",
          archived: true,
          providerTags: ["search", "TypeScript"],
        },
      },
    });
    expect(mapped.searchable_text).toContain("Source: github");
    expect(mapped.searchable_text).toContain("Tags: search, TypeScript");
  });

  it("omits null language and license without adding empty provider tags", () => {
    const mapped = mapGitHubStar(
      starredRepository({ language: null, topics: [], license: null }),
    );

    expect(mapped.tags).toEqual([]);
    expect(mapped.metadata.github.license).toBeNull();
  });
});

describe("mergeGitHubProviderItem", () => {
  it("preserves notes, rich content, and user tags while refreshing provider tags", () => {
    const provider = mapGitHubStar(
      starredRepository({ topics: ["search"], language: "TypeScript" }),
    );
    const merged = mergeGitHubProviderItem(
      {
        url: "https://github.com/acme/find-it",
        normalized_url: "https://github.com/acme/find-it",
        title: "old title",
        description: "old description",
        notes: "Use this for the parser",
        content: "Existing README excerpt",
        author: "acme",
        thumbnail_url: null,
        tags: ["old-provider-topic", "personal"],
        metadata: { github: { providerTags: ["old-provider-topic"] } },
      },
      provider,
    );

    expect(merged.notes).toBe("Use this for the parser");
    expect(merged.content).toBe("Existing README excerpt");
    expect(merged.thumbnail_url).toBeNull();
    expect(merged.tags).toEqual(["personal", "search", "TypeScript"]);
    expect(merged.metadata.github.providerTags).toEqual([
      "search",
      "TypeScript",
    ]);
    expect(merged.searchable_text).toContain("Notes: Use this for the parser");
    expect(merged.searchable_text).toContain(
      "Content: Existing README excerpt",
    );
  });

  it.each([
    ["absent", {}],
    ["null", { github: null }],
    ["string", { github: "legacy" }],
    ["array", { github: [] }],
    ["malformed provider tags", { github: { providerTags: "search" } }],
    ["non-string provider tags", { github: { providerTags: [42, null] } }],
  ])("retains user tags for %s GitHub metadata", (_shape, metadata) => {
    const provider = mapGitHubStar(starredRepository());
    const merged = mergeGitHubProviderItem(
      {
        url: provider.url,
        normalized_url: provider.normalized_url,
        title: "old title",
        description: "old description",
        notes: null,
        content: null,
        author: "acme",
        thumbnail_url: null,
        tags: ["personal", "search"],
        metadata,
      },
      provider,
    );

    expect(merged.tags).toEqual(["personal", "search", "TypeScript"]);
  });

  it("retains unrelated metadata and a populated thumbnail while refreshing GitHub metadata", () => {
    const provider = mapGitHubStar(starredRepository());
    const merged = mergeGitHubProviderItem(
      {
        url: provider.url,
        normalized_url: provider.normalized_url,
        title: "old title",
        description: "old description",
        notes: null,
        content: null,
        author: "acme",
        thumbnail_url: "https://cdn.example/thumb.png",
        tags: ["personal"],
        metadata: {
          canonicalUrl: "https://acme.example/find-it",
          custom: { pinned: true },
          github: { providerTags: ["old-provider-topic"] },
        },
      },
      provider,
    );

    expect(merged.thumbnail_url).toBe("https://cdn.example/thumb.png");
    expect(merged.metadata.canonicalUrl).toBe("https://acme.example/find-it");
    expect(merged.metadata.custom).toEqual({ pinned: true });
    expect(merged.metadata.github).toEqual(provider.metadata.github);
  });
});
