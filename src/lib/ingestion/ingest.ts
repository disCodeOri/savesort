import { embedDocument } from "@/lib/embeddings/gemini";
import { enrichGitHubRepository } from "@/lib/ingestion/github";
import { enrichPublicWebpage } from "@/lib/ingestion/web";
import { buildSearchableText } from "@/lib/search/searchable-text";
import {
  detectSource,
  isRestrictedPlatformUrl,
  type Source,
} from "@/lib/sources/detect-source";
import { normalizeUrl } from "@/lib/urls/normalize";

export interface IngestInput {
  url: string;
  title?: string;
  notes?: string;
  content?: string;
  tags?: string[];
}

export interface IngestedItem {
  url: string;
  normalized_url: string;
  source: Source;
  title: string | null;
  description: string | null;
  notes: string | null;
  content: string | null;
  author: string | null;
  thumbnail_url: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  searchable_text: string;
  embedding: number[] | null;
  indexing_status: "ready" | "keyword_only";
  indexing_error: string | null;
}

function shouldFetchWebsite(url: string): boolean {
  return !isRestrictedPlatformUrl(url);
}

export async function ingestSavedItem(
  input: IngestInput,
): Promise<IngestedItem> {
  const normalizedUrl = normalizeUrl(input.url);
  const source = detectSource(normalizedUrl);
  let title = input.title?.trim() || null;
  let description: string | null = null;
  let content = input.content?.trim() || null;
  let author: string | null = null;
  let thumbnailUrl: string | null = null;
  let tags = input.tags ?? [];
  let metadata: Record<string, unknown> = {};
  let enrichmentError: string | null = null;

  try {
    if (source === "github") {
      const github = await enrichGitHubRepository(normalizedUrl);
      title ??= github.title;
      description = github.description;
      content ??= github.content;
      author = github.author;
      tags = [...new Set([...tags, ...github.tags])];
      metadata = github.metadata;
    } else if (shouldFetchWebsite(normalizedUrl)) {
      const page = await enrichPublicWebpage(normalizedUrl);
      title ??= page.title;
      description = page.description;
      content ??= page.content;
      thumbnailUrl = page.thumbnailUrl;
      metadata = page.canonicalUrl ? { canonicalUrl: page.canonicalUrl } : {};
    }
  } catch {
    enrichmentError =
      "We saved the link, but couldn't fetch all of its metadata.";
  }

  title ??= new URL(normalizedUrl).hostname;
  const searchableText = buildSearchableText({
    title,
    source,
    author,
    description,
    tags,
    notes: input.notes,
    content,
  });
  const embedded = await embedDocument(searchableText);
  const indexingError = embedded.error ?? enrichmentError;

  return {
    url: input.url.trim(),
    normalized_url: normalizedUrl,
    source,
    title,
    description,
    notes: input.notes?.trim() || null,
    content,
    author,
    thumbnail_url: thumbnailUrl,
    tags,
    metadata,
    searchable_text: searchableText,
    embedding: embedded.embedding,
    indexing_status: embedded.embedding ? "ready" : "keyword_only",
    indexing_error: indexingError,
  };
}
