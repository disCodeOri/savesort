import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: mocks.generateContent };
  },
  Type: {
    OBJECT: "OBJECT",
    STRING: "STRING",
    ARRAY: "ARRAY",
  },
}));

import {
  buildClassificationPrompt,
  CATEGORIES,
  classifyImportedItem,
  normalizeClassification,
} from "@/lib/data-import/classification";

import { LONG_BODY } from "./data-import-fixtures";

const INPUT = {
  title: "Why CRDTs beat operational transforms",
  rawText: LONG_BODY,
  userText: "Automerge documents compact badly once history is long.",
  community: "localfirst",
  author: "someone",
  contentType: "post",
};

function reply(payload: unknown) {
  return { text: JSON.stringify(payload) };
}

const VALID = {
  summary:
    "A comparison of CRDTs and operational transforms for local-first sync.",
  topics: ["distributed systems", "local-first software"],
  category: "Technology",
  subcategories: ["Databases"],
  keywords: ["CRDT", "operational transform", "offline sync"],
  language: "en",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GEMINI_API_KEY = "test-key";
});

describe("the prompt", () => {
  it("sends only text the export supplied", () => {
    const prompt = buildClassificationPrompt(INPUT);
    expect(prompt).toContain(LONG_BODY);
    expect(prompt).toContain("localfirst");
  });

  it("labels the user's own comment so it is not read as the post", () => {
    const prompt = buildClassificationPrompt(INPUT);
    expect(prompt).toContain("The user's own comment on this:");
  });

  it("never includes a URL for the model to look up", () => {
    const prompt = buildClassificationPrompt(INPUT);
    expect(prompt).not.toMatch(/https?:\/\//);
  });

  it("tells the model that thin input must produce a thin result", () => {
    expect(buildClassificationPrompt(INPUT)).toContain(
      "invented detail is not",
    );
  });
});

describe("normalizing what the model returned", () => {
  it("accepts a well-formed result", () => {
    const result = normalizeClassification(VALID, "test-model")!;
    expect(result.category).toBe("Technology");
    expect(result.keywords).toContain("crdt");
    expect(result.language).toBe("en");
    expect(result.classifierVersion).toBe("v1");
  });

  it("forces an unknown category into the closed taxonomy", () => {
    // A model can return anything; only a member of the set is ever stored.
    const result = normalizeClassification(
      { ...VALID, category: "Cryptocurrency Alpha" },
      "test-model",
    )!;
    expect(result.category).toBe("Other");
    expect(CATEGORIES).toContain(result.category);
  });

  it("caps list lengths and drops duplicates", () => {
    const result = normalizeClassification(
      {
        ...VALID,
        keywords: [
          ...Array.from({ length: 40 }, (_, i) => `term ${i}`),
          "TERM 0",
        ],
      },
      "test-model",
    )!;
    expect(result.keywords.length).toBeLessThanOrEqual(8);
    expect(new Set(result.keywords).size).toBe(result.keywords.length);
  });

  it("drops an absurdly long term rather than storing it", () => {
    const result = normalizeClassification(
      { ...VALID, topics: ["x".repeat(500), "distributed systems"] },
      "test-model",
    )!;
    expect(result.topics).toEqual(["distributed systems"]);
  });

  it("truncates a runaway summary", () => {
    const result = normalizeClassification(
      { ...VALID, summary: "word ".repeat(5_000) },
      "test-model",
    )!;
    expect(result.summary.length).toBeLessThanOrEqual(600);
  });

  it("rejects a result with nothing in it", () => {
    expect(
      normalizeClassification(
        { summary: "", topics: [], keywords: [] },
        "test-model",
      ),
    ).toBeNull();
    expect(normalizeClassification(null, "test-model")).toBeNull();
    expect(normalizeClassification("a string", "test-model")).toBeNull();
  });

  it("discards a language value that is not a language code", () => {
    expect(
      normalizeClassification(
        { ...VALID, language: "not a code" },
        "test-model",
      )!.language,
    ).toBeNull();
  });
});

describe("classifyImportedItem", () => {
  it("returns a normalized classification on success", async () => {
    mocks.generateContent.mockResolvedValue(reply(VALID));
    const outcome = await classifyImportedItem(INPUT);

    expect(outcome.status).toBe("ready");
    if (outcome.status === "ready") {
      expect(outcome.classification.topics).toContain("distributed systems");
    }
  });

  it("asks for structured JSON rather than parsing prose", async () => {
    mocks.generateContent.mockResolvedValue(reply(VALID));
    await classifyImportedItem(INPUT);

    const config = mocks.generateContent.mock.calls[0]![0].config;
    expect(config.responseMimeType).toBe("application/json");
    expect(config.responseSchema).toBeDefined();
    // Deterministic, so re-running an import does not churn the index.
    expect(config.temperature).toBe(0);
  });

  it("reports malformed JSON as a failure instead of throwing", async () => {
    mocks.generateContent.mockResolvedValue({ text: "not json at all" });
    const outcome = await classifyImportedItem(INPUT);
    expect(outcome.status).toBe("failed");
  });

  it("reports an empty result as a failure rather than a confident blank", async () => {
    mocks.generateContent.mockResolvedValue(
      reply({ summary: "", topics: [], keywords: [], category: "Technology" }),
    );
    expect((await classifyImportedItem(INPUT)).status).toBe("failed");
  });

  it("turns a rate limit or model error into a safe message", async () => {
    mocks.generateContent.mockRejectedValue(
      new Error("429 RESOURCE_EXHAUSTED: quota exceeded for project 12345"),
    );
    const outcome = await classifyImportedItem(INPUT);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      // No quota details, no project id, no stack trace.
      expect(outcome.error).toBe("Classification is temporarily unavailable.");
      expect(outcome.error).not.toContain("12345");
    }
  });

  it("does not call the model when no API key is configured", async () => {
    delete process.env.GEMINI_API_KEY;
    const outcome = await classifyImportedItem(INPUT);

    expect(outcome.status).toBe("failed");
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });
});
