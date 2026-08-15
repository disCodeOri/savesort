export interface GitHubOAuthToken {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  refresh_token_expires_in?: number;
}

export interface GitHubAuthenticatedUser {
  id: number;
  login: string;
  avatar_url: string;
}

export interface GitHubStarredRepository {
  starred_at: string;
  repo: {
    id: number;
    name: string;
    full_name: string;
    html_url: string;
    description: string | null;
    homepage: string | null;
    language: string | null;
    topics: string[];
    stargazers_count: number;
    forks_count: number;
    archived: boolean;
    visibility: string;
    owner: { login: string };
    license?: { spdx_id?: string | null } | null;
  };
}
