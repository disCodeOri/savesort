import { describe, expect, it } from "vitest";

import { analyzeExport } from "@/lib/data-import/analyze";
import {
  assessAvailability,
  hasSufficientContentForAi,
} from "@/lib/data-import/content-quality";
import { chooseCanonicalUrl, chooseTitle } from "@/lib/data-import/matching";
import { reconcileRecords } from "@/lib/data-import/reconcile";
import type { ImportCategory, NormalizedRecord } from "@/lib/data-import/types";

import {
  linkedInArchive,
  linkedInComments,
  linkedInSavedItems,
  linkedInShares,
  LONG_BODY,
  redditArchive,
  redditOwnComments,
  redditOwnPosts,
} from "./data-import-fixtures";

function record(
  overrides: Partial<NormalizedRecord> & {
    contentKey: string;
    category: ImportCategory;
  },
): NormalizedRecord {
  return {
    platform: "linkedin",
    contentType: "post",
    sourceId: null,
    canonicalUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1",
    originalUrl: null,
    title: null,
    titleSource: null,
    rawText: null,
    userText: null,
    author: null,
    community: null,
    sourceCreatedAt: null,
    sourceSavedAt: null,
    sourceActedAt: null,
    externalUrl: null,
    parentContentKey: null,
    sourceFile: "file.csv",
    ...overrides,
  };
}

describe("content availability", () => {
  it("grades a substantial body as full", () => {
    expect(assessAvailability({ rawText: LONG_BODY })).toBe("full");
  });

  it("grades a title or a subreddit as partial", () => {
    expect(assessAvailability({ title: "Why CRDTs win" })).toBe("partial");
    expect(assessAvailability({ community: "localfirst" })).toBe("partial");
    expect(assessAvailability({ rawText: "short note" })).toBe("partial");
  });

  it("grades a URL-and-date record as reference only", () => {
    expect(assessAvailability({})).toBe("reference_only");
    expect(assessAvailability({ rawText: "", title: null })).toBe(
      "reference_only",
    );
  });

  it("never spends an AI call on a label", () => {
    // A subreddit and an author are labels, not something to summarise.
    expect(
      hasSufficientContentForAi({ community: "localfirst", author: "someone" }),
    ).toBe(false);
    expect(hasSufficientContentForAi({})).toBe(false);
    // Nor on one long unbroken token pretending to be prose.
    expect(hasSufficientContentForAi({ rawText: "x".repeat(500) })).toBe(false);
    expect(hasSufficientContentForAi({ rawText: LONG_BODY })).toBe(true);
  });
});

describe("merge precedence", () => {
  it("prefers a verbatim title over one decoded from a slug", () => {
    const chosen = chooseTitle(
      {
        title: "Why crdts beat operational transforms",
        titleSource: "permalink_slug",
      },
      { title: "Short", titleSource: "source" },
    );
    expect(chosen.title).toBe("Short");
  });

  it("prefers the richer Reddit permalink so both ingestion paths agree", () => {
    const bare = "https://www.reddit.com/comments/abc123";
    const full =
      "https://www.reddit.com/r/localfirst/comments/abc123/why_crdts";
    expect(chooseCanonicalUrl(bare, full)).toBe(full);
    expect(chooseCanonicalUrl(full, bare)).toBe(full);
  });
});

describe("reconcileRecords", () => {
  it("merges two records that share a content key", () => {
    const result = reconcileRecords(
      [
        record({
          contentKey: "linkedin:activity:1",
          category: "linkedin_saved_item",
        }),
        record({
          contentKey: "linkedin:activity:1",
          category: "linkedin_share",
          rawText: LONG_BODY,
          sourceFile: "Shares.csv",
        }),
      ],
      {
        selected: ["linkedin_saved_item", "linkedin_share"],
        crossReference: true,
      },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.rawText).toBe(LONG_BODY);
    expect(result.items[0]!.contentAvailability).toBe("full");
    expect(result.items[0]!.categories.sort()).toEqual([
      "linkedin_saved_item",
      "linkedin_share",
    ]);
  });

  it("does not merge two records with similar titles but different keys", () => {
    // A wrong merge destroys content; a missed merge only leaves an item thin.
    const result = reconcileRecords(
      [
        record({
          contentKey: "linkedin:activity:1",
          category: "linkedin_saved_item",
          title: "Local-first databases",
        }),
        record({
          contentKey: "linkedin:activity:2",
          category: "linkedin_saved_item",
          title: "Local-first databases",
          canonicalUrl:
            "https://www.linkedin.com/feed/update/urn:li:activity:2",
        }),
      ],
      { selected: ["linkedin_saved_item"], crossReference: true },
    );
    expect(result.items).toHaveLength(2);
  });

  it("lets an unselected file add context without creating an item", () => {
    const result = reconcileRecords(
      [
        record({
          contentKey: "linkedin:activity:1",
          category: "linkedin_saved_item",
        }),
        record({
          contentKey: "linkedin:activity:1",
          category: "linkedin_comment",
          userText: "This matches what we saw migrating our editor.",
          sourceFile: "Comments.csv",
        }),
        record({
          contentKey: "linkedin:activity:9",
          category: "linkedin_comment",
          canonicalUrl:
            "https://www.linkedin.com/feed/update/urn:li:activity:9",
          userText: "Unrelated comment on a post I never saved.",
        }),
      ],
      { selected: ["linkedin_saved_item"], crossReference: true },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.userText).toContain("migrating our editor");
    // The comment on a post that was not saved becomes nothing at all.
    expect(result.ignored).toBe(1);
  });

  it("imports only the selected files when cross-referencing is off", () => {
    const result = reconcileRecords(
      [
        record({
          contentKey: "linkedin:activity:1",
          category: "linkedin_saved_item",
        }),
        record({
          contentKey: "linkedin:activity:1",
          category: "linkedin_comment",
          userText: "Context that the user asked not to use.",
        }),
      ],
      { selected: ["linkedin_saved_item"], crossReference: false },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.userText).toBeNull();
    expect(result.items[0]!.contentAvailability).toBe("reference_only");
  });

  it("never lets a poorer record overwrite a richer one", () => {
    const result = reconcileRecords(
      [
        record({
          contentKey: "linkedin:activity:1",
          category: "linkedin_share",
          rawText: LONG_BODY,
          author: "jane-doe",
        }),
        record({
          contentKey: "linkedin:activity:1",
          category: "linkedin_saved_item",
          rawText: null,
          author: null,
        }),
      ],
      {
        selected: ["linkedin_share", "linkedin_saved_item"],
        crossReference: true,
      },
    );

    expect(result.items[0]!.rawText).toBe(LONG_BODY);
    expect(result.items[0]!.author).toBe("jane-doe");
  });

  it("keeps saved, created and acted timestamps distinct", () => {
    const result = reconcileRecords(
      [
        record({
          contentKey: "linkedin:activity:1",
          category: "linkedin_saved_item",
          sourceSavedAt: "2025-05-12T09:31:04.000Z",
        }),
        record({
          contentKey: "linkedin:activity:1",
          category: "linkedin_share",
          sourceCreatedAt: "2025-05-10T12:00:00.000Z",
        }),
        record({
          contentKey: "linkedin:activity:1",
          category: "linkedin_reaction",
          sourceActedAt: "2025-05-11T18:02:00.000Z",
        }),
      ],
      {
        selected: [
          "linkedin_saved_item",
          "linkedin_share",
          "linkedin_reaction",
        ],
        crossReference: true,
      },
    );

    const item = result.items[0]!;
    expect(item.sourceSavedAt).toBe("2025-05-12T09:31:04.000Z");
    expect(item.sourceCreatedAt).toBe("2025-05-10T12:00:00.000Z");
    expect(item.sourceActedAt).toBe("2025-05-11T18:02:00.000Z");
  });
});

describe("within-export enrichment, end to end", () => {
  it("turns a URL-only LinkedIn saved item into searchable content", async () => {
    // The Saved Item is a bare URL; Shares.csv in the same upload has the text.
    const analysis = await analyzeExport(
      "linkedin_export.zip",
      linkedInArchive({
        "Shares.csv": linkedInShares(),
        "Comments.csv": linkedInComments(),
      }),
    );

    const result = reconcileRecords(analysis.records, {
      selected: ["linkedin_saved_item"],
      crossReference: true,
    });

    const item = result.items.find(
      (candidate) => candidate.sourceId === "7100000000000000001",
    )!;
    expect(item.contentAvailability).toBe("full");
    expect(item.rawText).toContain("CRDT");
    expect(item.userText).toContain("Automerge");
    // Several files contributed, and every one of them is named.
    expect(item.sourceFiles.length).toBeGreaterThan(1);
    expect(hasSufficientContentForAi(item)).toBe(true);
  });

  it("recovers the author from Reactions even when no file has any text", async () => {
    // Saved_Items writes the bare `/feed/update/` form, which names nobody.
    // Reactions writes the `/posts/jane-doe-1234_…` form for the same
    // activity, so the author is recoverable without any network access.
    const analysis = await analyzeExport(
      "linkedin_export.zip",
      linkedInArchive(),
    );
    const result = reconcileRecords(analysis.records, {
      selected: ["linkedin_saved_item"],
      crossReference: true,
    });

    const item = result.items[0]!;
    expect(item.author).toBe("jane-doe-1234");
    expect(item.contentAvailability).toBe("partial");
    // Still no text anywhere, so no AI call is justified.
    expect(item.rawText).toBeNull();
    expect(hasSufficientContentForAi(item)).toBe(false);
  });

  it("stays reference-only when the export really has nothing else", async () => {
    const analysis = await analyzeExport(
      "Saved_Items.csv",
      new TextEncoder().encode(linkedInSavedItems()),
    );
    const result = reconcileRecords(analysis.records, {
      selected: ["linkedin_saved_item"],
      crossReference: true,
    });

    const item = result.items[0]!;
    expect(item.contentAvailability).toBe("reference_only");
    expect(item.rawText).toBeNull();
    expect(item.title).toBeNull();
    expect(item.sourceSavedAt).toBe("2025-05-12T09:31:04.000Z");
    expect(hasSufficientContentForAi(item)).toBe(false);
  });

  it("recovers a Reddit saved post from the user's own post and comment", async () => {
    const analysis = await analyzeExport(
      "reddit_export.zip",
      redditArchive({
        "posts.csv": redditOwnPosts(),
        "comments.csv": redditOwnComments(),
      }),
    );

    const result = reconcileRecords(analysis.records, {
      selected: ["reddit_saved_post"],
      crossReference: true,
    });

    const item = result.items.find(
      (candidate) => candidate.contentKey === "reddit:t3_abc123",
    )!;
    expect(item.contentAvailability).toBe("full");
    expect(item.rawText).toBe(LONG_BODY);
    // The verbatim title wins over the one decoded from the permalink slug.
    expect(item.title).toBe("Why CRDTs beat operational transforms");
    expect(item.titleSource).toBe("source");
    // The user's own comment on the thread is attributed to them, not the post.
    expect(item.userText).toContain("Automerge documents compact badly");
  });

  it("keeps a Reddit saved post reference-only when nothing else mentions it", async () => {
    const analysis = await analyzeExport("reddit_export.zip", redditArchive());
    const result = reconcileRecords(analysis.records, {
      selected: ["reddit_saved_post"],
      crossReference: true,
    });

    const item = result.items[0]!;
    expect(item.rawText).toBeNull();
    // A slug-decoded title makes it partial, and says where the title came from.
    expect(item.contentAvailability).toBe("partial");
    expect(item.titleSource).toBe("permalink_slug");
  });
});
