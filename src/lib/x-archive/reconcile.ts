import {
  availabilityFor,
  canonicalUrl,
  type ContentAvailability,
  type NormalizedRecord,
  type RelationshipType,
} from "@/lib/x-archive/normalize";

/**
 * Merges records describing the same post across archive files.
 *
 * The same post routinely appears in several datasets: liked, bookmarked, and
 * again in the user's own post history with full text. Those must become ONE
 * content item carrying several relationships, not three copies.
 *
 * Merging is index-driven (post id → record) rather than by rescanning, so
 * cost stays linear in the number of records regardless of archive size.
 */

export interface ReconciledItem {
  postId: string;
  canonicalUrl: string;
  text: string | null;
  authorUsername: string | null;
  authorName: string | null;
  createdAt: string | null;
  conversationId: string | null;
  replyToPostId: string | null;
  quotedPostId: string | null;
  hashtags: string[];
  mentions: string[];
  externalUrls: string[];
  mediaUrls: string[];
  contentAvailability: ContentAvailability;
  relationships: Array<{ type: RelationshipType; timestamp: string | null }>;
  sourceFiles: string[];
}

function longer(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

/** Never replaces a present value with null. */
function firstPresent<T>(a: T | null, b: T | null): T | null {
  return a ?? b;
}

function mergeLists(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function mergeRelationships(
  a: ReconciledItem["relationships"],
  b: NormalizedRecord["relationships"],
): ReconciledItem["relationships"] {
  const byType = new Map(a.map((entry) => [entry.type, entry]));
  for (const entry of b) {
    const existing = byType.get(entry.type);
    byType.set(entry.type, {
      type: entry.type,
      // A real timestamp always beats a missing one.
      timestamp: existing?.timestamp ?? entry.timestamp,
    });
  }
  return [...byType.values()];
}

function toItem(record: NormalizedRecord): ReconciledItem {
  return {
    postId: record.postId,
    canonicalUrl: record.canonicalUrl,
    text: record.text,
    authorUsername: record.authorUsername,
    authorName: record.authorName,
    createdAt: record.createdAt,
    conversationId: record.conversationId,
    replyToPostId: record.replyToPostId,
    quotedPostId: record.quotedPostId,
    hashtags: record.hashtags,
    mentions: record.mentions,
    externalUrls: record.externalUrls,
    mediaUrls: record.mediaUrls,
    contentAvailability: availabilityFor(record.text),
    relationships: record.relationships.map((entry) => ({ ...entry })),
    sourceFiles: [record.sourceFile],
  };
}

/**
 * Reconciles a batch of normalized records into unique content items keyed by
 * post id, which is the only identifier stable enough to merge on. Fuzzy text
 * matching is deliberately not used: wrongly merging two distinct posts is far
 * worse than leaving them separate.
 */
export function reconcileRecords(
  records: NormalizedRecord[],
): ReconciledItem[] {
  const byPostId = new Map<string, ReconciledItem>();

  for (const record of records) {
    const existing = byPostId.get(record.postId);
    if (!existing) {
      byPostId.set(record.postId, toItem(record));
      continue;
    }

    // Richer data wins field by field; nothing already known is discarded.
    existing.text = longer(existing.text, record.text);
    existing.authorUsername = firstPresent(
      existing.authorUsername,
      record.authorUsername,
    );
    existing.authorName = firstPresent(existing.authorName, record.authorName);
    existing.createdAt = firstPresent(existing.createdAt, record.createdAt);
    existing.conversationId = firstPresent(
      existing.conversationId,
      record.conversationId,
    );
    existing.replyToPostId = firstPresent(
      existing.replyToPostId,
      record.replyToPostId,
    );
    existing.quotedPostId = firstPresent(
      existing.quotedPostId,
      record.quotedPostId,
    );
    existing.hashtags = mergeLists(existing.hashtags, record.hashtags);
    existing.mentions = mergeLists(existing.mentions, record.mentions);
    existing.externalUrls = mergeLists(
      existing.externalUrls,
      record.externalUrls,
    );
    existing.mediaUrls = mergeLists(existing.mediaUrls, record.mediaUrls);
    existing.relationships = mergeRelationships(
      existing.relationships,
      record.relationships,
    );
    if (!existing.sourceFiles.includes(record.sourceFile)) {
      existing.sourceFiles.push(record.sourceFile);
    }

    // Recomputed from the merged text: a record that arrived reference-only
    // becomes full once another file supplies the post body.
    existing.contentAvailability = availabilityFor(existing.text);

    // A username learned later improves the canonical URL, but only while the
    // item is still using the anonymous form.
    if (
      existing.canonicalUrl.includes("/i/status/") &&
      existing.authorUsername
    ) {
      existing.canonicalUrl = canonicalUrl(
        existing.postId,
        existing.authorUsername,
      );
    }
  }

  return [...byPostId.values()];
}

/**
 * Only items with real text are worth AI spend. A post id or bare URL carries
 * no semantic content, so classifying or embedding it would produce a
 * confident-looking result with nothing behind it.
 */
export function isEligibleForAi(item: ReconciledItem): boolean {
  return item.contentAvailability !== "reference_only";
}
