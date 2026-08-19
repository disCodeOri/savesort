import "server-only";

import { GoogleGenAI, Type } from "@google/genai";

/**
 * Retrieval enrichment for imported items.
 *
 * The model is given ONLY text the export supplied. It is never given a URL to
 * look up, never asked what a link contains, and never called at all for an
 * item that has no real text — a Gemini call on "r/programming, saved 12 May"
 * would return a fluent paragraph about nothing, and that paragraph would then
 * pollute search results forever.
 *
 * Everything produced here is generated data. It is stored under
 * `metadata.generated`, never written into the source content fields, and
 * never added to the user's own tags.
 */

/** Bumped when the prompt or taxonomy changes, so items can be reprocessed. */
export const CLASSIFIER_VERSION = "v1";
export const TAXONOMY_VERSION = "v1";

/**
 * A deliberately small closed set. A large taxonomy drifts — the same item
 * lands in "AI" one week and "Machine Learning" the next — which makes the
 * category useless as a filter. Anything specific belongs in topics.
 */
export const CATEGORIES = [
  "Technology",
  "Business",
  "Science",
  "Design",
  "Health & Fitness",
  "Education",
  "Career",
  "Finance",
  "Culture & Entertainment",
  "News & Society",
  "Lifestyle",
  "Other",
] as const;

export type ClassificationCategory = (typeof CATEGORIES)[number];

export interface Classification {
  summary: string;
  topics: string[];
  category: ClassificationCategory;
  subcategories: string[];
  keywords: string[];
  language: string | null;
  model: string;
  classifierVersion: string;
  taxonomyVersion: string;
}

export type ClassificationOutcome =
  | { status: "ready"; classification: Classification }
  | { status: "insufficient_content" }
  | { status: "failed"; error: string };

const MAX_SUMMARY = 600;
const MAX_LIST = 8;
const MAX_TERM = 60;
const MAX_INPUT_CHARACTERS = 8_000;

const PROMPT = `You are indexing a saved item so its owner can find it later with a vague description.

Work ONLY from the text provided below. It came from the user's own platform data export and may be incomplete. Never state a fact that is not in the text. If the text is thin, produce a thin result: a short summary and few keywords is correct, invented detail is not.

Write the summary as plain prose in at most three sentences, describing what the item is about using the concrete terms a person might half-remember. Do not mention the export, the platform, or that you are summarising.

Choose exactly one category from the allowed list. Topics, subcategories and keywords may be more specific; keep each to a few words and prefer terms that would appear in a search.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    topics: { type: Type.ARRAY, items: { type: Type.STRING } },
    category: { type: Type.STRING, enum: [...CATEGORIES] },
    subcategories: { type: Type.ARRAY, items: { type: Type.STRING } },
    keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
    language: { type: Type.STRING },
  },
  required: ["summary", "topics", "category", "keywords"],
} as const;

export interface ClassificationInput {
  title: string | null;
  rawText: string | null;
  userText: string | null;
  community: string | null;
  author: string | null;
  contentType: string;
}

/**
 * Assembles the model input.
 *
 * Labelled so the model cannot mistake the user's own comment for the post it
 * was written under, and truncated so one oversized field cannot dominate.
 */
export function buildClassificationPrompt(input: ClassificationInput): string {
  const lines = [
    input.title ? `Title: ${input.title}` : null,
    input.community ? `Community: ${input.community}` : null,
    input.author ? `Author: ${input.author}` : null,
    input.rawText ? `Content: ${input.rawText}` : null,
    input.userText ? `The user's own comment on this: ${input.userText}` : null,
  ].filter((line): line is string => Boolean(line));

  return `${PROMPT}\n\n---\n${lines.join("\n")}`.slice(0, MAX_INPUT_CHARACTERS);
}

function cleanTerm(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim().toLowerCase();
  if (!trimmed || trimmed.length > MAX_TERM) return null;
  return trimmed;
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const terms = value
    .map(cleanTerm)
    .filter((term): term is string => term !== null);
  return [...new Set(terms)].slice(0, MAX_LIST);
}

function cleanCategory(value: unknown): ClassificationCategory {
  // A model can return anything; only a member of the closed set is stored.
  const match = CATEGORIES.find(
    (category) =>
      typeof value === "string" &&
      category.toLowerCase() === value.trim().toLowerCase(),
  );
  return match ?? "Other";
}

function cleanLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase().slice(0, 12);
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(code) ? code : null;
}

/** Normalizes and bounds whatever the model returned. */
export function normalizeClassification(
  value: unknown,
  model: string,
): Classification | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  const summary =
    typeof record.summary === "string"
      ? record.summary.replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY)
      : "";
  const topics = cleanList(record.topics);
  const keywords = cleanList(record.keywords);

  // A result with no summary and no terms is not a usable classification;
  // recording it as "ready" would hide a silent failure.
  if (!summary && topics.length === 0 && keywords.length === 0) return null;

  return {
    summary,
    topics,
    category: cleanCategory(record.category),
    subcategories: cleanList(record.subcategories),
    keywords,
    language: cleanLanguage(record.language),
    model,
    classifierVersion: CLASSIFIER_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
  };
}

function classificationModel(): string {
  return process.env.GEMINI_CLASSIFICATION_MODEL || "gemini-2.5-flash";
}

/**
 * Classifies one item.
 *
 * Callers must have already checked `hasSufficientContentForAi`; this is a
 * cost boundary, not a content gate. A failure returns `failed` and the item
 * keeps whatever keyword-searchable text it already had.
 */
export async function classifyImportedItem(
  input: ClassificationInput,
): Promise<ClassificationOutcome> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { status: "failed", error: "Classification is not configured." };
  }

  const model = classificationModel();
  try {
    const client = new GoogleGenAI({ apiKey });
    const response = await client.models.generateContent({
      model,
      contents: buildClassificationPrompt(input),
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0,
      },
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text ?? "");
    } catch {
      return {
        status: "failed",
        error: "Classification returned an unexpected result.",
      };
    }

    const classification = normalizeClassification(parsed, model);
    if (!classification) {
      return {
        status: "failed",
        error: "Classification returned an unexpected result.",
      };
    }
    return { status: "ready", classification };
  } catch {
    return {
      status: "failed",
      error: "Classification is temporarily unavailable.",
    };
  }
}
