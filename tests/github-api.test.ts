import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  GitHubApiError,
  exchangeOAuthCode,
  getAuthenticatedGitHubUser,
  listStarredRepositoriesPage,
  refreshOAuthToken,
} from "@/lib/github/api";

const fetchMock = vi.fn<typeof fetch>();

function star(id: number) {
  return {
    starred_at: "2026-08-15T00:00:00Z",
    repo: {
      id,
      name: `repo-${id}`,
      full_name: `owner/repo-${id}`,
      html_url: `https://github.com/owner/repo-${id}`,
      description: null,
      homepage: null,
      language: "TypeScript",
      topics: ["example"],
      stargazers_count: 1,
      forks_count: 2,
      archived: false,
      visibility: "public",
      owner: { login: "owner" },
      license: { spdx_id: "MIT" },
    },
  };
}

describe("GitHub API client", () => {
  beforeEach(() => {
    process.env.GITHUB_APP_CLIENT_ID = "client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "client-secret";
    process.env.GITHUB_TOKEN_ENCRYPTION_KEY = "unused";
    process.env.SUPABASE_SECRET_KEY = "unused";
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    delete process.env.GITHUB_APP_CLIENT_ID;
    delete process.env.GITHUB_APP_CLIENT_SECRET;
    delete process.env.GITHUB_TOKEN_ENCRYPTION_KEY;
    delete process.env.SUPABASE_SECRET_KEY;
  });

  it("requests one 100-item starred page with the authenticated token", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(Array.from({ length: 100 }, (_, id) => star(id))),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const result = await listStarredRepositoriesPage("ghu_token", 2);

    expect(result.nextPage).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user/starred?per_page=100&page=2",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ghu_token",
          Accept: "application/vnd.github.star+json",
          "X-GitHub-Api-Version": "2026-03-10",
        }),
      }),
    );
  });

  it("stops after a short starred page", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([star(1)]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(listStarredRepositoriesPage("ghu_token", 1)).resolves.toEqual({
      repositories: [star(1)],
      nextPage: null,
    });
  });

  it("maps a 401 response to an unauthorized error", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    await expect(
      listStarredRepositoriesPage("ghu_token", 1),
    ).rejects.toMatchObject({
      kind: "unauthorized",
    } satisfies Partial<GitHubApiError>);
  });

  it("maps an exhausted 403 response to a rate-limited error", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
    );

    await expect(
      listStarredRepositoriesPage("ghu_token", 1),
    ).rejects.toMatchObject({
      kind: "rate_limited",
    } satisfies Partial<GitHubApiError>);
  });

  it("exchanges an OAuth code with PKCE form data", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "ghu_access",
          refresh_token: "ghr_refresh",
          expires_in: 28_800,
          refresh_token_expires_in: 15_552_000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      exchangeOAuthCode(
        "code-value",
        "verifier-value",
        "https://app.test/callback",
      ),
    ).resolves.toMatchObject({ access_token: "ghu_access" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({
        method: "POST",
        body: expect.any(URLSearchParams),
        headers: expect.objectContaining({
          "Content-Type": "application/x-www-form-urlencoded",
        }),
      }),
    );
    const form = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(form.get("client_id")).toBe("client-id");
    expect(form.get("client_secret")).toBe("client-secret");
    expect(form.get("code")).toBe("code-value");
    expect(form.get("code_verifier")).toBe("verifier-value");
    expect(form.get("redirect_uri")).toBe("https://app.test/callback");
  });

  it("refreshes an OAuth token", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "ghu_new", expires_in: 28_800 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await expect(refreshOAuthToken("ghr_old")).resolves.toMatchObject({
      access_token: "ghu_new",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({
        method: "POST",
        body: expect.any(URLSearchParams),
        headers: expect.objectContaining({
          "Content-Type": "application/x-www-form-urlencoded",
        }),
      }),
    );
    const form = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(form.get("client_id")).toBe("client-id");
    expect(form.get("client_secret")).toBe("client-secret");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("ghr_old");
  });

  it("maps a missing OAuth configuration to a provider error", async () => {
    delete process.env.GITHUB_APP_CLIENT_ID;

    await expect(
      exchangeOAuthCode(
        "code-value",
        "verifier-value",
        "https://app.test/callback",
      ),
    ).rejects.toMatchObject({
      kind: "provider_error",
    } satisfies Partial<GitHubApiError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gets the authenticated GitHub user", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 42,
          login: "octocat",
          avatar_url: "https://avatar.test",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await expect(getAuthenticatedGitHubUser("ghu_token")).resolves.toEqual({
      id: 42,
      login: "octocat",
      avatar_url: "https://avatar.test",
    });
  });
});
