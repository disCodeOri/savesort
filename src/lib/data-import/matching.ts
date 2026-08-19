import type { NormalizedRecord, TitleSource } from "@/lib/data-import/types";

/**
 * How two records are decided to describe the same thing, and what happens
 * when they do.
 *
 * ## Matching strength
 *
 * Every record carries a `contentKey` built by the platform parser using the
 * strongest identity the export supplied, in this order:
 *
 *   1. platform content id      `reddit:t3_abc123`, `linkedin:activity:71…`
 *   2. provider permalink       parsed for its embedded id, same as above
 *   3. canonical normalized URL `linkedin:url:https://…`
 *
 * Records merge when and only when their content keys are equal. There is
 * deliberately no fuzzy matching: no title similarity, no timestamp proximity,
 * no author-plus-date heuristic. Two posts with near-identical titles are
 * routinely different posts, and a wrong merge destroys content silently while
 * a missed merge only leaves an item thinner than it could have been.
 *
 * ## Field precedence
 *
 * Merging never loses information. A present value is never replaced by a
 * missing one, richer text is never replaced by poorer text, and a verbatim
 * source title always beats one decoded from a permalink slug.
 */

/** Never replaces a present value with a missing one. */
export function firstPresent<T>(a: T | null, b: T | null): T | null {
  return a ?? b;
}

/** Richer text wins. Used for bodies, where longer really does mean more. */
export function longerText(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

export function mergeLists(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

const TITLE_RANK: Record<TitleSource, number> = {
  source: 3,
  permalink_slug: 2,
  fallback_label: 1,
};

/**
 * Picks the better title.
 *
 * Provenance outranks length: a short verbatim title from a `title` column is
 * better than a long one decoded from a URL slug, because only the first is
 * something the platform actually wrote.
 */
export function chooseTitle(
  a: { title: string | null; titleSource: TitleSource | null },
  b: { title: string | null; titleSource: TitleSource | null },
): { title: string | null; titleSource: TitleSource | null } {
  if (!a.title) return b;
  if (!b.title) return a;
  const rankA = a.titleSource ? TITLE_RANK[a.titleSource] : 0;
  const rankB = b.titleSource ? TITLE_RANK[b.titleSource] : 0;
  if (rankB > rankA) return b;
  if (rankA > rankB) return a;
  return b.title.length > a.title.length ? b : a;
}

/** Cap on merged user text, so a hundred comments cannot become one blob. */
const MAX_USER_TEXT = 4_000;

/**
 * Joins text the user wrote about the same object across files.
 *
 * Several comments on one post are all genuine context for finding it later,
 * so they accumulate rather than overwrite — bounded, and deduplicated so a
 * re-parse of the same file cannot grow the field.
 */
export function mergeUserText(
  a: string | null,
  b: string | null,
): string | null {
  if (!a) return b;
  if (!b) return a;
  if (a.includes(b)) return a;
  if (b.includes(a)) return b;
  const combined = `${a}\n${b}`;
  return combined.length > MAX_USER_TEXT
    ? combined.slice(0, MAX_USER_TEXT)
    : combined;
}

/**
 * Picks the canonical URL when two records name the same object differently.
 *
 * Reddit permalinks may or may not carry the subreddit and slug segments; both
 * resolve, but the longer form is the one Reddit itself publishes and the one
 * the OAuth sync produces, so preferring it keeps export-sourced and
 * API-sourced rows on the same key.
 */
export function chooseCanonicalUrl(a: string, b: string): string {
  if (a === b) return a;
  const segmentsA = new URL(a).pathname.split("/").filter(Boolean).length;
  const segmentsB = new URL(b).pathname.split("/").filter(Boolean).length;
  if (segmentsB > segmentsA) return b;
  if (segmentsA > segmentsB) return a;
  // Same shape, different text: pick deterministically so repeat imports of
  // the same archive always land on the same URL.
  return a < b ? a : b;
}

/** True when both records name the same platform object. */
export function isSameObject(
  a: NormalizedRecord,
  b: NormalizedRecord,
): boolean {
  return a.platform === b.platform && a.contentKey === b.contentKey;
}
