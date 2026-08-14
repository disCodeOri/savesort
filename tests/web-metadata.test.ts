import { describe, expect, it } from "vitest";

import { extractPageMetadata } from "@/lib/ingestion/web";

describe("extractPageMetadata", () => {
  it("prefers Open Graph values and strips markup from a bounded excerpt", () => {
    const html = `
      <html><head>
        <title>Fallback title</title>
        <meta name="description" content="Fallback description">
        <meta property="og:title" content="Useful Tool">
        <meta property="og:description" content="A better description">
        <meta property="og:image" content="https://example.com/cover.png">
      </head><body>
        <nav>Navigation</nav><main><h1>Useful Tool</h1><p>Public article text.</p></main>
        <script>doNotIndex()</script>
      </body></html>`;

    expect(extractPageMetadata(html, "https://example.com/article")).toEqual({
      title: "Useful Tool",
      description: "A better description",
      thumbnailUrl: "https://example.com/cover.png",
      canonicalUrl: null,
      content: "Useful Tool Public article text.",
    });
  });
});
