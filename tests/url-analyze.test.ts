import { describe, expect, it } from "vitest";

import { analyzeUrl, titleFromSlug, urlContentKey } from "@/lib/urls/analyze";

/**
 * The URL analyzer is pure string work — no network, no clock, no randomness —
 * so every case here is an exact expectation rather than a smoke test.
 */

describe("titleFromSlug", () => {
  it("reads words out of the three slug conventions", () => {
    expect(titleFromSlug("why_async_is_hard")).toBe("Why async is hard");
    expect(titleFromSlug("why-async-is-hard")).toBe("Why async is hard");
    expect(titleFromSlug("whyAsyncIsHard")).toBe("Why Async Is Hard");
  });

  it("drops a trailing id or hash that is part of the URL, not the title", () => {
    expect(titleFromSlug("building-a-crdt-a1b2c3d4e5")).toBe("Building a crdt");
    expect(titleFromSlug("some-post-123456")).toBe("Some post");
  });

  it("refuses slugs that carry no words", () => {
    expect(titleFromSlug("12345")).toBeNull();
    expect(titleFromSlug("a1b2c3d4e5f6")).toBeNull();
    expect(titleFromSlug("ab")).toBeNull();
    expect(titleFromSlug(null)).toBeNull();
  });

  it("decodes percent-encoding and strips a file extension", () => {
    expect(titleFromSlug("why%20rust%20wins")).toBe("Why rust wins");
    expect(titleFromSlug("getting-started.html")).toBe("Getting started");
  });
});

describe("platform recognition", () => {
  it("reads a Reddit post apart", () => {
    const result = analyzeUrl(
      "https://www.reddit.com/r/rust/comments/abc123/why_async_is_hard/",
    );
    expect(result.platform).toBe("reddit");
    expect(result.source).toBe("reddit");
    expect(result.contentType).toBe("post");
    expect(result.contentId).toBe("abc123");
    expect(result.community).toBe("rust");
    expect(result.titleFromSlug).toBe("Why async is hard");
    expect(result.confidence).toBe("high");
  });

  it("tells a Reddit comment from the post it sits under", () => {
    const result = analyzeUrl(
      "https://www.reddit.com/r/rust/comments/abc123/why_async_is_hard/def456/",
    );
    expect(result.contentType).toBe("comment");
    // The comment is the thing; the post id stays available as context.
    expect(result.contentId).toBe("def456");
    expect(result.descriptors.id).toBe("abc123");
  });

  it("reads a YouTube video id out of the query string", () => {
    const result = analyzeUrl(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42&list=PL123",
    );
    expect(result.platform).toBe("youtube");
    expect(result.contentType).toBe("video");
    expect(result.contentId).toBe("dQw4w9WgXcQ");
    expect(result.descriptors.startSeconds).toBe("42");
    expect(result.descriptors.playlist).toBe("PL123");
  });

  it("handles the youtu.be and shorts forms", () => {
    expect(analyzeUrl("https://youtu.be/dQw4w9WgXcQ").contentId).toBe(
      "dQw4w9WgXcQ",
    );
    const short = analyzeUrl("https://www.youtube.com/shorts/abc123xyz99");
    expect(short.contentType).toBe("short");
    expect(short.contentId).toBe("abc123xyz99");
  });

  it("reads both LinkedIn URL forms down to the same activity id", () => {
    const feed = analyzeUrl(
      "https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/",
    );
    const posts = analyzeUrl(
      "https://www.linkedin.com/posts/jane-doe_local-first-activity-7100000000000000001-Ab1c",
    );

    expect(feed.contentId).toBe("7100000000000000001");
    expect(posts.contentId).toBe("7100000000000000001");
    expect(posts.author).toBe("jane-doe");
    // Identity survives the difference in spelling.
    expect(urlContentKey(feed)).toBe(urlContentKey(posts));
  });

  it("separates GitHub repositories, issues and pull requests", () => {
    const repo = analyzeUrl("https://github.com/rust-lang/rust");
    expect(repo.contentType).toBe("repository");
    expect(repo.author).toBe("rust-lang");
    expect(repo.descriptors.repository).toBe("rust");

    const issue = analyzeUrl("https://github.com/rust-lang/rust/issues/12345");
    expect(issue.contentType).toBe("issue");
    expect(issue.contentId).toBe("12345");

    const pull = analyzeUrl("https://github.com/rust-lang/rust/pull/999");
    expect(pull.contentType).toBe("pull_request");
    expect(pull.contentId).toBe("999");

    const file = analyzeUrl(
      "https://github.com/rust-lang/rust/blob/main/src/lib.rs",
    );
    expect(file.contentType).toBe("file");
    expect(file.descriptors.path).toBe("src/lib.rs");
  });

  it("reads an X post and its author", () => {
    const result = analyzeUrl(
      "https://x.com/someone/status/1900000000000000001",
    );
    expect(result.platform).toBe("x");
    expect(result.contentType).toBe("post");
    expect(result.contentId).toBe("1900000000000000001");
    expect(result.author).toBe("someone");
  });

  it("reads a Stack Overflow question", () => {
    const result = analyzeUrl(
      "https://stackoverflow.com/questions/1234567/how-do-i-merge-two-dicts",
    );
    expect(result.contentType).toBe("question");
    expect(result.contentId).toBe("1234567");
    expect(result.titleFromSlug).toBe("How do i merge two dicts");
  });

  it("reads an arXiv paper id", () => {
    const result = analyzeUrl("https://arxiv.org/abs/2301.00234v2");
    expect(result.contentType).toBe("paper");
    expect(result.contentId).toBe("2301.00234v2");
  });

  it("reads a Medium article id and author", () => {
    const result = analyzeUrl(
      "https://medium.com/@someone/why-crdts-win-a1b2c3d4e5f6",
    );
    expect(result.contentType).toBe("article");
    expect(result.author).toBe("someone");
    expect(result.titleFromSlug).toBe("Why crdts win");
  });

  it("marks the platforms GRAPPlin must never fetch", () => {
    expect(analyzeUrl("https://www.linkedin.com/in/someone").restricted).toBe(
      true,
    );
    expect(analyzeUrl("https://x.com/someone").restricted).toBe(true);
    expect(analyzeUrl("https://www.instagram.com/p/abc").restricted).toBe(true);
    expect(analyzeUrl("https://example.com/post").restricted).toBe(false);
  });
});

describe("ordinary websites", () => {
  it("classifies a dated blog post and recovers its title and date", () => {
    // The common case: a host we have no rules for at all.
    const result = analyzeUrl(
      "https://example.com/blog/2024/05/12/why-rust-wins-on-embedded",
    );
    expect(result.platform).toBe("web");
    expect(result.source).toBe("website");
    expect(result.contentType).toBe("article");
    expect(result.titleFromSlug).toBe("Why rust wins on embedded");
    expect(result.dateFromPath).toBe("2024-05-12T00:00:00.000Z");
  });

  it("recognises documentation, jobs and forum paths", () => {
    expect(
      analyzeUrl("https://example.com/docs/getting-started").contentType,
    ).toBe("document");
    expect(
      analyzeUrl("https://example.com/careers/staff-engineer").contentType,
    ).toBe("job");
    expect(
      analyzeUrl("https://example.com/forum/thread-about-sync").contentType,
    ).toBe("question");
  });

  it("classifies by file extension when the URL points at a file", () => {
    const pdf = analyzeUrl("https://example.com/papers/attention-is-all.pdf");
    expect(pdf.contentType).toBe("document");
    expect(pdf.fileExtension).toBe("pdf");

    expect(analyzeUrl("https://example.com/img/diagram.png").contentType).toBe(
      "image",
    );
    expect(analyzeUrl("https://example.com/ep/12.mp3").contentType).toBe(
      "episode",
    );
  });

  it("takes a trailing numeric id as the id and the segment before it as the title", () => {
    const result = analyzeUrl(
      "https://example.com/articles/why-rust-wins/48213",
    );
    expect(result.contentId).toBe("48213");
    expect(result.titleFromSlug).toBe("Why rust wins");
  });

  it("recognises a search page", () => {
    expect(analyzeUrl("https://example.com/results?q=crdt").contentType).toBe(
      "search",
    );
  });

  it("calls a bare domain a site rather than guessing", () => {
    const result = analyzeUrl("https://example.com/");
    expect(result.contentType).toBe("home");
    expect(result.titleFromSlug).toBeNull();
  });

  it("mines retrieval keywords from the path", () => {
    const result = analyzeUrl(
      "https://example.com/blog/2024/05/local-first-sync-without-a-server",
    );
    expect(result.keywords).toContain("local");
    expect(result.keywords).toContain("sync");
    expect(result.keywords).toContain("server");
    // Dates and stop words are identifiers and noise, not search terms.
    expect(result.keywords).not.toContain("2024");
    expect(result.keywords).not.toContain("the");
  });
});

describe("bad input never throws", () => {
  it("returns a none-confidence result for anything unusable", () => {
    for (const bad of [
      "",
      "   ",
      "not a url",
      "javascript:alert(1)",
      "data:text/html,<script>",
      "file:///etc/passwd",
      "ftp://example.com/x",
    ]) {
      const result = analyzeUrl(bad);
      expect(result.confidence).toBe("none");
      expect(result.canonicalUrl).toBe("");
      expect(urlContentKey(result)).toBeNull();
    }
  });

  it("strips tracking parameters from the canonical form", () => {
    const result = analyzeUrl(
      "https://example.com/post?utm_source=news&utm_campaign=x&id=7",
    );
    expect(result.canonicalUrl).not.toContain("utm_source");
    expect(result.canonicalUrl).toContain("id=7");
  });

  it("survives a malformed percent-escape in the path", () => {
    const result = analyzeUrl("https://example.com/blog/100%-coverage");
    expect(result.confidence).not.toBe("none");
  });
});
