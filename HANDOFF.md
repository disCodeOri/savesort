# SaveSort Agent Handoff

**As of:** 2026-08-16 (Asia/Calcutta)  
**Repository:** `C:\Users\admin\OneDrive\Desktop\Github Repo\savesort`  
**Mission:** Finish and manually validate the minimum viable GitHub-account star sync. Do not expand scope.

## 1. Exact repository state

- Current branch: `main`
- HEAD: `f30beec1c4c6450f53050c01e83748a85b81909d` (`docs: clarify GitHub sync admin boundary`)
- Remote state: local `main` is 29 commits ahead of `origin/main`; nothing has been pushed.
- The completed feature branch/worktree was merged by fast-forward, tested, then removed.
- Keep `codex/universal-saved-items-mvp` separate. Its `fe4ff22 tc` commit is not part of `main`.
- Working tree items that predate this handoff and must not be overwritten blindly:
  - Modified `.gitignore`: adds `node_modules`.
  - Modified `next-env.d.ts`: Next.js changed type imports to `.next/dev/types/*`.
  - Untracked `.handover/`: existing user-generated collation artifacts.
  - This handoff adds untracked `HANDOFF.md` until explicitly committed.

## 2. Delivered functionality

1. Private saved-item MVP: URL ingestion, GitHub/web enrichment, 768-dimensional Gemini embeddings, generated `tsvector`, hybrid RRF search, and keyword-only fallback.
2. Persistent Supabase cookie sessions across navigation, refresh, and browser restart; logout clears the session.
3. Separate GitHub OAuth connection using state + PKCE. This does not replace SaveSort login.
4. Server-only encrypted GitHub access/refresh token storage and refresh handling.
5. GitHub star synchronization with pagination, bounded concurrency, atomic page application, lease recovery, heartbeats, and race protection.
6. Existing user notes, content, thumbnail, and user tags survive GitHub re-sync merges. Unstarring does not delete saved items.
7. Automatic sync starts once after successful SaveSort password login and once after GitHub connection. The URL marker is consumed so refresh does not retrigger it.
8. Library panel supports connection status, Connect, Reconnect, Sync now, and confirmed Disconnect.
9. Setup instructions are in `README.md`; required names are in `.env.example`.

## 3. Database state

- Live Supabase project used during implementation: `ilnqazpjjsvyhyzmlqjg`.
- GitHub connection, credential, atomic-save, page-lease, and scoped-heartbeat migrations were applied live and verified.
- Relevant local files: `supabase/migrations/20260815*.sql` and `supabase/tests/github_connections_verification.sql`.
- RLS remains mandatory. Browser roles must never access `github_connection_secrets`; privileged operations use the server-only admin client.

## 4. Verification evidence

- Merged `main`: `npm test` passed, **18 files / 151 tests**.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- Final whole-branch review: approved with no Critical or Important findings.
- Live SQL migration verifiers: passed.
- `npm run format:check`: known failure on 67 pre-existing unrelated formatting warnings. Changed feature/docs files passed focused Prettier checks. Do not run write-all formatting unless explicitly requested.

## 5. Current configuration and blocker

`.env.local` currently has configured public Supabase values, site URL, and Gemini key. It does **not** contain these required GitHub-sync server variables:

```text
GITHUB_APP_CLIENT_ID
GITHUB_APP_CLIENT_SECRET
GITHUB_TOKEN_ENCRYPTION_KEY
SUPABASE_SECRET_KEY
```

`GITHUB_TOKEN` is also blank, but it is optional. Never print, commit, or expose any secret value.

The only functional blocker is live OAuth/end-to-end validation. A developer must create/configure the GitHub App and add the four missing server values according to `README.md`.

## 6. Next actions — execute in order

1. Preserve the current dirty/untracked files. Decide with the user whether `.gitignore` and generated `next-env.d.ts` should be committed or restored; do not assume.
2. Configure a GitHub App:
   - Homepage: the SaveSort origin.
   - Callback: `<origin>/api/github/callback`.
   - Account permission: **Starring — Read-only**.
   - Repository write permissions: none.
3. Add the four missing server variables to `.env.local`; generate the 32-byte base64 encryption key using the command in `README.md`.
4. Restart the single Next.js development server.
5. Run the acceptance sequence below. Fix only evidence-backed failures and add a regression test before each fix.
6. With explicit user authorization, commit the intended handoff/working-tree files and push `main`. Do not push secrets or `.handover/` artifacts by default.

## 7. Manual acceptance sequence

1. Sign in, navigate, refresh, restart the browser, and confirm the SaveSort session persists; sign out and confirm it clears.
2. Open `/library`; verify the disconnected GitHub panel contains no secret/token data.
3. Connect GitHub; confirm callback returns to `/library?githubSync=connect`, the marker disappears, and initial sync completes.
4. Verify starred repositories appear once and are searchable by repository name, topic, language, and a vague semantic description.
5. Star a repository, sign out/in, and confirm exactly one automatic sync imports it. Refresh `/search`; confirm no second sync starts.
6. Star another repository and use **Sync now**; confirm it appears.
7. Unstar an imported repository, sync, and confirm the existing SaveSort item remains.
8. Revoke GitHub authorization, sync, and confirm the panel requests reconnection while the SaveSort login remains valid.
9. Disconnect GitHub and confirm saved repositories remain in the library.

## 8. High-value file map

- Session persistence: `src/lib/supabase/proxy.ts`, `src/proxy.ts`
- OAuth routes: `src/app/api/github/connect/route.ts`, `callback/route.ts`, `connection/route.ts`
- Sync API/engine: `src/app/api/github/sync/route.ts`, `src/lib/github/sync.ts`
- Credentials/crypto: `src/lib/github/connections.ts`, `crypto.ts`, `src/lib/supabase/admin.ts`
- Browser runner: `src/lib/github/sync-client.ts`, `src/components/github-auto-sync.tsx`
- Manual controls: `src/components/github-connection-panel.tsx`, `library-client.tsx`
- Mapping/preservation: `src/lib/github/map-star.ts`
- Setup: `README.md`, `.env.example`
- Deterministic coverage: `tests/github-*.test.ts*`, `tests/supabase-proxy.test.ts`

## 9. Non-negotiable guardrails

- Read `AGENTS.md` and the relevant Next.js 16.3.1 guide under `node_modules/next/dist/docs/` before code changes.
- Keep the product to ingest → index → retrieve. No queues, cron, webhooks, alternate auth, chat/RAG, analytics, or new infrastructure.
- Never expose service-role/Supabase secrets, Gemini keys, GitHub tokens, or OAuth credentials to Client Components or API JSON.
- Preserve RLS ownership checks and SSRF protections.
- Do not revisit deferred polish or request-origin hardening unless the user explicitly changes scope.

## 10. Standard verification

```text
npm run lint
npm run typecheck
npm test
npm run build
git diff --check
git status --short
```

**Exit condition:** GitHub App variables are configured, the full manual acceptance sequence passes, deterministic checks remain green, intended changes are committed, and `main` is pushed only with user authorization.
