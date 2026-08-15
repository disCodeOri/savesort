import type { GitHubStarredRepository } from "@/lib/github/types";
import { buildSearchableText } from "@/lib/search/searchable-text";
import { normalizeUrl } from "@/lib/urls/normalize";

export interface GitHubProviderMetadata {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  homepage: string | null;
  stars: number;
  forks: number;
  stargazersCount: number;
  forksCount: number;
  visibility: string;
  license: string | null;
  starredAt: string;
  archived: boolean;
  providerTags: string[];
}

export interface GitHubProviderItem {
  url: string;
  normalized_url: string;
  source: "github";
  title: string;
  description: string | null;
  notes: null;
  content: null;
  author: string;
  thumbnail_url: null;
  tags: string[];
  metadata: { github: GitHubProviderMetadata };
  searchable_text: string;
}

export interface GitHubMergedItem extends Omit<
  GitHubProviderItem,
  "notes" | "content" | "thumbnail_url"
> {
  notes: string | null;
  content: string | null;
  thumbnail_url: string | null;
  metadata: Record<string, unknown> & { github: GitHubProviderMetadata };
}

function providerTags(repository: GitHubStarredRepository): string[] {
  return [
    ...new Set(
      [...repository.repo.topics, repository.repo.language].filter(
        (tag): tag is string => Boolean(tag),
      ),
    ),
  ];
}

export function mapGitHubStar(
  repository: GitHubStarredRepository,
): GitHubProviderItem {
  const repo = repository.repo;
  const tags = providerTags(repository);
  const github: GitHubProviderMetadata = {
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    owner: repo.owner.login,
    homepage: repo.homepage,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    stargazersCount: repo.stargazers_count,
    forksCount: repo.forks_count,
    visibility: repo.visibility,
    license: repo.license?.spdx_id ?? null,
    starredAt: repository.starred_at,
    archived: repo.archived,
    providerTags: tags,
  };
  const item: GitHubProviderItem = {
    url: repo.html_url,
    normalized_url: normalizeUrl(repo.html_url),
    source: "github",
    title: repo.full_name,
    description: repo.description,
    notes: null,
    content: null,
    author: repo.owner.login,
    thumbnail_url: null,
    tags,
    metadata: { github },
    searchable_text: "",
  };
  item.searchable_text = buildSearchableText(item);
  return item;
}

export function mergeGitHubProviderItem(
  existing: {
    url: string;
    normalized_url: string;
    title: string | null;
    description: string | null;
    notes: string | null;
    content: string | null;
    author: string | null;
    thumbnail_url: string | null;
    tags: string[];
    metadata: Record<string, unknown>;
  },
  provider: GitHubProviderItem,
): GitHubMergedItem {
  const oldProviderTags =
    existing.metadata.github &&
    typeof existing.metadata.github === "object" &&
    Array.isArray(
      (existing.metadata.github as { providerTags?: unknown }).providerTags,
    )
      ? (
          existing.metadata.github as { providerTags: unknown[] }
        ).providerTags.filter((tag): tag is string => typeof tag === "string")
      : [];
  const userTags = existing.tags.filter(
    (tag) => !oldProviderTags.includes(tag),
  );
  const tags = [...new Set([...userTags, ...provider.tags])];
  const metadata = {
    ...existing.metadata,
    github: provider.metadata.github,
  } as GitHubMergedItem["metadata"];
  const merged: GitHubMergedItem = {
    ...provider,
    notes: existing.notes,
    content: existing.content,
    thumbnail_url: existing.thumbnail_url,
    tags,
    metadata,
    searchable_text: "",
  };
  merged.searchable_text = buildSearchableText(merged);
  return merged;
}
