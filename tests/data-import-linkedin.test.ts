import { describe, expect, it } from "vitest";

import { analyzeExport } from "@/lib/data-import/analyze";
import { parseCsv } from "@/lib/data-import/csv";
import {
  normalizeLinkedInRow,
  parseLinkedInTable,
} from "@/lib/data-import/linkedin/parse";
import {
  authorHandleFrom,
  linkedInCanonicalUrl,
  linkedInContentKey,
  parseLinkedInUrl,
} from "@/lib/data-import/linkedin/urls";
import {
  detectSource,
  isRestrictedPlatformUrl,
} from "@/lib/sources/detect-source";

import {
  buildZip,
  csv,
  linkedInArchive,
  linkedInComments,
  linkedInReactions,
  linkedInSavedItems,
  linkedInSavedJobs,
  linkedInShares,
  LINKEDIN_ACTIVITY_URL,
  LINKEDIN_POSTS_URL,
  LINKEDIN_SHARE_TEXT,
} from "./data-import-fixtures";

function firstRow(source: string) {
  return parseCsv(source).rows[0]!;
}

describe("LinkedIn as a GRAPPlin source", () => {
  it("detects LinkedIn URLs as their own source, not a generic website", () => {
    expect(detectSource(LINKEDIN_ACTIVITY_URL)).toBe("linkedin");
    expect(detectSource("https://linkedin.com/in/someone")).toBe("linkedin");
  });

  it("marks LinkedIn restricted so generic ingestion never fetches it", () => {
    // This is what stops an imported LinkedIn URL from being scraped later.
    expect(isRestrictedPlatformUrl(LINKEDIN_ACTIVITY_URL)).toBe(true);
    expect(isRestrictedPlatformUrl("https://www.linkedin.com/posts/x")).toBe(
      true,
    );
    expect(isRestrictedPlatformUrl("https://example.com/post")).toBe(false);
  });
});

describe("LinkedIn URL identity", () => {
  it("recovers the same activity id from both URL forms", () => {
    // The whole cross-reference story depends on this: Saved_Items writes one
    // form and Reactions writes the other, for the same post.
    expect(parseLinkedInUrl(LINKEDIN_ACTIVITY_URL).objectId).toBe(
      "7100000000000000001",
    );
    expect(parseLinkedInUrl(LINKEDIN_POSTS_URL).objectId).toBe(
      "7100000000000000001",
    );
    expect(
      linkedInContentKey(linkedInCanonicalUrl(LINKEDIN_ACTIVITY_URL)!),
    ).toBe(linkedInContentKey(linkedInCanonicalUrl(LINKEDIN_POSTS_URL)!));
  });

  it("reduces both forms to one canonical permalink", () => {
    const expected =
      "https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001";
    expect(linkedInCanonicalUrl(LINKEDIN_ACTIVITY_URL)).toBe(expected);
    expect(linkedInCanonicalUrl(LINKEDIN_POSTS_URL)).toBe(expected);
  });

  it("strips tracking parameters and a trailing slash", () => {
    expect(
      linkedInCanonicalUrl(
        "https://www.linkedin.com/pulse/some-article-slug/?utm_source=share&trk=feed",
      ),
    ).toBe("https://www.linkedin.com/pulse/some-article-slug");
  });

  it("keeps an unfamiliar LinkedIn URL rather than rewriting it", () => {
    const unusual = "https://www.linkedin.com/some/new/shape/12345";
    expect(linkedInCanonicalUrl(unusual)).toBe(unusual);
  });

  it("refuses anything that is not LinkedIn, including dangerous schemes", () => {
    expect(
      linkedInCanonicalUrl("https://evil.example.com/feed/update/x"),
    ).toBeNull();
    expect(linkedInCanonicalUrl("javascript:alert(1)")).toBeNull();
    expect(linkedInCanonicalUrl("data:text/html,<script>")).toBeNull();
    expect(linkedInCanonicalUrl("file:///etc/passwd")).toBeNull();
  });

  it("reads the author handle the /posts/ URL already contains", () => {
    expect(authorHandleFrom(LINKEDIN_POSTS_URL)).toBe("jane-doe-1234");
    expect(authorHandleFrom(LINKEDIN_ACTIVITY_URL)).toBeNull();
  });

  it("keys a saved job by its job id", () => {
    expect(
      linkedInContentKey(
        linkedInCanonicalUrl("https://www.linkedin.com/jobs/view/3900000001/")!,
      ),
    ).toBe("linkedin:job:3900000001");
  });
});

describe("LinkedIn row normalization", () => {
  it("imports a saved item that is only a URL and a date", () => {
    const record = normalizeLinkedInRow(
      firstRow(linkedInSavedItems()),
      "linkedin_saved_item",
      "Saved_Items.csv",
    )!;

    expect(record.sourceId).toBe("7100000000000000001");
    expect(record.sourceSavedAt).toBe("2025-05-12T09:31:04.000Z");
    // Nothing is invented to fill the gaps LinkedIn left.
    expect(record.title).toBeNull();
    expect(record.rawText).toBeNull();
    expect(record.author).toBeNull();
    expect(record.sourceCreatedAt).toBeNull();
  });

  it("reads a share's own text as platform content", () => {
    const record = normalizeLinkedInRow(
      firstRow(linkedInShares()),
      "linkedin_share",
      "Shares.csv",
    )!;

    expect(record.rawText).toBe(LINKEDIN_SHARE_TEXT);
    // A share is dated by publication, never by a save that did not happen.
    expect(record.sourceCreatedAt).toBe("2025-05-10T12:00:00.000Z");
    expect(record.sourceSavedAt).toBeNull();
    expect(record.externalUrl).toBe("https://example.com/crdt-writeup");
  });

  it("keeps the user's own comment separate from the post's content", () => {
    const record = normalizeLinkedInRow(
      firstRow(linkedInComments()),
      "linkedin_comment",
      "Comments.csv",
    )!;

    // The comment is the user's, not LinkedIn's text for that URL.
    expect(record.rawText).toBeNull();
    expect(record.userText).toContain("Automerge");
    expect(record.sourceActedAt).toBe("2025-05-12T10:00:00.000Z");
  });

  it("records a reaction as a dated interaction with no content", () => {
    const record = normalizeLinkedInRow(
      firstRow(linkedInReactions()),
      "linkedin_reaction",
      "Reactions.csv",
    )!;
    expect(record.rawText).toBeNull();
    expect(record.userText).toBeNull();
    expect(record.sourceActedAt).toBe("2025-05-11T18:02:00.000Z");
  });

  it("reads a saved job's real title and company", () => {
    const record = normalizeLinkedInRow(
      firstRow(linkedInSavedJobs()),
      "linkedin_saved_job",
      "Saved_Jobs.csv",
    )!;
    expect(record.title).toBe("Staff Engineer, Sync");
    expect(record.titleSource).toBe("source");
    expect(record.community).toBe("Northwind Software");
    expect(record.sourceSavedAt).toBe("2025-04-02T08:00:00.000Z");
  });

  it("reports a non-LinkedIn saved URL as unresolved rather than importing it", () => {
    const table = parseCsv(
      csv(
        ["Saved Date", "savedItem"],
        [["2025-01-01", "https://example.com/x"]],
      ),
    );
    const parsed = parseLinkedInTable(
      table,
      "linkedin_saved_item",
      "Saved_Items.csv",
    );
    expect(parsed.records).toHaveLength(0);
    expect(parsed.unresolved).toBe(1);
  });

  it("accepts alternative column spellings", () => {
    const table = parseCsv(
      csv(["savedDate", "URL"], [["2025-05-12", LINKEDIN_ACTIVITY_URL]]),
    );
    const parsed = parseLinkedInTable(
      table,
      "linkedin_saved_item",
      "Saved_Items.csv",
    );
    expect(parsed.records).toHaveLength(1);
  });
});

describe("LinkedIn archive analysis", () => {
  it("detects LinkedIn and lists only the categories present", async () => {
    const result = await analyzeExport(
      "linkedin_export.zip",
      linkedInArchive(),
    );

    expect(result.platform).toBe("linkedin");
    const categories = result.datasets
      .map((dataset) => dataset.category)
      .sort();
    expect(categories).toEqual([
      "linkedin_reaction",
      "linkedin_saved_item",
      "linkedin_saved_job",
    ]);
    expect(result.defaultSelection.sort()).toEqual([
      "linkedin_saved_item",
      "linkedin_saved_job",
    ]);
  });

  it("never opens connections, messages, ad targeting, logins or the profile", async () => {
    const result = await analyzeExport(
      "linkedin_export.zip",
      linkedInArchive(),
    );
    const opened = result.files
      .filter((file) => file.status === "parsed")
      .map((file) => file.path);

    for (const forbidden of [
      "Connections.csv",
      "messages.csv",
      "Ad_Targeting.csv",
      "Logins.csv",
      "Profile.csv",
    ]) {
      expect(opened).not.toContain(forbidden);
    }
    expect(JSON.stringify(result.records)).not.toContain("PRIVATE");
    expect(JSON.stringify(result.records)).not.toContain("@example.com");
  });

  it("reads a standalone Saved_Items.csv", async () => {
    const result = await analyzeExport(
      "Saved_Items.csv",
      new TextEncoder().encode(linkedInSavedItems()),
    );
    expect(result.platform).toBe("linkedin");
    expect(result.records).toHaveLength(1);
  });

  it("survives a renamed Saved Items file", async () => {
    const archive = buildZip({
      "Basic_LinkedInDataExport/Saved Items (1).csv": linkedInSavedItems(),
      "Basic_LinkedInDataExport/Ad_Targeting.csv": csv(["a"], [["b"]]),
      "Basic_LinkedInDataExport/Saved_Jobs.csv": linkedInSavedJobs(),
    });
    const result = await analyzeExport("export.zip", archive);
    expect(result.platform).toBe("linkedin");
    expect(
      result.datasets.some(
        (dataset) => dataset.category === "linkedin_saved_item",
      ),
    ).toBe(true);
  });

  it("ignores an unknown new dataset and an empty file without failing", async () => {
    const archive = linkedInArchive({
      "Newsletters.csv": csv(["Title", "Frequency"], [["Weekly", "7"]]),
      "Reactions.csv": "Date,Type,Link\n",
    });
    const result = await analyzeExport("linkedin_export.zip", archive);
    expect(result.platform).toBe("linkedin");
    expect(
      result.datasets.find(
        (dataset) => dataset.category === "linkedin_reaction",
      ),
    ).toBeUndefined();
  });
});
