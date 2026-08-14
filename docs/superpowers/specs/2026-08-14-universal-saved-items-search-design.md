# Universal Saved-Items Search MVP — Design

## Product promise

SaveSort is a private personal search engine for links people want to remember. A user can save a GitHub repository, article, website, video, or manually described social post, then retrieve it later with either its exact name or a vague description.

The MVP proves one claim: a useful thing saved months ago can be found again without remembering its title or source.

## Product boundaries

The product is one Next.js application backed by Supabase. It includes email/password authentication, URL ingestion, safe enrichment, GitHub repository enrichment, manual text for restricted sources, keyword and semantic retrieval, source filters, a browseable library, editing, deletion, and indexing retry.

It does not scrape restricted platforms, crawl sites, import accounts, answer questions with RAG, organize folders, recommend content, bill users, or introduce queues and services.

## User experience

The primary screen is a personal search surface rather than an admin dashboard. A serif headline and oversized search input establish the main job. Source filters sit directly beneath the query. Results use compact editorial rows on desktop and touch-friendly cards on mobile. A persistent “Save something” action opens a side sheet with URL, title, notes, and pasted content fields.

The library uses the same result anatomy in newest-first order, with source filtering and direct edit, retry, delete, and open-original actions. New users see an explanatory empty state and the save action.

Visual tokens:

- Warm paper background (`#fbfaf5`) and white surfaces.
- Deep ink text (`#0b1028`).
- Electric chartreuse (`#c8ff1a`) for primary actions and selected states.
- Restrained sage, lavender, coral, and blue source accents.
- Display serif headings and readable system sans-serif UI copy.
- Thin borders, modest radii, subtle shadows, and horizontal editorial result structure.

The desktop and mobile concepts are stored beside this document in `docs/superpowers/specs/assets/`.

## Architecture

The App Router application uses Server Components for authenticated page shells and initial data, Client Components for forms and interactive search, and Route Handlers for authenticated mutations and search. Supabase SSR owns cookie sessions. Every database operation runs as the current user so Row Level Security remains the final authorization boundary.

Small server-only modules perform URL validation, source detection, safe HTTP fetching, GitHub enrichment, searchable-text construction, and Gemini embedding. No service-role credential is needed by the application.

## Data model and security

`saved_items` stores one normalized item per user and URL. Its searchable document combines title, description, notes, pasted content, author, tags, and source. A generated `tsvector` supports keyword retrieval; a nullable `vector(768)` stores Gemini embeddings. Indexing status and a safe error message let saves and edits survive provider failures.

RLS enables select, insert, update, and delete only when `(select auth.uid()) = user_id`. Update policies use both `USING` and `WITH CHECK`. The hybrid-search RPC is `security invoker`, filters by `auth.uid()`, and cannot accept an arbitrary user ID. The browser receives only Supabase publishable credentials. Gemini and GitHub keys remain server-only.

## Save and enrichment flow

1. Validate and conservatively normalize the submitted HTTP(S) URL.
2. Detect the source from its hostname and reject duplicates for the user.
3. For GitHub repository URLs, fetch public repository metadata and a bounded README through the public API.
4. For ordinary public websites, resolve DNS, reject local/private targets, fetch once with a timeout and response cap, then extract safe text metadata.
5. Never fetch restricted social sources; use only user-supplied text.
6. User-supplied title, notes, and content take precedence where appropriate.
7. Build a bounded canonical searchable document and request a 768-dimension Gemini embedding.
8. Store the item even when enrichment or embedding fails, preserving a non-fatal status for retry.

## Search flow

The query is trimmed, length-limited, and embedded with the retrieval-query task type. The `hybrid_search_saved_items` SQL function creates independent keyword and vector rankings, then combines them with reciprocal rank fusion. It accepts an optional source and a bounded result limit. If Gemini is unavailable, the same RPC receives a null vector and performs keyword-only ranking. Exact names remain strong through full-text rank; vague descriptions benefit from vector similarity.

## Editing and deletion

Users can edit title, notes, pasted content, and tags. The server rebuilds searchable text and attempts a fresh embedding before updating the row. Retry indexing invokes the same deterministic representation and embedding boundary. Delete uses the user-scoped Supabase client and RLS.

## Error handling

Routes return stable, friendly messages for invalid URLs, duplicates, missing authentication, provider failure, not-found rows, and unexpected errors. External response bodies, credentials, tokens, and raw stack traces are never returned or logged. Search warnings distinguish semantic fallback from complete failure.

## Testing and verification

Vitest covers URL validation and normalization, source detection, GitHub parsing, searchable-text construction, and reciprocal-rank helpers. SQL verification queries document RLS and search checks. Completion requires formatting, lint, TypeScript, tests, production build, and browser checks at desktop and mobile sizes. Provider-backed behavior that requires real Supabase/Gemini projects is documented as an integration step rather than falsely claimed from local mocks.

## Self-review

The design contains no placeholders, keeps the provider substitution explicit (Gemini embeddings at 768 dimensions), preserves the requested MVP boundary, and assigns authorization to RLS rather than route filtering alone.
