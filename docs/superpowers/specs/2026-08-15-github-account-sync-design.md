# GitHub Account Sync and Persistent Sessions Design

**Date:** 2026-08-15  
**Status:** Approved for implementation planning

## Goal

Let an authenticated SaveSort user connect a GitHub account independently from
their SaveSort login, import all starred repositories, automatically synchronize
stars after each successful SaveSort sign-in, and manually request a sync from
the Library. At the same time, repair the existing Supabase session-refresh path
so a valid login remains available across navigation, access-token refreshes, and
browser restarts.

The feature stays within SaveSort's ingest -> index -> retrieve scope. It does not
turn GitHub into the SaveSort identity provider, add a queue or scheduled worker,
or delete saved knowledge when a repository is unstarred.

## Chosen approach

Use a separate GitHub App connection with GitHub's web authorization flow. The
GitHub App requests the fine-grained, read-only `Starring` user permission. The
connection is associated with the current Supabase user but is not a Supabase
login identity.

This is preferred over a classic OAuth App because a GitHub App can ask for the
narrow permission SaveSort needs. A username-only importer is not sufficient:
it is not a genuine connection, is limited to public data, and has weaker API
rate limits.

The web flow uses an unpredictable `state` value and PKCE. GitHub client secrets,
access tokens, refresh tokens, and the local encryption key remain server-only.
After every token exchange or refresh, SaveSort calls GitHub's authenticated user
endpoint before accepting the identity.

## User experience

### Connecting GitHub

The Library has a GitHub connection panel with these states:

- Not connected: a **Connect GitHub** button and a short explanation that only
  starred repositories are read.
- Connecting: a disabled progress state while the browser is at GitHub.
- Connected: the GitHub avatar/login, last successful sync time, a **Sync now**
  button, and a **Disconnect** action.
- Syncing: progress text that reports repositories discovered and saved.
- Attention required: a friendly reconnect message for revoked or expired access.

The callback stores the connection and redirects to the Library with a one-time
sync trigger. The first import therefore starts immediately after connection.

### Login-triggered sync

"On login" means one sync attempt after a successful new SaveSort sign-in. It
does not mean every page request, refresh, or server render.

After `signInWithPassword` succeeds, the sign-in action redirects to the search
page with a short-lived, one-time sync indication. A client component mounted in
the protected application shell consumes that indication, removes it from the
URL, and calls the authenticated sync route if GitHub is connected. Login and the
initial page render are not blocked by a large GitHub library.

The manual **Sync now** button invokes the same idempotent pipeline. Simultaneous
attempts for one user return the existing sync status instead of starting a
second import.

The browser coordinates bounded sync requests from the protected application
shell. A start request creates a random, non-secret sync ID and resets the stored
page cursor. Each continuation request processes one GitHub page and returns
bounded counters plus either the next cursor or `complete`. A second tab receives
the active status instead of another job. This keeps large libraries away from a
single long-running server request without adding a queue or worker.

## GitHub authorization and token storage

Required server environment variables:

- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_TOKEN_ENCRYPTION_KEY`
- `SUPABASE_SECRET_KEY` for server-only access to credential rows

Only the public GitHub App client ID may be used when constructing the authorize
URL. The other values must never use a `NEXT_PUBLIC_` prefix or appear in browser
props, API responses, logs, or errors.

Tokens are encrypted with authenticated encryption using Node's AES-256-GCM. A
fresh random IV is generated for every encrypted value. The stored representation
contains a format version, IV, authentication tag, and ciphertext. Refresh tokens
are handled the same way. Decryption is only available in server-only modules.

Two tables keep safe metadata separate from credentials:

1. `public.github_connections` contains `user_id`, GitHub user ID, login, avatar
   URL, connection state, last sync timestamps, progress counters, and a short
   safe error code/message. It has RLS for `auth.uid() = user_id`, including both
   `USING` and `WITH CHECK` for updates.
2. `public.github_connection_secrets` contains encrypted access/refresh tokens
   and expiration timestamps. RLS is enabled with no `anon` or `authenticated`
   policies. Only a server-side Supabase client using `SUPABASE_SECRET_KEY` can
   access it. The key is never exposed to the browser.

Both tables use `user_id` as the primary key and cascade when the Supabase user
is deleted. Disconnect removes both rows. SaveSort may also attempt GitHub grant
revocation when supported, but local deletion must succeed even if GitHub is
unavailable.

## Sync pipeline

`POST /api/github/sync` requires the current Supabase user and a validated
start/continue request. Across its bounded requests it performs these steps:

1. Claim the user's sync lock, allowing a stale lock to be recovered after a
   bounded timeout.
2. Load and decrypt the server-only GitHub credential.
3. Refresh the GitHub token when it is near expiration, then revalidate the
   authenticated GitHub identity.
4. Request `/user/starred` in pages of 100 using the GitHub API version header
   and the starred-repository media type so `starred_at` is available.
5. Normalize each repository URL and upsert against the existing
   `(user_id, normalized_url)` uniqueness constraint.
6. Rebuild searchable text and generate a fresh 768-dimension Gemini embedding
   for each new item or item whose searchable GitHub metadata changed.
7. Persist the next page and cumulative counts, or record the final successful
   sync timestamp and release the lock when the last page is reached.

Bulk sync uses repository data already returned by the stars endpoint: full name,
owner, description, topics, primary language, license, counts, timestamps, and
visibility. It does not make a repository and README request for every star. A
manual single-URL save may continue using the richer existing enrichment path.

Embedding work uses bounded batches. If Gemini is unavailable or rate limited,
the item is still saved with keyword-searchable text and an appropriate
`indexing_status`; the whole GitHub import does not fail. A later sync or existing
retry behavior can attempt the embedding again.

The route returns bounded progress and summary data only. It never returns a
GitHub token or unbounded provider content. If the user closes the page during a
multi-request import, the next login or manual sync safely starts again because
all writes are idempotent.

## Update and deletion semantics

New GitHub stars create saved items. Existing GitHub items receive refreshed
provider-owned fields only when those fields changed. User-owned fields such as
notes and user-added tags are preserved.

Unstarring a repository on GitHub does not delete it from SaveSort. SaveSort is a
personal archive, so destructive synchronization would violate user expectations.
The GitHub repository ID and latest `starred_at` value are retained in metadata
for traceability and future incremental improvements.

Duplicate repository URLs are not created. If a repository was manually saved
before GitHub was connected, sync enriches the same record while preserving user
content.

## Session persistence repair

The existing server client already uses persistent Supabase cookies. The session
proxy is brought in line with the current Supabase SSR contract:

- Create the server client and immediately perform the session verification call
  without unrelated work between them.
- Use `auth.getClaims()` in the proxy refresh path.
- In the cookie `setAll` callback, update request cookies, recreate the forwarded
  response, set response cookies with their original options, and propagate the
  response headers supplied by `@supabase/ssr`.
- Continue using a fresh verified user lookup at data-access authorization
  boundaries where the application needs the actual user object.
- Preserve secure cookie attributes and never implement an application-managed
  browser token store.

This repairs token refresh without weakening the protected layout or Route
Handler checks. Authentication failures remain friendly redirects or bounded API
errors rather than stack traces.

## Error handling

- Invalid OAuth state or PKCE data: reject the callback and return to the Library
  with a safe retry message.
- Revoked/invalid GitHub credential: mark the connection `reconnect_required`;
  SaveSort login remains valid.
- GitHub rate limiting or temporary outage: retain existing items, report a
  retryable sync error, and preserve the last successful sync timestamp.
- Individual malformed repository: skip it, count it, and continue the page.
- Supabase write failure: fail the current page without claiming a successful
  sync; idempotency makes retry safe.
- Gemini failure: store the item as keyword-only and continue.

Logs may include user-independent error codes, request IDs, counts, and timing.
They must not include tokens, authorization codes, secrets, raw encrypted values,
or unbounded GitHub content.

## Testing and acceptance criteria

Deterministic unit tests cover OAuth state/PKCE validation, token encryption and
tamper rejection, GitHub pagination parsing, repository mapping, preservation of
user-owned fields, sync-lock decisions, and error classification.

Route/service tests cover authentication requirements, a connected sync across
multiple mocked GitHub pages, duplicate-safe reruns, keyword-only fallback, token
refresh, reconnect-required behavior, and the absence of credential fields in
responses.

Session regression coverage verifies that refreshed cookie options and headers
are copied to the response. Manual browser verification covers:

1. Sign in, navigate between protected pages, refresh, restart the local server,
   and confirm the session remains usable.
2. Connect GitHub and confirm the first sync starts automatically.
3. Sign out and sign in again; confirm exactly one automatic sync starts.
4. Press **Sync now** and confirm new stars appear without duplicates.
5. Revoke GitHub access and confirm SaveSort asks for reconnection without logging
   the user out of SaveSort.

Before completion, run formatting, lint, type checking, deterministic tests, and
the production build. Database migrations must include RLS and explicit grants.

## Out of scope

- GitHub as a SaveSort login provider
- scheduled/background cron synchronization
- webhooks, queues, or separate workers
- mirroring unstars as SaveSort deletions
- importing watched repositories, issues, pull requests, or repository files
- bypassing GitHub rate limits or access controls
