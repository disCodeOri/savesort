import { GoogleGenAI } from "@google/genai";

const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;
const MAX_EMBEDDING_CHARACTERS = 12_000;

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

export async function createEmbedding(
  text: string,
  taskType: EmbeddingTask,
): Promise<EmbeddingResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { embedding: null, error: "Semantic indexing is not configured." };
  }

  try {
    const client = new GoogleGenAI({ apiKey });
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
    return { embedding: normalizeVector(values), error: null };
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
