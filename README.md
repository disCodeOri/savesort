# SaveSort

SaveSort is a private search engine for useful things you save across the internet. Save a GitHub repository, article, website, video, or manually described social link, then find it later with either exact words or a vague memory.

Examples:

- “that terminal tool for downloading YouTube videos”
- “AI tool for transcribing lectures”
- “React animation library I saved”

This repository contains the complete MVP: authentication, safe URL ingestion, GitHub enrichment, manual social content, keyword and semantic search, filters, a saved-items library, editing, deletion, retryable indexing, migrations, RLS, tests, and responsive UI.

## Architecture

```text
Save URL
  → validate + normalize + detect source
  → safely fetch public metadata (or keep manual text)
  → build one searchable text document
  → PostgreSQL full-text index + Gemini embedding
  → Supabase saved_items table protected by RLS

Search query
  → PostgreSQL keyword ranking
  → pgvector cosine ranking
  → reciprocal rank fusion in PostgreSQL
  → private result cards
```

The application is one Next.js App Router project. Route Handlers do server-only enrichment and embedding work. Supabase SSR keeps the user session in cookies. Every data request uses the current user’s Supabase client, and Row Level Security is the final authorization boundary—there is no service-role client in this app.

If Gemini is unavailable, saving still works and PostgreSQL keyword search remains available.

## Tech stack

- **Next.js 16 / React 19 / TypeScript** — application, server routes, and UI.
- **Tailwind CSS 4** — CSS build pipeline and responsive styling.
- **Supabase Auth** — straightforward email/password signup and login.
- **Supabase PostgreSQL** — private saved-item records and full-text search.
- **pgvector** — 768-dimension semantic vectors.
- **Gemini Embeddings** — `gemini-embedding-001` through the official `@google/genai` SDK.
- **Vitest** — deterministic unit tests.

## Local setup

Requirements: Node.js 20.9 or newer, npm, and a Supabase project.

```powershell
git clone <your-repository-url>
cd savesort
npm install
Copy-Item .env.example .env.local
```

Fill in `.env.local` as described below. Never commit it.

## Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. In the project’s **Connect** dialog, copy the project URL and publishable key into `.env.local`.
3. Keep Email authentication enabled under **Authentication → Providers**.
4. Add `http://localhost:3000` to **Authentication → URL Configuration** for local development.
5. Log in and link the CLI, then push the migration:

```powershell
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

The migration in `supabase/migrations/` enables `vector`, creates `saved_items`, adds GIN and HNSW indexes, enforces per-user duplicate URLs, creates owner-only RLS policies, and adds the security-invoker `hybrid_search_saved_items` RPC.

For a fully local Supabase stack with Docker:

```powershell
npx supabase start
npx supabase db reset
```

The SQL checklist in `supabase/tests/saved_items_verification.sql` documents database-level security and search checks for a disposable environment.

## Gemini setup

Create a fresh API key in [Google AI Studio](https://aistudio.google.com/apikey) and set:

```text
GEMINI_API_KEY=your_new_key
```

The key is server-only. It creates document and query embeddings; it is never exposed through a `NEXT_PUBLIC_` variable. This project uses a 768-dimension output and normalizes the vector before storage.

If the key is absent, invalid, or rate-limited, items are saved as `keyword_only` and search falls back to PostgreSQL full-text matching.

> If a key has ever been pasted into chat, an issue, a terminal recording, or a public file, revoke it and create a new one.

## GitHub integration

`GITHUB_TOKEN` is optional. When present, it increases GitHub API rate limits for public repository metadata and README ingestion. Without it, GitHub ingestion uses the public unauthenticated API and degrades gracefully if the rate limit is reached.

The app indexes repository identity, description, topics, language, stars, homepage, owner, and a bounded README excerpt. It never clones or indexes source code.

## Environment variables

```text
NEXT_PUBLIC_SUPABASE_URL=          # required
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY= # required
NEXT_PUBLIC_SITE_URL=http://localhost:3000 # recommended
GEMINI_API_KEY=                    # recommended for semantic search
GITHUB_TOKEN=                      # optional
```

No service-role or Supabase secret key is required.

## Running locally

```powershell
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), create an account, and confirm your email if your Supabase project requires confirmation.

Useful checks:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

## How saving works

- GitHub repository URLs use the public GitHub API and a bounded README.
- Ordinary public pages get one guarded metadata request with DNS/private-IP checks, manual redirect validation, a timeout, content-type validation, and a response-size cap.
- Instagram, X/Twitter, TikTok, Facebook, and similar restricted services are never scraped. Their URL plus your optional title, notes, caption, or transcript are searchable.
- User text is rendered as text only. Scraped HTML is never injected into the UI.

## Deployment

1. Push the repository to GitHub.
2. Import it into Vercel.
3. Add the environment variables above to the Vercel project.
4. Set `NEXT_PUBLIC_SITE_URL` to the production origin.
5. Add the production origin and callback URL to Supabase Auth URL Configuration.
6. Run `npx supabase db push` against the linked production Supabase project before first use.

Do not deploy from this repository with a service-role key or with a credential that has appeared in chat.

## Current limitations

- Instagram, TikTok, X/Twitter, and Facebook saved-item syncing is not implemented. Users add these links manually with useful text.
- Generic HTML extraction is intentionally conservative and does not run JavaScript or crawl linked pages.
- Semantic quality depends on the configured Gemini embedding model and available API quota.
- Database/RLS integration checks require a configured Supabase project; unit tests cover deterministic local logic.
- There is no browser extension, mobile app, account import, background queue, folder system, chat assistant, billing, or team workspace.

## Future architecture

Plausible later additions are a browser extension, mobile share sheet, GitHub OAuth star import, user-assisted social export/import, YouTube integration, automated tagging, improved duplicate detection, and evaluated reranking. None are part of this MVP.
