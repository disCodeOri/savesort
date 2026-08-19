# AGENTS.md

## Product

SaveSort is a private, search-first MVP for saving internet resources and finding them later with keywords or vague descriptions. Keep the product focused on ingest → index → retrieve.

## Architecture

- `src/app/`: Next.js App Router pages and authenticated Route Handlers.
- `src/components/`: responsive product UI; preserve the editorial search-first design.
- `src/lib/supabase/`: cookie-based browser/server clients and session proxy.
- `src/lib/ingestion/`: safe website and GitHub enrichment. Never scrape restricted platforms.
- `src/lib/github/`, `src/lib/reddit/`: OAuth account sync. Each provider owns its own encryption key and reads only the connected user's own data through their token.
- `src/lib/data-import/`: Reddit and LinkedIn account-data export import. The uploaded export is the only source of platform content; it is parsed in the browser, never executed, and no platform API or page is ever fetched.
- `src/lib/archive/`: entry path and decompression-bomb checks shared by every archive importer.
- `src/lib/embeddings/`: server-only Gemini embedding boundary at 768 dimensions.
- `src/lib/search/`, `urls/`, `sources/`: deterministic, tested utilities.
- `src/lib/urls/analyze.ts`: what a URL reveals without being fetched — platform, content type, ids, author, slug-derived title, keywords. Never makes a request.
- `supabase/migrations/`: schema, indexes, RLS, and hybrid-search RPC.
- `tests/`: meaningful deterministic Vitest coverage.

The database combines generated PostgreSQL `tsvector` search with pgvector cosine search using reciprocal rank fusion in `hybrid_search_saved_items`. Keyword-only fallback is a required behavior.

## Commands

```text
npm run dev
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npx supabase db push
```

## Conventions

- Use small descriptive functions and plain TypeScript; optimize for first-year developers reading the code.
- Write tests first for deterministic behavior and regressions.
- Keep App Router request APIs async (`cookies`, `params`, `searchParams`).
- Prefer Server Components for page shells and Client Components only for interaction.
- Validate every route input and return friendly errors instead of stack traces.
- Rebuild searchable text and attempt a fresh embedding after searchable edits.
- Pin dependency versions and commit the lockfile.

## Security constraints

- RLS is mandatory for every exposed user-data table. Policies must enforce `auth.uid() = user_id`; updates need both `USING` and `WITH CHECK`.
- Do not add a browser-visible service-role, Supabase secret, Gemini key, or GitHub token.
- Do not log tokens or unbounded scraped content.
- Never fetch localhost, private/link-local IPs, non-HTTP protocols, or unvalidated redirects.
- Never bypass authentication, rate limits, bot protection, robots rules, or platform access controls.
- Never use `dangerouslySetInnerHTML` for external content.

## Scope guard

Do not introduce LangChain, LlamaIndex, Redis, Elasticsearch, queues, microservices, Kubernetes, a Python backend, chat/RAG answers, folders, billing, admin tooling, analytics, or automatic restricted-platform scrapers. Instagram, X and LinkedIn are restricted sources: never fetch their pages, and never send one of their URLs to a model to ask what it contains. Add infrastructure only when a concrete approved requirement cannot work without it.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
