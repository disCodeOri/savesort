import { Buffer } from "node:buffer";

import { parseGitHubRepositoryUrl } from "@/lib/sources/detect-source";

const GITHUB_API = "https://api.github.com";
const MAX_README_CHARACTERS = 8_000;

interface GitHubRepositoryResponse {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  homepage: string | null;
  language: string | null;
  topics: string[];
  stargazers_count: number;
  owner: { login: string };
}

interface GitHubReadmeResponse {
  content?: string;
  encoding?: string;
}

export interface GitHubMetadata {
  title: string;
  description: string | null;
  author: string;
  content: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
}

async function githubRequest<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "SaveSort/0.1",
  };
  if (process.env.GITHUB_TOKEN)
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const response = await fetch(`${GITHUB_API}${path}`, {
    headers,
    signal: AbortSignal.timeout(6_000),
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
  return (await response.json()) as T;
}

export async function enrichGitHubRepository(
  url: string,
): Promise<GitHubMetadata> {
  const repository = parseGitHubRepositoryUrl(url);
  if (!repository) throw new Error("That GitHub URL is not a repository.");

  const path = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}`;
  const repo = await githubRequest<GitHubRepositoryResponse>(path);
  let readme: string | null = null;

  try {
    const response = await githubRequest<GitHubReadmeResponse>(
      `${path}/readme`,
    );
    if (response.encoding === "base64" && response.content) {
      readme = Buffer.from(response.content.replace(/\s/g, ""), "base64")
        .toString("utf8")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_README_CHARACTERS);
    }
  } catch {
    // A missing README should not discard otherwise useful repository metadata.
  }

  return {
    title: repo.full_name,
    description: repo.description,
    author: repo.owner.login,
    content: readme,
    tags: [
      ...new Set(
        [...(repo.topics ?? []), repo.language].filter(Boolean) as string[],
      ),
    ],
    metadata: {
      repositoryName: repo.name,
      fullName: repo.full_name,
      language: repo.language,
      homepage: repo.homepage,
      stars: repo.stargazers_count,
      repositoryUrl: repo.html_url,
    },
  };
}
