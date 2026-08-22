import { beforeEach, describe, expect, it, vi } from "vitest";

const { embedContent, constructorCalls } = vi.hoisted(() => ({
  embedContent: vi.fn(),
  constructorCalls: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { embedContent };
    constructor(options: { apiKey: string }) {
      constructorCalls(options);
    }
  },
}));

import { EMBEDDING_DIMENSIONS, createEmbedding } from "@/lib/embeddings/gemini";

const KEY_ENV = "GEMINI_API_KEY";

function fullVector(): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => index + 1);
}

describe("createEmbedding", () => {
  beforeEach(() => {
    embedContent.mockReset();
    constructorCalls.mockReset();
    process.env[KEY_ENV] = "test-key";
  });

  it("normalizes vectors and reuses one client plus cache for identical queries", async () => {
    embedContent.mockResolvedValue({ embeddings: [{ values: fullVector() }] });

    const first = await createEmbedding("same text", "RETRIEVAL_QUERY");
    const second = await createEmbedding("same text", "RETRIEVAL_QUERY");

    expect(embedContent).toHaveBeenCalledTimes(1);
    expect(constructorCalls).toHaveBeenCalledTimes(1);
    const magnitude = Math.sqrt(
      first.embedding!.reduce((sum, value) => sum + value * value, 0),
    );
    expect(magnitude).toBeCloseTo(1);
    expect(second.embedding).toEqual(first.embedding);
    expect(first.error).toBeNull();
  });

  it("keeps document and query task types in separate cache slots", async () => {
    embedContent.mockResolvedValue({ embeddings: [{ values: fullVector() }] });

    await createEmbedding("shared text", "RETRIEVAL_DOCUMENT");
    await createEmbedding("shared text", "RETRIEVAL_QUERY");

    expect(embedContent).toHaveBeenCalledTimes(2);
  });

  it("never caches failures so a later retry reaches the provider", async () => {
    embedContent
      .mockRejectedValueOnce(new Error("429"))
      .mockResolvedValueOnce({ embeddings: [{ values: fullVector() }] });

    const failed = await createEmbedding("flaky text", "RETRIEVAL_QUERY");
    const recovered = await createEmbedding("flaky text", "RETRIEVAL_QUERY");

    expect(failed.embedding).toBeNull();
    expect(recovered.embedding).not.toBeNull();
    expect(embedContent).toHaveBeenCalledTimes(2);
  });

  it("rejects unexpected dimensions without caching them", async () => {
    embedContent
      .mockResolvedValueOnce({ embeddings: [{ values: [0.1, 0.2] }] })
      .mockResolvedValueOnce({ embeddings: [{ values: fullVector() }] });

    const bad = await createEmbedding("dimension text", "RETRIEVAL_QUERY");
    const good = await createEmbedding("dimension text", "RETRIEVAL_QUERY");

    expect(bad.embedding).toBeNull();
    expect(bad.error).toBe("Semantic indexing returned an unexpected result.");
    expect(good.embedding).not.toBeNull();
    expect(embedContent).toHaveBeenCalledTimes(2);
  });

  it("stays keyword-only when no API key is configured", async () => {
    delete process.env[KEY_ENV];

    const result = await createEmbedding("any text", "RETRIEVAL_QUERY");

    expect(result).toEqual({
      embedding: null,
      error: "Semantic indexing is not configured.",
    });
    expect(embedContent).not.toHaveBeenCalled();
  });
});
