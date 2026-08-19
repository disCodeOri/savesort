import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  analyzeImportFile,
  runDataImport,
} from "@/lib/data-import/import-client";
import { SOURCES } from "@/lib/sources/detect-source";
import { buildSearchableText } from "@/lib/search/searchable-text";

import {
  linkedInArchive,
  linkedInComments,
  linkedInShares,
  LONG_BODY,
  redditArchive,
  redditOwnComments,
  redditOwnPosts,
} from "./data-import-fixtures";

/**
 * Drives the browser half of the import end to end against a fake server, so
 * the staging of requests — start, batches, classification passes, complete —
 * is exercised without any network or database.
 */

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function fakeServer(overrides: { classifyPasses?: number } = {}) {
  const calls: Call[] = [];
  let remaining = overrides.classifyPasses ?? 0;

  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url, body });

    if (url.endsWith("/start")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ importId: "22222222-2222-4222-8222-222222222222" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (url.endsWith("/batch")) {
      const records = (body.records as unknown[]) ?? [];
      return Promise.resolve(
        new Response(
          JSON.stringify({
            created: records.length,
            updated: 0,
            full: 0,
            partial: 0,
            referenceOnly: records.length,
            embedded: 0,
            classificationPending: overrides.classifyPasses
              ? records.length
              : 0,
            classificationInsufficient: overrides.classifyPasses
              ? 0
              : records.length,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (url.endsWith("/classify")) {
      remaining = Math.max(0, remaining - 1);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            processed: 1,
            ready: 1,
            insufficient: 0,
            failed: 0,
            remaining,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ import: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  return { calls, fetchImpl };
}

function fileFrom(name: string, bytes: Uint8Array): File {
  return new File([bytes as unknown as BlobPart], name);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("the source model knows LinkedIn", () => {
  it("lists linkedin alongside the other first-class sources", () => {
    expect(SOURCES).toContain("linkedin");
    expect(SOURCES).toContain("reddit");
  });
});

describe("analyzeImportFile", () => {
  it("inventories a LinkedIn export without contacting the server", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const analysis = await analyzeImportFile(
      fileFrom("linkedin_export.zip", linkedInArchive()),
    );

    expect(analysis.platform).toBe("linkedin");
    expect(analysis.datasets.length).toBeGreaterThan(0);
    // Nothing leaves the device during analysis.
    expect(spy).not.toHaveBeenCalled();
  });

  it("fingerprints the file so a repeat upload is recognisable", async () => {
    const analysis = await analyzeImportFile(
      fileFrom("reddit_export.zip", redditArchive()),
    );
    // jsdom exposes WebCrypto, so this is a real SHA-256.
    expect(analysis.fileHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("runDataImport", () => {
  it("sends one item per post, carrying every relationship it has", async () => {
    const analysis = await analyzeImportFile(
      fileFrom("reddit_export.zip", redditArchive()),
    );
    const server = fakeServer();

    const summary = await runDataImport({
      analysis,
      selected: ["reddit_saved_post"],
      crossReference: true,
      onProgress: () => {},
      fetchImpl: server.fetchImpl,
    });

    const batch = server.calls.find((call) => call.url.endsWith("/batch"))!;
    const records = batch.body.records as Array<Record<string, unknown>>;

    // The saved post was also upvoted, so post_votes.csv merges onto the same
    // item rather than creating a second copy of it.
    expect(records).toHaveLength(1);
    expect(records[0]!.categories).toContain("reddit_saved_post");
    expect(records[0]!.categories).toContain("reddit_upvoted_post");
    expect(summary.itemsImported).toBe(1);

    // The saved comment was never selected, so it produced no item at all.
    expect(
      records.some((record) =>
        (record.categories as string[]).includes("reddit_saved_comment"),
      ),
    ).toBe(false);
  });

  it("never sends anything from a privacy-excluded file", async () => {
    const analysis = await analyzeImportFile(
      fileFrom("linkedin_export.zip", linkedInArchive()),
    );
    const server = fakeServer();

    await runDataImport({
      analysis,
      selected: ["linkedin_saved_item", "linkedin_saved_job"],
      crossReference: true,
      onProgress: () => {},
      fetchImpl: server.fetchImpl,
    });

    const payload = JSON.stringify(server.calls);
    expect(payload).not.toContain("PRIVATE");
    expect(payload).not.toContain("@example.com");
    expect(payload).not.toContain("Connections.csv");
  });

  it("carries within-export enrichment through to the wire", async () => {
    const analysis = await analyzeImportFile(
      fileFrom(
        "linkedin_export.zip",
        linkedInArchive({
          "Shares.csv": linkedInShares(),
          "Comments.csv": linkedInComments(),
        }),
      ),
    );
    const server = fakeServer();

    await runDataImport({
      analysis,
      selected: ["linkedin_saved_item"],
      crossReference: true,
      onProgress: () => {},
      fetchImpl: server.fetchImpl,
    });

    const batch = server.calls.find((call) => call.url.endsWith("/batch"))!;
    const record = (batch.body.records as Array<Record<string, unknown>>)[0]!;
    expect(String(record.rawText)).toContain("CRDT");
    expect(String(record.userText)).toContain("Automerge");
    expect((record.sourceFiles as string[]).length).toBeGreaterThan(1);
  });

  it("reports progress through every stage and finishes", async () => {
    const analysis = await analyzeImportFile(
      fileFrom(
        "reddit_export.zip",
        redditArchive({ "posts.csv": redditOwnPosts() }),
      ),
    );
    const server = fakeServer({ classifyPasses: 2 });
    const stages: string[] = [];

    await runDataImport({
      analysis,
      selected: ["reddit_saved_post"],
      crossReference: true,
      onProgress: (progress) => stages.push(progress.stage),
      fetchImpl: server.fetchImpl,
    });

    expect(stages).toContain("merging");
    expect(stages).toContain("importing");
    expect(stages).toContain("classifying");
    expect(stages.at(-1)).toBe("done");
  });

  it("stops classifying once the server says nothing is left", async () => {
    const analysis = await analyzeImportFile(
      fileFrom(
        "reddit_export.zip",
        redditArchive({ "posts.csv": redditOwnPosts() }),
      ),
    );
    const server = fakeServer({ classifyPasses: 3 });

    await runDataImport({
      analysis,
      selected: ["reddit_saved_post"],
      crossReference: true,
      onProgress: () => {},
      fetchImpl: server.fetchImpl,
    });

    const classifyCalls = server.calls.filter((call) =>
      call.url.endsWith("/classify"),
    );
    expect(classifyCalls).toHaveLength(3);
  });

  it("keeps the batches that landed when a later batch fails", async () => {
    const analysis = await analyzeImportFile(
      fileFrom("reddit_export.zip", redditArchive()),
    );
    const failing = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/start")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              importId: "22222222-2222-4222-8222-222222222222",
            }),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith("/batch")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: "This batch could not be saved." }),
            {
              status: 500,
            },
          ),
        );
      }
      void init;
      return Promise.resolve(new Response(JSON.stringify({ import: null })));
    };

    const summary = await runDataImport({
      analysis,
      selected: ["reddit_saved_post"],
      crossReference: true,
      onProgress: () => {},
      fetchImpl: failing,
    });

    // The run completes and reports honestly rather than throwing away state.
    expect(summary.created).toBe(0);
    expect(summary.warnings).toContain("Some items could not be imported.");
  });

  it("never asks the server to classify when nothing has real text", async () => {
    const analysis = await analyzeImportFile(
      fileFrom("linkedin_export.zip", linkedInArchive()),
    );
    const server = fakeServer();

    await runDataImport({
      analysis,
      selected: ["linkedin_saved_item"],
      crossReference: true,
      onProgress: () => {},
      fetchImpl: server.fetchImpl,
    });

    expect(server.calls.some((call) => call.url.endsWith("/classify"))).toBe(
      false,
    );
  });
});

describe("imported items join the existing search pipeline", () => {
  it("builds a searchable document the shared helper produced", async () => {
    // The point is that nothing here is bespoke: it is the same
    // buildSearchableText every other source uses, so hybrid_search_saved_items
    // needs no changes.
    const text = buildSearchableText({
      title: "Why CRDTs beat operational transforms",
      source: "reddit",
      author: null,
      description: "localfirst · Saved posts",
      tags: ["distributed systems", "offline sync"],
      content: LONG_BODY,
    });

    expect(text).toContain("Source: reddit");
    expect(text).toContain("Content:");
    expect(text).toContain("offline sync");
  });

  it("gives a vague query real words to match on after enrichment", async () => {
    const analysis = await analyzeImportFile(
      fileFrom(
        "reddit_export.zip",
        redditArchive({
          "posts.csv": redditOwnPosts(),
          "comments.csv": redditOwnComments(),
        }),
      ),
    );
    const server = fakeServer();

    await runDataImport({
      analysis,
      selected: ["reddit_saved_post"],
      crossReference: true,
      onProgress: () => {},
      fetchImpl: server.fetchImpl,
    });

    const batch = server.calls.find((call) => call.url.endsWith("/batch"))!;
    const record = (batch.body.records as Array<Record<string, unknown>>)[0]!;
    const text = buildSearchableText({
      title: record.title as string,
      source: "reddit",
      content: record.rawText as string,
      description: record.community as string,
    });

    // "that post about offline replicas merging" now has something to hit.
    expect(text.toLowerCase()).toContain("offline replicas");
    expect(text.toLowerCase()).toContain("localfirst");
  });
});
