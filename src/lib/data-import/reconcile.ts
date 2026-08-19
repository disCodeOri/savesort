import { assessAvailability } from "@/lib/data-import/content-quality";
import {
  chooseCanonicalUrl,
  chooseTitle,
  firstPresent,
  longerText,
  mergeLists,
  mergeUserText,
} from "@/lib/data-import/matching";
import type {
  ImportCategory,
  NormalizedRecord,
  ReconciledItem,
} from "@/lib/data-import/types";

/**
 * Merges the records of one export into unique platform objects.
 *
 * This is where the maximum-recovery promise is kept, entirely from files the
 * user already uploaded. A LinkedIn saved item that arrived as a bare URL is
 * matched against the Reactions, Shares and Comments files sitting beside it;
 * a Reddit saved post is matched against the user's own posts and comments.
 * Nothing is fetched, and nothing is inferred from outside the upload.
 *
 * Categories the user did NOT select never create an item. They are still read
 * locally, and may add context to an item the user did select — which is the
 * entire reason a URL-only saved item can end up searchable.
 */

export interface ReconcileOptions {
  /** Categories that may create items. */
  selected: ImportCategory[];
  /**
   * Whether unselected recognised datasets may contribute context to selected
   * items. Off means an item is built only from the files it came from.
   */
  crossReference: boolean;
}

export interface ReconcileResult {
  items: ReconciledItem[];
  /** Records whose category was not selected and matched nothing. */
  ignored: number;
  /** Records that added context to an item from a different file. */
  enriched: number;
}

function toItem(record: NormalizedRecord): ReconciledItem {
  return {
    platform: record.platform,
    contentType: record.contentType,
    contentKey: record.contentKey,
    sourceId: record.sourceId,
    canonicalUrl: record.canonicalUrl,
    originalUrl: record.originalUrl,
    title: record.title,
    titleSource: record.titleSource,
    rawText: record.rawText,
    userText: record.userText,
    author: record.author,
    community: record.community,
    sourceCreatedAt: record.sourceCreatedAt,
    sourceSavedAt: record.sourceSavedAt,
    sourceActedAt: record.sourceActedAt,
    externalUrl: record.externalUrl,
    parentContentKey: record.parentContentKey,
    categories: [record.category],
    contentAvailability: assessAvailability(record),
    sourceFiles: [record.sourceFile],
    unresolvedMatches: 0,
  };
}

/**
 * Folds one record into an existing item.
 *
 * Every rule here is "keep the richer side". A poorer record can add a field
 * the item lacks; it can never take one away or replace a better one.
 */
function mergeInto(item: ReconciledItem, record: NormalizedRecord): void {
  const title = chooseTitle(item, record);
  item.title = title.title;
  item.titleSource = title.titleSource;

  item.rawText = longerText(item.rawText, record.rawText);
  item.userText = mergeUserText(item.userText, record.userText);
  item.author = firstPresent(item.author, record.author);
  item.community = firstPresent(item.community, record.community);
  item.sourceId = firstPresent(item.sourceId, record.sourceId);
  item.originalUrl = firstPresent(item.originalUrl, record.originalUrl);
  item.externalUrl = firstPresent(item.externalUrl, record.externalUrl);
  item.parentContentKey = firstPresent(
    item.parentContentKey,
    record.parentContentKey,
  );
  // Timestamps keep their distinct meanings; a created date never becomes a
  // saved date just because the saved date is missing.
  item.sourceCreatedAt = firstPresent(
    item.sourceCreatedAt,
    record.sourceCreatedAt,
  );
  item.sourceSavedAt = firstPresent(item.sourceSavedAt, record.sourceSavedAt);
  item.sourceActedAt = firstPresent(item.sourceActedAt, record.sourceActedAt);
  item.canonicalUrl = chooseCanonicalUrl(
    item.canonicalUrl,
    record.canonicalUrl,
  );

  item.categories = mergeLists(item.categories, [
    record.category,
  ]) as ImportCategory[];
  item.sourceFiles = mergeLists(item.sourceFiles, [record.sourceFile]);

  // Recomputed from merged text: an item that arrived reference-only becomes
  // partial or full the moment another file supplies real content.
  item.contentAvailability = assessAvailability(item);
}

export function reconcileRecords(
  records: NormalizedRecord[],
  options: ReconcileOptions,
): ReconcileResult {
  const selected = new Set(options.selected);
  const byKey = new Map<string, ReconciledItem>();
  const result: ReconcileResult = { items: [], ignored: 0, enriched: 0 };

  // Pass 1 — selected categories create items and merge with each other.
  for (const record of records) {
    if (!selected.has(record.category)) continue;
    const existing = byKey.get(record.contentKey);
    if (existing) {
      mergeInto(existing, record);
      if (!existing.sourceFiles.includes(record.sourceFile))
        result.enriched += 1;
    } else {
      byKey.set(record.contentKey, toItem(record));
    }
  }

  // Pass 2 — unselected categories may only add to what already exists.
  for (const record of records) {
    if (selected.has(record.category)) continue;
    if (!options.crossReference) {
      result.ignored += 1;
      continue;
    }
    const existing = byKey.get(record.contentKey);
    if (!existing) {
      result.ignored += 1;
      continue;
    }
    mergeInto(existing, record);
    result.enriched += 1;
  }

  // Pass 3 — a comment carries context for the post it sits under. The text
  // stays attributed to the user, never to the post's author.
  for (const record of records) {
    if (!record.parentContentKey || !record.rawText) continue;
    if (!options.crossReference && !selected.has(record.category)) continue;
    const parent = byKey.get(record.parentContentKey);
    if (!parent || parent.contentKey === record.contentKey) continue;

    parent.userText = mergeUserText(parent.userText, record.rawText);
    parent.community = firstPresent(parent.community, record.community);
    parent.sourceFiles = mergeLists(parent.sourceFiles, [record.sourceFile]);
    parent.contentAvailability = assessAvailability(parent);
    result.enriched += 1;
  }

  result.items = [...byKey.values()];
  return result;
}
