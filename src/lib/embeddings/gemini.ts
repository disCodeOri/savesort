import { GoogleGenAI } from "@google/genai";

const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;
const MAX_EMBEDDING_CHARACTERS = 12_000;

// Repeated identical queries (URL round-trips, pagination, backspacing) must
// not pay a provider round-trip every time. Failures are never cached.
const EMBEDDING_CACHE_LIMIT = 64;
const embeddingCache = new Map<string, number[]>();

// One SDK client per API key; constructing a client is pure overhead.
const MAX_CACHED_CLIENTS = 4;
const clients = new Map<string, GoogleGenAI>();

export type EmbeddingTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export interface EmbeddingResult {
  embedding: number[] | null;
  error: string | null;
}

function normalizeVector(values: number[]): number[] {
  const magnitude = Math.sqrt(
    values.reduce((sum, value) => sum + value * value, 0),
  );
  return magnitude > 0 ? values.map((value) => value / magnitude) : values;
}

function getClient(apiKey: string): GoogleGenAI {
  let client = clients.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({ apiKey });
    clients.set(apiKey, client);
    if (clients.size > MAX_CACHED_CLIENTS) {
      const oldest = clients.keys().next().value;
      if (oldest !== undefined) clients.delete(oldest);
    }
  }
  return client;
}

function readCachedEmbedding(key: string): number[] | null {
  const cached = embeddingCache.get(key);
  if (!cached) return null;
  // Refresh insertion order so the cache evicts least-recently-used entries.
  embeddingCache.delete(key);
  embeddingCache.set(key, cached);
  return cached;
}

function storeCachedEmbedding(key: string, embedding: number[]): void {
  embeddingCache.set(key, embedding);
  if (embeddingCache.size > EMBEDDING_CACHE_LIMIT) {
    const oldest = embeddingCache.keys().next().value;
    if (oldest !== undefined) embeddingCache.delete(oldest);
  }
}

export async function createEmbedding(
  text: string,
  taskType: EmbeddingTask,
): Promise<EmbeddingResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { embedding: null, error: "Semantic indexing is not configured." };
  }

  const cacheKey = `${taskType}:${text}`;
  const cached = readCachedEmbedding(cacheKey);
  if (cached) return { embedding: cached, error: null };

  try {
    const client = getClient(apiKey);
    const response = await client.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: text.slice(0, MAX_EMBEDDING_CHARACTERS),
      config: {
        taskType,
        outputDimensionality: EMBEDDING_DIMENSIONS,
      },
    });
    const values = response.embeddings?.[0]?.values;
    if (!values || values.length !== EMBEDDING_DIMENSIONS) {
      return {
        embedding: null,
        error: "Semantic indexing returned an unexpected result.",
      };
    }
    const embedding = normalizeVector(values);
    storeCachedEmbedding(cacheKey, embedding);
    return { embedding, error: null };
  } catch {
    return {
      embedding: null,
      error: "Semantic indexing is temporarily unavailable.",
    };
  }
}

export function embedDocument(text: string): Promise<EmbeddingResult> {
  return createEmbedding(text, "RETRIEVAL_DOCUMENT");
}

export function embedQuery(text: string): Promise<EmbeddingResult> {
  return createEmbedding(text, "RETRIEVAL_QUERY");
}
