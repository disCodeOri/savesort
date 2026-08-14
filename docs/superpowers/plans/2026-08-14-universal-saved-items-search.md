# Universal Saved-Items Search MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete, understandable MVP that privately saves, enriches, indexes, searches, edits, and deletes internet resources.

**Architecture:** A single Next.js App Router application uses Supabase SSR authentication and user-scoped data access. Focused server modules enrich URLs and create Gemini embeddings; Postgres performs RLS-protected full-text, vector, and reciprocal-rank-fusion search.

**Tech Stack:** Next.js, TypeScript, React, Tailwind CSS, Supabase Auth/Postgres/pgvector, `@google/genai`, Vitest, Testing Library.

## Global Constraints

- One application; no queues, microservices, agents, or separate backend.
- Do not scrape or fetch restricted social platforms.
- Never expose Gemini, GitHub, or service-role credentials to the browser.
- Saves and edits succeed with keyword indexing when enrichment or embeddings fail.
- Use 768-dimension Gemini embeddings consistently in code and SQL.
- Keep files small, names descriptive, and comments focused on non-obvious reasons.

---

### Task 1: Application foundation and deterministic URL behavior

**Files:** Create Next.js configuration, package files, `src/lib/urls/*`, `src/lib/sources/*`, and tests under `tests/`.

**Interfaces:** Produce `validateHttpUrl`, `normalizeUrl`, `detectSource`, and `parseGitHubRepositoryUrl`.

- [ ] Scaffold the pinned Next.js/TypeScript/Tailwind/Vitest application.
- [ ] Write failing table-driven tests for valid, invalid, normalized, tracked, and source-specific URLs.
- [ ] Run the tests and confirm failures are caused by missing production modules.
- [ ] Implement the smallest deterministic utilities that satisfy the tests.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Search document and ranking helpers

**Files:** Create `src/lib/search/searchable-text.ts`, `src/lib/search/ranking.ts`, and focused tests.

**Interfaces:** Produce `buildSearchableText(item): string`, `reciprocalRank(rank, weight?, k?): number`, and query/source schemas.

- [ ] Write failing tests with hand-derived expected text and rank values.
- [ ] Confirm the intended failures.
- [ ] Implement bounded whitespace-normalized text assembly and deterministic RRF helpers.
- [ ] Run the focused tests to green.

### Task 3: Database schema, RLS, and hybrid search

**Files:** Create `supabase/migrations/*_saved_items.sql` and `supabase/tests/saved_items_verification.sql`.

**Interfaces:** Produce `public.saved_items`, generated full-text column, vector index, ownership policies, timestamp trigger, and `hybrid_search_saved_items` RPC.

- [ ] Add extensions, enum/check constraints, table, indexes, grants, and generated search document.
- [ ] Add owner-only RLS policies including `WITH CHECK` for updates.
- [ ] Add a security-invoker hybrid-search function using keyword and vector ranks plus optional source filtering.
- [ ] Add SQL verification queries for duplicate isolation, RLS, exact search, semantic search, and fallback.

### Task 4: Supabase SSR authentication

**Files:** Create `src/lib/supabase/{client,server,proxy}.ts`, `src/proxy.ts`, auth actions, login page, callback route, and protected app layout.

**Interfaces:** Produce cookie-based email/password signup, login, logout, and authenticated route protection.

- [ ] Configure browser/server clients with publishable credentials only.
- [ ] Add session-refresh proxy and authoritative server user checks.
- [ ] Add accessible login/signup form with stable friendly errors.
- [ ] Protect search, library, and item routes.

### Task 5: Gemini embeddings and enrichment

**Files:** Create `src/lib/embeddings/gemini.ts`, `src/lib/ingestion/{github,web,ssrf,ingest}.ts`, and route-level schemas.

**Interfaces:** Produce `embedDocument`, `embedQuery`, `enrichGitHubRepository`, `enrichPublicWebpage`, and `ingestSavedItem`.

- [ ] Add server-only Gemini 768-dimension embedding calls with bounded input.
- [ ] Add deterministic restricted-source fetch rules.
- [ ] Add DNS/private-network rejection, redirect revalidation, timeout, content-type, and response-size limits.
- [ ] Add GitHub public repository metadata and bounded README enrichment with optional token.
- [ ] Combine user and enriched data so provider/network failures still return a storable item.

### Task 6: Authenticated item API

**Files:** Create route handlers under `src/app/api/items`, dynamic item routes, and search route.

**Interfaces:** JSON endpoints for create, list, get, update, delete, retry indexing, and hybrid search.

- [ ] Validate every request with Zod and require a verified Supabase user.
- [ ] Create items through ingestion and map duplicate constraint failures to friendly messages.
- [ ] Rebuild embeddings for searchable edits without blocking keyword updates.
- [ ] Invoke the hybrid-search RPC with a query vector or null fallback.
- [ ] Ensure dynamic operations remain owner-scoped through RLS.

### Task 7: Search-first responsive interface

**Files:** Create global tokens, app shell, source filters, search form, result list/card, save sheet, feedback, loading, empty, and error components.

**Interfaces:** Search page preserves query/source in URL and opens originals in new tabs.

- [ ] Implement the accepted desktop concept’s nav, typography, palette, spacing, and result anatomy.
- [ ] Add meaningful loading, empty, error, indexing, and semantic-fallback states.
- [ ] Build the save side sheet with the four requested fields and restricted-source guidance.
- [ ] Implement responsive navigation, filters, cards, and sticky mobile save action.

### Task 8: Library and item editing

**Files:** Create library page/client, item edit page/form, row menus, confirm dialog, and retry action.

**Interfaces:** Newest-first browse, source filter, edit, delete, retry indexing, and open original.

- [ ] Build the accepted library/mobile anatomy without folders or dashboard widgets.
- [ ] Add prefilled editing for title, notes, content, and comma-separated tags.
- [ ] Add explicit delete confirmation and optimistic success feedback.
- [ ] Refresh visible data after mutations.

### Task 9: Documentation and developer guidance

**Files:** Replace `README.md`; create `.env.example` and root `AGENTS.md`.

- [ ] Explain architecture and each external service in beginner-friendly language.
- [ ] Document exact Supabase, Gemini, optional GitHub, local, test, and deployment steps.
- [ ] State current restricted-source and integration-test limitations.
- [ ] Document commands, directories, search design, security constraints, and infrastructure boundaries for future agents.

### Task 10: Full verification and visual fidelity

**Files:** Modify only files required by discovered failures; keep screenshots outside shipped source.

- [ ] Run formatter, lint, TypeScript checking, focused tests, full tests, and production build.
- [ ] Start the app with safe local placeholder public configuration.
- [ ] Verify desktop and mobile routes and interactions using the available browser tooling.
- [ ] Compare browser screenshots against both accepted concepts with `view_image` and repair material drift.
- [ ] Re-run the full verification suite and record exact results and environmental limitations.

## Plan self-review

Every requested MVP capability maps to a task. Provider and vector dimensions are consistent across the plan. No task introduces future-scope importers, folders, agents, billing, chat, or infrastructure.
