# GitHub Stars Search MVP — Design

## Product promise

SaveSort connects to a person's GitHub account, imports the repositories that person has starred, and lets them recover a repository by describing what they remember or what they need.

The MVP proves one claim:

> A user with hundreds of GitHub stars can describe a repository without remembering its name and reliably find it.

This is a single-source, search-first product. It is not yet a universal saved-content search engine, recommendation system, knowledge graph, chatbot, or repository code-search product.

## User experience

The first-use flow is:

1. The user signs into SaveSort.
2. The user connects their GitHub account through a GitHub App authorization flow.
3. SaveSort imports all repositories returned by the authenticated user's starred-repositories endpoint.
4. SaveSort enriches and indexes each public starred repository.
5. The user enters a natural-language description.
6. SaveSort returns the best matching repositories, an understandable match level, supporting evidence, and links to GitHub.

Example query:

> The local-first database repo I starred that works well with React.

Each result shows the repository's full name, description, topics, primary language, star date, a relevant README excerpt, a match level, a short explanation, and an “Open on GitHub” action.

The UI exposes import progress and allows a manual resync. Search remains available while an incremental resync is running.

## Scope boundary

### Included

- One SaveSort user connected to one GitHub identity.
- GitHub App authorization with account permission `Starring: read`.
- Import and incremental resync of all starred repositories via `GET /user/starred`, using pagination and GitHub's star media type so `starred_at` is retained.
- Public repository metadata, topics, primary language, and default-branch README content.
- Hybrid keyword and semantic search.
- Candidate reranking against the user's complete query.
- Evidence-based explanations and links to the original repository.
- Search and import state isolated by SaveSort user.

### Excluded

- Private repository content. A private starred repository may be recorded as unavailable if it appears in the star response, but SaveSort does not request repository-content permission in this MVP.
- Cloning or indexing source code, issues, pull requests, releases, commits, or repository documentation beyond the default README.
- Instagram, YouTube, Reddit, Notion, notes, bookmarks, and generic URLs.
- Chat, synthesized answers, recommendations, resurfacing, engagement learning, folders, knowledge graphs, and collaborative features.
- Adding or removing GitHub stars from SaveSort.
- Automatic background schedules. The MVP imports after connection and on explicit resync; scheduling can be added later without changing the connector contract.

## Architecture

The application is a Next.js App Router application deployed on Vercel, backed by Supabase Auth and Postgres. Postgres provides both full-text search and vector storage through `pgvector`. Server-only Next.js route handlers perform GitHub token exchange, GitHub API access, OpenAI calls, and indexing orchestration.

The system is divided into replaceable units:

- `GitHubConnection` owns authorization tokens and the connected GitHub identity.
- `SourceConnector` lists externally saved items. The first implementation is `GitHubStarsConnector`.
- `RepositoryEnricher` turns a GitHub repository into searchable evidence using metadata and README text.
- `EmbeddingProvider` produces fixed-dimension vectors. The MVP implementation uses OpenAI.
- `HybridRetriever` combines Postgres full-text and vector rankings.
- `Reranker` judges only the retrieved candidate set against the full query.
- `MatchExplainer` creates a concise explanation supported by indexed evidence.

Source-specific data is normalized before reaching search. Adding a future source requires a connector and enricher that emit the same normalized item and chunk contracts; the retrieval path remains unchanged.

## Data model and interfaces

All exposed tables use row-level security with `user_id = auth.uid()`. GitHub access and refresh tokens are encrypted at rest and are never returned to the browser. Server-side privileged operations use a server-only secret; no service-role or GitHub secret is placed in a `NEXT_PUBLIC_` variable.

### `source_connections`

- `id`, `user_id`, `source`, `external_user_id`, `external_username`
- encrypted access token, encrypted refresh token, and token expiry timestamps
- `status`: `active`, `reauthorization_required`, or `disconnected`
- `last_synced_at`, `created_at`, `updated_at`
- unique on `(user_id, source)`

### `saved_items`

- `id`, `user_id`, `connection_id`
- `source`: initially `github`
- `source_item_id`: GitHub repository ID as text
- `canonical_url`, `title`, `description`, `author`
- `starred_at`, `source_updated_at`
- `metadata` JSON containing full name, topics, primary language, default branch, visibility, owner avatar, and GitHub star count
- `content_status`: `pending`, `ready`, `partial`, `failed`, or `unavailable`
- `content_error_code`, `indexed_at`, timestamps
- unique on `(user_id, source, source_item_id)`

### `saved_item_chunks`

- `id`, `user_id`, `saved_item_id`, `ordinal`
- `kind`: `identity`, `description`, or `readme`
- `content`, generated English `tsvector`, and embedding vector
- character offsets into the normalized source text when applicable
- unique on `(saved_item_id, ordinal)`

An identity chunk combines repository name, owner, description, topics, and language so exact identifiers and short repositories remain searchable. README content is normalized and divided at heading/paragraph boundaries into overlapping chunks sized for retrieval. Empty or missing READMEs do not prevent metadata-only indexing.

### Connector contract

`SourceConnector.listSavedItems(cursor?)` returns normalized source records plus a next cursor. `GitHubStarsConnector` uses 100 items per GitHub API page and follows pagination until exhausted. Repeated imports upsert on the source repository ID and do not duplicate records.

### Search contract

`POST /api/search` accepts `{ query: string, limit?: number }`, with query trimmed and constrained to a practical maximum length. The response returns:

- item identity and GitHub URL
- match level: `strong`, `useful`, or `possible`
- evidence excerpt and evidence kind
- concise match explanation
- internal ranking score for diagnostics, not displayed as a percentage

The public response never describes cosine similarity as probability or certainty.

## Import and indexing flow

1. Generate OAuth state and PKCE values server-side and redirect to GitHub.
2. On callback, validate state, exchange the authorization code, validate the GitHub identity, encrypt tokens, and upsert the connection.
3. Page through `GET /user/starred` with `per_page=100`, requesting the representation that includes `starred_at`.
4. Upsert each repository immediately so progress is durable.
5. Fetch topics, language information, and the default README through GitHub's API where publicly available.
6. Normalize metadata and README Markdown, remove badges and obvious navigation noise, then create chunks.
7. Generate embeddings in bounded batches and upsert chunks transactionally for each item.
8. Mark the item `ready`, `partial`, `failed`, or `unavailable` with a machine-readable error code.
9. Record the completed sync time after all GitHub pages have been enumerated, even if individual items are partial.

A later resync updates changed items, creates newly starred items, and removes items no longer present from the active searchable corpus. It compares the complete imported ID set before deleting stale rows, so an interrupted or rate-limited import cannot accidentally remove valid stars.

## Search and ranking flow

1. Validate the authenticated user and query.
2. Generate one query embedding using the same model and dimensions as stored chunks.
3. Run owner-scoped full-text search and vector search over chunks.
4. Fuse the two ranked lists with reciprocal-rank fusion, initially weighting keyword and semantic rankings equally.
5. Group chunk hits by repository, retaining the best evidence and limiting dominance by repositories with long READMEs.
6. Send the top candidate repositories—not the whole corpus—to the reranker with their names, descriptions, topics, and best excerpts.
7. Return up to ten repositories ordered by reranker judgment, with `strong`, `useful`, or `possible` match levels.
8. Generate explanations only from supplied evidence. If explanation generation fails, return a deterministic explanation built from the matched excerpt and metadata rather than failing the search.

The first version uses OpenAI for embeddings and structured reranking/explanation output. Model names and embedding dimensions are configuration values, while the database migration fixes the selected dimension for a given deployment. Changing embedding models requires a versioned reindex rather than mixing vectors from different models.

## Failure handling and observability

- Invalid or expired GitHub authorization moves the connection to `reauthorization_required` and preserves already indexed content.
- GitHub rate limiting pauses the import, records the reset time, and offers retry; completed pages remain durable.
- Missing, binary, or oversized READMEs produce metadata-only or truncated partial indexes.
- Deleted, renamed, transferred, archived, or inaccessible repositories are reconciled on resync using the stable GitHub repository ID.
- OpenAI batch failures retry with bounded exponential backoff; persistent failures mark only the affected item as failed.
- Search never crosses user boundaries, never includes non-ready chunks, and degrades to keyword search if query embedding generation is unavailable.
- Structured logs include a request/import correlation ID, user ID, connection ID, GitHub rate-limit state, counts by content status, latency per retrieval stage, and provider error class. Tokens and README bodies are never logged.

## Verification and success criteria

Create a fixed evaluation set from the owner's real stars: at least 30 natural-language queries, each with one or more manually judged relevant repositories. Include exact-name queries, technology queries, vague remembered descriptions, need-based queries, repositories with missing READMEs, and intentionally unanswerable queries.

The MVP is successful when:

- A connected account with roughly 500 stars imports completely without duplicates and retains star dates.
- Repeating an unchanged sync is idempotent.
- At least 80% of evaluation queries place a relevant repository in the top five; exact repository-name queries place it first.
- Unanswerable queries do not fabricate matches or claim certainty; weak results are clearly labeled or no strong match is stated.
- Search returns an initial response within two seconds at the target corpus size under normal provider latency.
- Every displayed explanation is supported by the repository metadata or returned README excerpt.
- Automated tests prove user isolation, OAuth state validation, pagination, interrupted-sync safety, hybrid ranking, deterministic fallbacks, and token secrecy.

## Extension path

The MVP intentionally creates extension points rather than future features. A new saved-content source implements `SourceConnector` and a source-specific enricher, then emits `saved_items` and `saved_item_chunks`. Search, ranking, RLS, evaluation, and result presentation remain source-agnostic. Background scheduling can later call the same idempotent sync operation; alternative embedding and reranking providers can replace their interfaces after a versioned reindex and evaluation run.
