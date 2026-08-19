import type { ContentAvailability } from "@/lib/data-import/types";

/**
 * How much of the thing the export actually handed over.
 *
 * This is a statement about the FILE, not a judgement about the content. A
 * LinkedIn saved item that arrives as a bare URL is `reference_only` because
 * LinkedIn shipped a bare URL, not because the post was uninteresting. Keeping
 * that distinction is what lets the UI explain the gap honestly instead of
 * showing an item that looks broken.
 */

/**
 * A body this long is a real piece of writing worth indexing on its own.
 *
 * Set for short-form social posts: a couple of sentences of genuine prose. A
 * higher bar would grade an ordinary LinkedIn post or Reddit self-post as
 * `partial`, which would understate what the export actually gave us.
 */
export const FULL_TEXT_MIN_CHARACTERS = 120;

/**
 * The bar for spending a Gemini call.
 *
 * Deliberately higher than the bar for `partial`: a subreddit name and an
 * author handle make an item worth displaying, but asking a model to summarise
 * "r/programming, posted by alice" produces a confident sentence about
 * nothing. Both a character floor and a word floor are required so a single
 * long unbroken token — a URL, a base64 blob — cannot pass.
 */
export const AI_MIN_CHARACTERS = 60;
export const AI_MIN_WORDS = 8;

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export interface QualityInput {
  /** Verbatim platform content. */
  rawText?: string | null;
  /** Text the user wrote about the item. */
  userText?: string | null;
  title?: string | null;
  community?: string | null;
  author?: string | null;
}

/**
 * Deterministic content-availability grading.
 *
 * `full` needs a substantial body. `partial` needs anything genuinely
 * descriptive — a title, a short comment, a subreddit. Everything else is a
 * reference: an id, a URL and a date.
 */
export function assessAvailability(input: QualityInput): ContentAvailability {
  const body = collapseWhitespace(input.rawText ?? "");
  if (body.length >= FULL_TEXT_MIN_CHARACTERS) return "full";

  const descriptive = collapseWhitespace(
    [body, input.userText, input.title, input.community, input.author]
      .filter((value): value is string => Boolean(value && value.trim()))
      .join(" "),
  );
  return descriptive.length > 0 ? "partial" : "reference_only";
}

function wordCount(value: string): number {
  return value.split(" ").filter((word) => word.length > 0).length;
}

/**
 * Whether there is enough meaning here to justify an AI call.
 *
 * Only real text counts. The subreddit, the author handle and the URL are
 * labels — they help a keyword search and they belong in the indexed document,
 * but they are not something a model can summarise.
 */
export function hasSufficientContentForAi(input: QualityInput): boolean {
  const semantic = collapseWhitespace(
    [input.rawText, input.userText, input.title]
      .filter((value): value is string => Boolean(value && value.trim()))
      .join(" "),
  );
  return (
    semantic.length >= AI_MIN_CHARACTERS && wordCount(semantic) >= AI_MIN_WORDS
  );
}
