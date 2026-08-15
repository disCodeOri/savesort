# GitHub Account Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect GitHub independently from SaveSort authentication, import all starred repositories after connection and each SaveSort login, and provide a manual Library sync control.

**Architecture:** A least-privilege GitHub App authorizes the current Supabase user through OAuth state and PKCE. Server-only modules encrypt GitHub credentials, page through starred repositories, idempotently merge provider metadata into RLS-protected saved items, and generate Gemini embeddings in bounded groups; a protected client runner coordinates one GitHub page per request without a queue.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 6, Supabase Auth/Postgres/RLS, GitHub REST API `2026-03-10`, Node AES-256-GCM, Gemini embeddings at 768 dimensions, Zod 4, Vitest 4 and Testing Library.

## Global Constraints

- GitHub is a separate connection, not a SaveSort login identity.
- Synchronize immediately after connection and once after each successful new SaveSort sign-in; do not synchronize on page refreshes or ordinary navigation.
- Provide a manual **Sync now** button in the Library.
- Request only GitHub App `Starring: read` user permission.
- Never expose a GitHub token, GitHub client secret, token-encryption key, Supabase secret key, or Gemini key to the browser.
- Use 768-dimension Gemini embeddings; preserve keyword-only search when embedding fails.
- Preserve notes, user-added tags, and existing rich content during provider refreshes.
- Never delete a SaveSort item because it was unstarred on GitHub.
- Do not add queues, workers, cron jobs, webhooks, microservices, or restricted-platform scraping.
- RLS is mandatory for both new tables. Any owner update policy must contain both `USING` and `WITH CHECK`.
- Preserve the user's unrelated `next-env.d.ts` and `UI-design-inspirations.md` changes.

---

### Task 1: Add the GitHub connection schema and atomic sync claim

**Files:**

- Create: `supabase/migrations/20260815XXXXXX_create_github_connections.sql` using the next timestamp from `npx supabase migration new create_github_connections`
- Create: `supabase/tests/github_connections_verification.sql`

**Interfaces:**

- Produces: `public.github_connections`, `public.github_connection_secrets`, and `public.begin_github_sync(uuid, uuid): boolean`.
- Consumers: Tasks 5-7 access these objects through the server-only Supabase client.

- [ ] **Step 1: Write the SQL verification script first**

Create `supabase/tests/github_connections_verification.sql` with transaction-scoped assertions that fail until the migration exists:

```sql
begin;

do $$
begin
  if to_regclass('public.github_connections') is null then
    raise exception 'github_connections is missing';
  end if;
  if to_regclass('public.github_connection_secrets') is null then
    raise exception 'github_connection_secrets is missing';
  end if;
  if to_regprocedure('public.begin_github_sync(uuid,uuid)') is null then
    raise exception 'begin_github_sync(uuid, uuid) is missing';
  end if;
end;
$$;

select relname, relrowsecurity
from pg_class
where relname in ('github_connections', 'github_connection_secrets');

select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'github_connection_secrets'
  and grantee in ('anon', 'authenticated');

rollback;
```

- [ ] **Step 2: Generate the migration and confirm the verifier fails before applying it**

```bash
npx supabase migration new create_github_connections
npx supabase db lint
```

Expected: the verification query would raise `github_connections is missing` against a database without the new migration.

- [ ] **Step 3: Implement the additive schema**

Put this schema in the generated migration, retaining the generated timestamped filename:

```sql
create table public.github_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  github_user_id bigint not null,
  github_login text not null,
  github_avatar_url text,
  connection_status text not null default 'connected'
    check (connection_status in ('connected', 'reconnect_required')),
  sync_status text not null default 'idle'
    check (sync_status in ('idle', 'running', 'failed')),
  active_sync_id uuid,
  next_page integer not null default 1 check (next_page > 0),
  discovered_count integer not null default 0 check (discovered_count >= 0),
  saved_count integer not null default 0 check (saved_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  sync_started_at timestamptz,
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (github_user_id)
);

create table public.github_connection_secrets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.github_connections enable row level security;
alter table public.github_connection_secrets enable row level security;

create policy "Users can read their GitHub connection"
on public.github_connections for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can update their GitHub connection metadata"
on public.github_connections for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

grant select, update on public.github_connections to authenticated;
revoke all on public.github_connection_secrets from anon, authenticated;

create or replace function public.begin_github_sync(
  p_user_id uuid,
  p_sync_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_count integer;
begin
  update public.github_connections
  set sync_status = 'running',
      active_sync_id = p_sync_id,
      next_page = 1,
      discovered_count = 0,
      saved_count = 0,
      skipped_count = 0,
      sync_started_at = now(),
      last_sync_error = null,
      updated_at = now()
  where user_id = p_user_id
    and connection_status = 'connected'
    and (
      sync_status <> 'running'
      or sync_started_at < now() - interval '10 minutes'
    );
  get diagnostics changed_count = row_count;
  return changed_count = 1;
end;
$$;

revoke all on function public.begin_github_sync(uuid, uuid) from public, anon, authenticated;
grant execute on function public.begin_github_sync(uuid, uuid) to service_role;
```

Add `updated_at` triggers for both tables by reusing the existing `public.set_saved_items_updated_at()` trigger function.

- [ ] **Step 4: Apply and verify the migration**

First inspect the generated SQL, then run:

```bash
npx supabase db push
npx supabase db lint
```

Run `supabase/tests/github_connections_verification.sql` through the connected Supabase SQL runner. Expected: both tables report `relrowsecurity = true`, the RPC exists, and the secrets grant query returns zero rows.

- [ ] **Step 5: Commit the schema boundary**

```bash
git add supabase/migrations supabase/tests/github_connections_verification.sql
git commit -m "feat: add secure GitHub connection schema"
```

### Task 2: Add server configuration, admin client, OAuth PKCE, and token encryption

**Files:**

- Modify: `src/lib/env.ts`
- Modify: `.env.example`
- Create: `src/lib/supabase/admin.ts`
- Create: `src/lib/github/crypto.ts`
- Create: `tests/github-crypto.test.ts`

**Interfaces:**

- Produces: `getGitHubServerConfig()`, `createAdminClient()`, `createOAuthAttempt()`, `encryptSecret(value)`, and `decryptSecret(value)`.
- `createOAuthAttempt(): { state: string; verifier: string; challenge: string }`
- Encrypted format: `v1.<base64url iv>.<base64url tag>.<base64url ciphertext>`.

- [ ] **Step 1: Write failing crypto and configuration tests**

Create `tests/github-crypto.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createOAuthAttempt,
  decryptSecret,
  encryptSecret,
} from "@/lib/github/crypto";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

describe("GitHub secret protection", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN_ENCRYPTION_KEY = encryptionKey;
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN_ENCRYPTION_KEY;
  });

  it("round-trips a token without storing plaintext", () => {
    const encrypted = encryptSecret("ghu_test_token");
    expect(encrypted).not.toContain("ghu_test_token");
    expect(decryptSecret(encrypted)).toBe("ghu_test_token");
  });

  it("rejects tampered ciphertext", () => {
    const encrypted = encryptSecret("ghu_test_token");
    expect(() => decryptSecret(`${encrypted}x`)).toThrow(
      "GitHub credential could not be decrypted.",
    );
  });

  it("creates URL-safe state, verifier, and matching S256 challenge", () => {
    const attempt = createOAuthAttempt();
    expect(attempt.state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(attempt.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(attempt.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm missing-module failure**

```bash
npm test -- tests/github-crypto.test.ts
```

Expected: FAIL because `src/lib/github/crypto.ts` does not exist.

- [ ] **Step 3: Implement strict server configuration and the admin client**

Add this return shape in `src/lib/env.ts`:

```ts
export interface GitHubServerConfig {
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  supabaseSecretKey: string;
}

export function getGitHubServerConfig(): GitHubServerConfig {
  const config = {
    clientId: process.env.GITHUB_APP_CLIENT_ID,
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
    encryptionKey: process.env.GITHUB_TOKEN_ENCRYPTION_KEY,
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY,
  };
  if (Object.values(config).some((value) => !value)) {
    throw new Error("GitHub connection is not configured.");
  }
  return config as GitHubServerConfig;
}
```

Create `src/lib/supabase/admin.ts` with `import "server-only"` and a server-only client:

```ts
import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getGitHubServerConfig, getSupabasePublicConfig } from "@/lib/env";

export function createAdminClient() {
  const { url } = getSupabasePublicConfig();
  const { supabaseSecretKey } = getGitHubServerConfig();
  return createClient(url, supabaseSecretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
```

- [ ] **Step 4: Implement OAuth randomness and AES-256-GCM**

In `src/lib/github/crypto.ts`, use `randomBytes(32)` for state and verifier entropy, SHA-256 for the PKCE challenge, and `createCipheriv("aes-256-gcm", key, randomBytes(12))` for encryption. Decode `GITHUB_TOKEN_ENCRYPTION_KEY` from base64 and reject any decoded key not exactly 32 bytes with `GitHub token encryption is not configured correctly.`. Catch authentication/decode failures in `decryptSecret` and replace them with `GitHub credential could not be decrypted.`.

- [ ] **Step 5: Run the focused test and checks**

```bash
npm test -- tests/github-crypto.test.ts
npm run typecheck
npm run lint
```

Expected: all commands succeed.

- [ ] **Step 6: Document variable names without values and commit**

Add these empty entries to `.env.example`:

```dotenv
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_TOKEN_ENCRYPTION_KEY=
SUPABASE_SECRET_KEY=
```

Then commit:

```bash
git add .env.example src/lib/env.ts src/lib/supabase/admin.ts src/lib/github/crypto.ts tests/github-crypto.test.ts
git commit -m "feat: protect GitHub connection credentials"
```

### Task 3: Build the bounded GitHub REST client

**Files:**

- Create: `src/lib/github/types.ts`
- Create: `src/lib/github/api.ts`
- Create: `tests/github-api.test.ts`

**Interfaces:**

- Produces: `exchangeOAuthCode(code, verifier, redirectUri)`, `refreshOAuthToken(refreshToken)`, `getAuthenticatedGitHubUser(accessToken)`, and `listStarredRepositoriesPage(accessToken, page)`.
- `listStarredRepositoriesPage` returns `{ repositories: GitHubStarredRepository[]; nextPage: number | null }`.
- Throws `GitHubApiError` with `kind: "unauthorized" | "rate_limited" | "provider_error"` and a safe message.

- [ ] **Step 1: Define provider types and write failing fetch tests**

Define only the fields SaveSort consumes in `src/lib/github/types.ts`: token fields (`access_token`, optional `refresh_token`, `expires_in`, `refresh_token_expires_in`), user fields (`id`, `login`, `avatar_url`), and starred repository fields (`starred_at`, nested `repo.id`, `name`, `full_name`, `html_url`, `description`, `homepage`, `language`, `topics`, `stargazers_count`, `forks_count`, `archived`, `visibility`, `owner.login`, and optional license SPDX ID).

In `tests/github-api.test.ts`, mock `global.fetch` and assert:

```ts
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
```

Also test that a short page produces `nextPage: null`, `401` maps to `unauthorized`, and `403` with `x-ratelimit-remaining: 0` maps to `rate_limited`.

- [ ] **Step 2: Run the focused test and confirm missing implementation failures**

```bash
npm test -- tests/github-api.test.ts
```

Expected: FAIL because the API module and exports are missing.

- [ ] **Step 3: Implement one private request boundary**

In `src/lib/github/api.ts`, add `import "server-only"`, a six-second timeout, `User-Agent: SaveSort/0.1`, JSON validation, and bounded error messages. The token exchange posts form data to `https://github.com/login/oauth/access_token`; refresh posts `grant_type=refresh_token`; user lookup calls `/user`; star listing calls `/user/starred?per_page=100&page=<n>`.

Never include the access token, authorization code, response body, or client secret in a thrown message. Determine `nextPage` only from `repositories.length === 100`.

- [ ] **Step 4: Run focused tests and static checks**

```bash
npm test -- tests/github-api.test.ts
npm run typecheck
npm run lint
```

Expected: all commands succeed.

- [ ] **Step 5: Commit the provider boundary**

```bash
git add src/lib/github/types.ts src/lib/github/api.ts tests/github-api.test.ts
git commit -m "feat: add GitHub stars API client"
```

### Task 4: Map GitHub stars without overwriting user-owned data

**Files:**

- Create: `src/lib/github/map-star.ts`
- Create: `tests/github-map-star.test.ts`

**Interfaces:**

- Produces: `mapGitHubStar(repository): GitHubProviderItem` and `mergeGitHubProviderItem(existing, provider): GitHubMergedItem`.
- `GitHubMergedItem` matches saved-item write columns except `embedding`, `indexing_status`, and `indexing_error`.

- [ ] **Step 1: Write failing mapping and merge tests**

Cover a new repository and an existing manually enriched repository. The preservation assertion must be explicit:

```ts
it("preserves notes, rich content, and user tags while refreshing provider tags", () => {
  const provider = mapGitHubStar(
    starredRepository({
      topics: ["search"],
      language: "TypeScript",
    }),
  );
  const merged = mergeGitHubProviderItem(
    {
      url: "https://github.com/acme/find-it",
      normalized_url: "https://github.com/acme/find-it",
      title: "old title",
      description: "old description",
      notes: "Use this for the parser",
      content: "Existing README excerpt",
      author: "acme",
      thumbnail_url: null,
      tags: ["old-provider-topic", "personal"],
      metadata: { github: { providerTags: ["old-provider-topic"] } },
    },
    provider,
  );

  expect(merged.notes).toBe("Use this for the parser");
  expect(merged.content).toBe("Existing README excerpt");
  expect(merged.tags).toEqual(["personal", "search", "TypeScript"]);
  expect(merged.metadata.github.providerTags).toEqual(["search", "TypeScript"]);
});
```

Also assert normalized canonical GitHub URL, `source: "github"`, owner, counts, visibility, license, `starredAt`, and archived state.

- [ ] **Step 2: Run the focused test and verify missing-module failure**

```bash
npm test -- tests/github-map-star.test.ts
```

- [ ] **Step 3: Implement deterministic provider mapping and merge rules**

Use `normalizeUrl(repo.html_url)`. Provider tags are a stable, de-duplicated list of topics plus non-null language. Remove only the previous `metadata.github.providerTags` values from existing tags, retain the rest as user tags, then append current provider tags. Preserve existing `notes`, `content`, and `thumbnail_url`; refresh URL, normalized URL, title, description, author, and the nested `metadata.github` object. Rebuild `searchable_text` with the existing `buildSearchableText()`.

- [ ] **Step 4: Run focused tests and static checks**

```bash
npm test -- tests/github-map-star.test.ts tests/searchable-text.test.ts tests/urls.test.ts
npm run typecheck
npm run lint
```

- [ ] **Step 5: Commit the merge policy**

```bash
git add src/lib/github/map-star.ts tests/github-map-star.test.ts
git commit -m "feat: map GitHub stars into saved items"
```

### Task 5: Persist, read, refresh, and disconnect GitHub connections server-side

**Files:**

- Create: `src/lib/github/connections.ts`
- Create: `tests/github-connections.test.ts`

**Interfaces:**

- Produces: `saveGitHubConnection(userId, user, token)`, `getGitHubConnection(userId)`, `getValidGitHubAccessToken(userId)`, `markGitHubReconnectRequired(userId)`, and `disconnectGitHub(userId)`.
- Public status never contains ciphertext or token fields.

- [ ] **Step 1: Write failing connection-service tests with a mocked admin client**

Test that `saveGitHubConnection` encrypts both tokens before upsert, `getGitHubConnection` selects only safe metadata columns, `getValidGitHubAccessToken` refreshes a token expiring within 60 seconds and persists rotated encrypted values, and `disconnectGitHub` deletes the secret row before the metadata row.

Use an assertion shaped like:

```ts
expect(publicStatus).toEqual({
  connected: true,
  githubLogin: "octocat",
  githubAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  connectionStatus: "connected",
  syncStatus: "idle",
  lastSyncedAt: null,
  discoveredCount: 0,
  savedCount: 0,
  skippedCount: 0,
  lastSyncError: null,
});
expect(JSON.stringify(publicStatus)).not.toMatch(/token|ciphertext/i);
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

```bash
npm test -- tests/github-connections.test.ts
```

- [ ] **Step 3: Implement the server-only repository**

Add `import "server-only"`. Every admin query must include `.eq("user_id", userId)`. Convert token lifetimes to absolute ISO timestamps when saving. On refresh, decrypt the refresh token, call `refreshOAuthToken`, re-encrypt rotated values, and never return a refresh token to callers. Convert provider `401` or an expired refresh token into `markGitHubReconnectRequired()` and the safe error `GitHub needs to be reconnected.`.

Map database errors to `GitHub connection could not be saved.` or `GitHub connection could not be loaded.`; do not forward Supabase messages to the client.

- [ ] **Step 4: Run focused tests and static checks**

```bash
npm test -- tests/github-connections.test.ts tests/github-crypto.test.ts tests/github-api.test.ts
npm run typecheck
npm run lint
```

- [ ] **Step 5: Commit the credential repository**

```bash
git add src/lib/github/connections.ts tests/github-connections.test.ts
git commit -m "feat: manage connected GitHub credentials"
```

### Task 6: Add protected GitHub connect, callback, status, and disconnect routes

**Files:**

- Create: `src/lib/github/oauth-cookies.ts`
- Create: `src/app/api/github/connect/route.ts`
- Create: `src/app/api/github/callback/route.ts`
- Create: `src/app/api/github/connection/route.ts`
- Create: `tests/github-oauth-routes.test.ts`

**Interfaces:**

- `GET /api/github/connect` redirects to GitHub and sets `savesort_github_state` plus `savesort_github_pkce` HttpOnly cookies for 10 minutes.
- `GET /api/github/callback?code=...&state=...` validates the attempt, saves the connection, clears attempt cookies, and redirects to `/library?githubSync=connect`.
- `GET /api/github/connection` returns safe connection metadata.
- `DELETE /api/github/connection` removes the connection and returns `{ disconnected: true }`.

- [ ] **Step 1: Write failing Route Handler tests**

Mock `requireUser`, provider calls, and connection persistence. Assert the connect redirect contains exactly `client_id`, `redirect_uri`, `state`, `code_challenge`, and `code_challenge_method=S256`, with no GitHub secret. Assert both cookies are `httpOnly`, `sameSite: "lax"`, `path: "/"`, and `maxAge: 600`.

Test callback rejection for missing/mismatched state:

```ts
const response = await callbackGet(
  new NextRequest(
    "http://localhost:3000/api/github/callback?code=code-1&state=wrong",
    { headers: { cookie: "savesort_github_state=expected" } },
  ),
);
expect(response.status).toBe(307);
expect(response.headers.get("location")).toContain(
  "/library?githubError=authorization_failed",
);
expect(exchangeOAuthCodeMock).not.toHaveBeenCalled();
```

Also assert unauthenticated routes return/redirect with 401-safe behavior, callback identity is revalidated through `/user`, and status JSON contains no credential fields.

- [ ] **Step 2: Run tests and confirm route modules are missing**

```bash
npm test -- tests/github-oauth-routes.test.ts
```

- [ ] **Step 3: Implement OAuth attempt cookies and connect route**

Use `cookies()` asynchronously. Derive the callback from `new URL("/api/github/callback", request.url)`. Build the authorize URL `https://github.com/login/oauth/authorize` without a `scope` parameter because the GitHub App's `Starring: read` permission is configured on GitHub. Set `secure: process.env.NODE_ENV === "production"`.

- [ ] **Step 4: Implement callback, safe status, and disconnect routes**

Validate `code` and `state` with Zod, compare state using `timingSafeEqual`, require both attempt cookies, exchange with the exact callback URL and verifier, call `getAuthenticatedGitHubUser`, then call `saveGitHubConnection`. Clear both cookies on every callback outcome. Return only `apiError` messages from `src/lib/http/responses.ts` for JSON routes.

Do not log query parameters; the callback URL contains a temporary authorization code.

- [ ] **Step 5: Run focused tests and static checks**

```bash
npm test -- tests/github-oauth-routes.test.ts tests/github-connections.test.ts
npm run typecheck
npm run lint
```

- [ ] **Step 6: Commit the connection flow**

```bash
git add src/lib/github/oauth-cookies.ts src/app/api/github tests/github-oauth-routes.test.ts
git commit -m "feat: connect GitHub accounts"
```

### Task 7: Implement one-page-at-a-time, idempotent star synchronization

**Files:**

- Create: `src/lib/github/concurrency.ts`
- Create: `src/lib/github/sync.ts`
- Create: `src/app/api/github/sync/route.ts`
- Create: `tests/github-sync.test.ts`
- Create: `tests/github-sync-route.test.ts`

**Interfaces:**

- `startGitHubSync(userId): Promise<GitHubSyncProgress>`
- `continueGitHubSync(userId, syncId): Promise<GitHubSyncProgress>`
- `GitHubSyncProgress.status` is `"running" | "complete" | "not_connected" | "reconnect_required" | "failed"`.
- Running progress contains `syncId`, `nextPage`, `discoveredCount`, `savedCount`, and `skippedCount`; completed progress omits the cursor.
- `POST /api/github/sync` accepts `{ action: "start" }` or `{ action: "continue", syncId: z.uuid() }`.

- [ ] **Step 1: Write failing concurrency and sync-service tests**

Test a 100-item first page followed by a short second page, an already-running sync, stale-lock recovery, duplicate rerun, preservation of existing notes/content/user tags, keyword-only fallback, one malformed item being skipped, rate-limit failure, and unauthorized token becoming `reconnect_required`.

The idempotency assertion must compare counts after two complete runs:

```ts
expect(firstRun.savedCount).toBe(2);
expect(secondRun.savedCount).toBe(0);
expect(savedRows).toHaveLength(2);
expect(savedRows[0].notes).toBe("keep my note");
```

Test `mapWithConcurrency(values, 4, worker)` by tracking active promises and asserting the peak never exceeds four.

- [ ] **Step 2: Run focused tests and verify missing-module failures**

```bash
npm test -- tests/github-sync.test.ts
```

- [ ] **Step 3: Implement bounded concurrency**

`mapWithConcurrency<T, R>(values: T[], limit: number, worker: (value: T) => Promise<R>): Promise<R[]>` must reject limits below one, preserve result order, and start no more than `limit` workers. Do not use an unbounded `Promise.all(values.map(...))`.

- [ ] **Step 4: Implement sync start and continuation**

`startGitHubSync` generates `crypto.randomUUID()`, invokes `begin_github_sync` through the admin client, and either returns active progress or immediately calls the one-page processor.

The page processor must:

1. Load the connection row by `user_id` and verify `active_sync_id`.
2. Obtain a valid access token and fetch exactly `next_page`.
3. Map repository URLs and load matching existing `saved_items` for the same user.
4. Use `mapWithConcurrency(..., 4, ...)` to rebuild searchable text and call `embedDocument` only for new or searchable-changed rows.
5. Upsert complete rows on `user_id,normalized_url`, always setting the explicit `user_id`.
6. Preserve existing embedding/status when searchable text is unchanged.
7. Use `keyword_only` plus a short safe indexing error when Gemini fails.
8. Update connection counters only when `.eq("active_sync_id", syncId)` still matches.
9. Set `next_page` for a full page; otherwise set `sync_status = "idle"`, clear the active ID, and set `last_synced_at = now()`.

Never delete saved rows absent from the provider response. Never fetch a README during bulk sync.

- [ ] **Step 5: Write and run the failing authenticated route tests**

In `tests/github-sync-route.test.ts`, mock `requireUser`, `startGitHubSync`, and `continueGitHubSync`. Assert 401 for no user, 400 for an invalid body/UUID, 200 for running/complete progress, and that the JSON response has no field matching `/token|ciphertext|secret/i`.

```bash
npm test -- tests/github-sync-route.test.ts
```

- [ ] **Step 6: Implement the Zod-validated Route Handler**

Use a discriminated union:

```ts
const syncRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("continue"), syncId: z.uuid() }),
]);
```

Require the user before calling either service function. Convert known safe sync errors to 409, 429, or 503; send unknown failures through `unknownApiError`.

- [ ] **Step 7: Run the GitHub service suite and commit**

```bash
npm test -- tests/github-sync.test.ts tests/github-sync-route.test.ts tests/github-map-star.test.ts
npm run typecheck
npm run lint
git add src/lib/github/concurrency.ts src/lib/github/sync.ts src/app/api/github/sync/route.ts tests/github-sync.test.ts tests/github-sync-route.test.ts
git commit -m "feat: synchronize GitHub starred repositories"
```

### Task 8: Add the reusable browser sync runner and login trigger

**Files:**

- Create: `src/lib/github/sync-client.ts`
- Create: `src/components/github-auto-sync.tsx`
- Modify: `src/components/app-shell.tsx`
- Modify: `src/app/auth/actions.ts`
- Create: `tests/github-sync-client.test.ts`
- Create: `tests/github-auto-sync.test.tsx`

**Interfaces:**

- `runGitHubSync(onProgress, fetchImpl = fetch): Promise<GitHubSyncProgress>` loops from start through completion.
- `<GitHubAutoSync />` consumes `githubSync=login|connect` once and emits `savesort:changed` after completion.

- [ ] **Step 1: Write failing client-runner tests**

Mock two fetch responses: running with `syncId`, then complete. Assert the first body is `{ action: "start" }`, the second is `{ action: "continue", syncId }`, and progress is reported for both. Add a failure response whose JSON `{ error: "GitHub is rate limited. Try again later." }` becomes an `Error` with exactly that safe message.

- [ ] **Step 2: Write the failing one-time trigger test**

Render `<GitHubAutoSync />` with `window.history.replaceState({}, "", "/search?githubSync=login")`. Assert `runGitHubSync` is called once across a rerender, the final URL is `/search`, and a `savesort:changed` event fires after completion. Assert `/search` without the query parameter does not sync.

- [ ] **Step 3: Run the focused tests and confirm missing implementations**

```bash
npm test -- tests/github-sync-client.test.ts tests/github-auto-sync.test.tsx
```

- [ ] **Step 4: Implement the bounded client loop and trigger**

`runGitHubSync` posts JSON with `content-type: application/json`, stops at `complete`, `not_connected`, `reconnect_required`, or `failed`, and rejects after 1000 continuation responses with `GitHub sync did not finish.` to prevent an infinite loop.

`GitHubAutoSync` reads `window.location.search` inside `useEffect`, removes only the `githubSync` parameter with `history.replaceState`, and guards with `useRef(false)`. It renders a small `aria-live="polite"` status while running and a dismissible safe error if the automatic sync fails.

- [ ] **Step 5: Mount the trigger and mark successful password logins**

Render `<GitHubAutoSync />` once inside `AppShell`, above `page-canvas`. Change only the successful password sign-in redirect in `src/app/auth/actions.ts`:

```ts
redirect("/search?githubSync=login");
```

Do not add the marker to page refreshes, signup confirmation callbacks, or the protected layout.

- [ ] **Step 6: Run focused tests and commit**

```bash
npm test -- tests/github-sync-client.test.ts tests/github-auto-sync.test.tsx
npm run typecheck
npm run lint
git add src/lib/github/sync-client.ts src/components/github-auto-sync.tsx src/components/app-shell.tsx src/app/auth/actions.ts tests/github-sync-client.test.ts tests/github-auto-sync.test.tsx
git commit -m "feat: sync GitHub stars after login"
```

### Task 9: Add the Library connection panel and manual sync button

**Files:**

- Create: `src/components/github-connection-panel.tsx`
- Modify: `src/components/library-client.tsx`
- Modify: `src/app/globals.css`
- Create: `tests/github-connection-panel.test.tsx`

**Interfaces:**

- `<GitHubConnectionPanel onLibraryChanged(): void />` fetches `/api/github/connection`, links to `/api/github/connect`, runs manual sync, and disconnects.

- [ ] **Step 1: Write failing interaction tests**

Test these visible states with mocked fetch calls:

- disconnected: explanation plus **Connect GitHub** link;
- connected: avatar/login, last sync, and enabled **Sync now**;
- syncing: disabled button and `aria-live` progress;
- reconnect required: **Reconnect GitHub** and no token details;
- disconnect: confirmation, `DELETE /api/github/connection`, then disconnected UI;
- successful manual sync: calls `runGitHubSync`, reports `Saved 3 new repositories`, and invokes `onLibraryChanged`.

- [ ] **Step 2: Run the component test and verify the missing component failure**

```bash
npm test -- tests/github-connection-panel.test.tsx
```

- [ ] **Step 3: Implement the editorial connection panel**

Use existing button, notice, spacing, and typography tokens. Keep the panel visually secondary to the Library title and filters. Copy:

- Disconnected: `Connect GitHub to keep your starred repositories searchable.`
- Connected helper: `Stars sync after login. You can also sync them now.`
- Manual button: `Sync now`
- Reconnect: `GitHub access expired. Reconnect to resume syncing.`
- Disconnect confirmation: `Disconnect GitHub? Your saved repositories will stay in SaveSort.`

Do not use `dangerouslySetInnerHTML`; avatar URLs are rendered through a normal image with bounded dimensions and alt text.

- [ ] **Step 4: Mount it in the Library and refresh items after sync**

Render the panel between `page-title-row` and `SourceFilters`. Pass `onLibraryChanged={() => setRevision((value) => value + 1)}`. Existing list loading and filter behavior must remain unchanged.

- [ ] **Step 5: Add responsive styles and run tests**

Add focused `.github-connection-*` classes with the existing cream/ink border and button vocabulary. At the existing mobile breakpoint, stack status and actions and make action buttons full-width.

```bash
npm test -- tests/github-connection-panel.test.tsx tests/github-sync-client.test.ts
npm run typecheck
npm run lint
```

- [ ] **Step 6: Commit the manual control**

```bash
git add src/components/github-connection-panel.tsx src/components/library-client.tsx src/app/globals.css tests/github-connection-panel.test.tsx
git commit -m "feat: add GitHub sync controls"
```

### Task 10: Document GitHub App setup and verify the complete feature

**Files:**

- Modify: `README.md`
- Modify: `package.json`
- Modify only for evidence-backed failures: files introduced in Tasks 1-9
- Do not commit: `.env.local`, OAuth tokens, screenshots, or temporary logs

**Interfaces:**

- Produces: reproducible local configuration and verified end-to-end behavior.

- [ ] **Step 1: Document exact GitHub App configuration**

Add a README section that tells a developer to:

1. Create a GitHub App owned by their account.
2. Set the homepage to the SaveSort origin.
3. Set the user authorization callback to `<origin>/api/github/callback`.
4. Set **Account permissions -> Starring** to **Read-only** and leave repository write permissions disabled.
5. Copy the client ID and client secret to `.env.local`.
6. Generate the encryption key with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and store it only as `GITHUB_TOKEN_ENCRYPTION_KEY`.
7. Add the server-only Supabase secret key as `SUPABASE_SECRET_KEY`.
8. Restart Next.js after changing environment variables.

State explicitly that `.env.local` must not be committed and that revoking the GitHub App causes SaveSort to request reconnection without affecting SaveSort login.

- [ ] **Step 2: Include all current docs in formatting commands**

Change `package.json` formatter inputs from individual design/plan filenames to directory inputs so this plan and future docs are checked:

```json
"format": "prettier --write src tests supabase docs package.json tsconfig.json next.config.ts postcss.config.mjs eslint.config.mjs vitest.config.ts README.md AGENTS.md",
"format:check": "prettier --check src tests supabase docs package.json tsconfig.json next.config.ts postcss.config.mjs eslint.config.mjs vitest.config.ts README.md AGENTS.md"
```

- [ ] **Step 3: Run the complete deterministic suite**

```bash
npm run format
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: every command succeeds. Inspect `git status --short` afterward and ensure formatting did not modify the unrelated user files.

- [ ] **Step 4: Verify connection and initial sync manually**

With one known development server and an authenticated test account:

1. Open `/library`; confirm the disconnected panel contains no secret values.
2. Click **Connect GitHub**, authorize the configured GitHub App, and confirm the callback returns to `/library?githubSync=connect`.
3. Confirm the query marker disappears and progress advances to complete.
4. Verify the Library contains all starred repositories without duplicate normalized URLs.
5. Confirm search finds a newly imported repository by name, topic, language, and a vague semantic description.

- [ ] **Step 5: Verify login, manual sync, and failure semantics**

1. Star one additional repository on GitHub.
2. Sign out of SaveSort, sign back in, and confirm exactly one sync begins and the new repository appears.
3. Refresh `/search`; confirm another sync does not begin.
4. Star another repository, press **Sync now**, and confirm it appears.
5. Unstar an imported repository, sync again, and confirm its SaveSort item remains.
6. Revoke the GitHub App authorization, sync, and confirm the panel requests reconnection while SaveSort stays logged in.
7. Temporarily use an invalid Gemini key, sync a new star, and confirm the item remains keyword searchable with `keyword_only` status.

- [ ] **Step 6: Audit credential and ownership boundaries**

Search before completion:

```bash
rg -n "GITHUB_APP_CLIENT_SECRET|GITHUB_TOKEN_ENCRYPTION_KEY|SUPABASE_SECRET_KEY|access_token|refresh_token" src tests
rg -n "github_connection_secrets" supabase/migrations src
```

Expected: secret names appear only in server-only environment/configuration code and tests; tokens never appear in Client Components or API JSON; the secrets table has RLS, revoked browser grants, and server-only access; every saved-item write includes the authenticated `user_id`.

- [ ] **Step 7: Commit documentation and any verified repair**

```bash
git add README.md package.json package-lock.json
git commit -m "docs: explain GitHub account sync setup"
```

If verification required production fixes, commit each fix with its regression test before the docs commit rather than hiding it in the documentation change.

## Plan self-review

- Spec coverage: separate connection, least privilege, PKCE/state, encrypted server-only tokens, token refresh, safe status, connect/disconnect, one-page continuation, lock recovery, login trigger, manual sync, no unstar deletion, merge preservation, Gemini fallback, error states, documentation, and complete verification each map to a task.
- Placeholder scan: every implementation and failure-handling step is concrete.
- Type consistency: `GitHubSyncProgress`, `startGitHubSync`, `continueGitHubSync`, `runGitHubSync`, and the `start`/`continue` request shapes retain the same names across service, route, client, and UI tasks.
- Scope check: no queue, worker, cron, webhook, social login, or additional importer was introduced.
