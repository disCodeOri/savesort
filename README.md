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

The application is one Next.js App Router project. Route Handlers do server-only enrichment and embedding work. Supabase SSR keeps the user session in cookies. User-facing data requests use the current user’s Supabase client, and Row Level Security is the final authorization boundary. GitHub connection and sync work uses a narrowly scoped server-only admin client for encrypted credentials; it is never browser-exposed.

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

### GitHub App account sync setup

To import the repositories starred by a signed-in user, create a GitHub App owned by your account. Use the SaveSort origin (for example, `http://localhost:3000`) as its homepage URL and set its **User authorization callback URL** to `<origin>/api/github/callback`. Under **Account permissions**, set **Starring** to **Read-only**; leave repository write permissions disabled.

Copy the App client ID and client secret to `.env.local`, then generate the token-encryption key and add the server-only Supabase secret key:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```text
GITHUB_APP_CLIENT_ID=             # GitHub App client ID
GITHUB_APP_CLIENT_SECRET=         # GitHub App client secret
GITHUB_TOKEN_ENCRYPTION_KEY=      # generated command output
SUPABASE_SECRET_KEY=              # Supabase server-side secret key
```

Store the generated value only in `GITHUB_TOKEN_ENCRYPTION_KEY`. Never commit `.env.local`, and restart Next.js after changing environment variables. Revoking the GitHub App authorization only makes SaveSort request a reconnection; it does not sign the user out of SaveSort.

## Reddit integration

SaveSort imports the saved posts of the **signed-in user's own Reddit account**. Reddit keeps saved history private to the account that owns it, so there is no supported way to import another person's saves from a username. The flow is always: the user connects their account, SaveSort reads the username from `/api/v1/me`, and it pages through `/user/{username}/saved` with that user's own token.

Saved comments are excluded (`type=links`), because a comment has no page for SaveSort to index. For each saved post the app stores the Reddit permalink, title, subreddit, flair, author, self-post text, and the outbound link. It never scrapes Reddit HTML and never reads another account's data.

### Reddit app account sync setup

Create an app at <https://www.reddit.com/prefs/apps> of type **web app**, and set its **redirect uri** to `<origin>/api/reddit/callback` (for example, `http://localhost:3000/api/reddit/callback`). SaveSort requests the `identity` and `history` scopes with `duration=permanent`; `history` is the scope Reddit defines as access to saved and hidden posts.

Copy the app's client ID and secret into `.env.local` and generate a token-encryption key of its own:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```text
REDDIT_APP_CLIENT_ID=             # Reddit app client ID
REDDIT_APP_CLIENT_SECRET=         # Reddit app secret
REDDIT_TOKEN_ENCRYPTION_KEY=      # generated command output, separate from the GitHub key
REDDIT_USER_AGENT=                # web:savesort:v0.1 (by /u/your_reddit_username)
SUPABASE_SECRET_KEY=              # Supabase server-side secret key
```

Reddit requires a unique, descriptive `User-Agent` on every Data API request, so `REDDIT_USER_AGENT` has no default and the integration stays disabled until it is set. Reddit's Responsible Builder Policy also requires an approved access request before using the Data API, and a separate agreement for commercial use — confirm your app's approval before enabling this in production.

Reddit does not promise an unbounded saved archive through this endpoint. SaveSort pages until Reddit stops returning a cursor, so a very large saved history may import fewer items than the account shows.

## X (Twitter) bookmarks

SaveSort imports the signed-in user's own X bookmarks and turns them into
ordinary saved items, so a half-remembered post is findable months later.

```text
Connect X  →  OAuth 2.0 + PKCE  →  GET /2/users/:id/bookmarks
      →  paginate  →  saved_items  →  hybrid search
```

Bookmarks become `source = 'x'` saved items keyed on the canonical permalink
`https://x.com/<username>/status/<id>`, so a repeated sync updates in place
rather than duplicating.

**Quoted posts are folded into the indexed body.** A bookmark whose entire text
is "this is exactly right" is unsearchable alone; the quoted post arrives free
as an expansion in the same response and carries the actual meaning.

### Two things that are easy to get wrong

**X exposes no "bookmarked at" time.** Only the post's own `created_at` is
available, so `x_bookmarks.first_seen_at` records when GRAPPlin first observed
the bookmark. It is never presented as a bookmark time.

**Unbookmarking on X does not delete anything.** After a _complete_ traversal,
bookmarks that vanished are marked inactive; the saved item, notes and tags all
survive. Reconciliation runs only on the branch where pagination genuinely
reached the end — a rate-limited, failed, or page-capped sync never reconciles,
because unseen bookmarks are not removed bookmarks.

### Setup

Create an X app with **OAuth 2.0**, type **Web App (confidential client)**, and
register the callback:

```text
http://localhost:3000/api/x/callback
https://your-deployment/api/x/callback
```

Scopes requested are read-only: `tweet.read`, `users.read`, `bookmark.read`,
`offline.access`. No write scope is ever requested.

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```text
X_CLIENT_ID=                  # OAuth 2.0 Client ID
X_CLIENT_SECRET=              # OAuth 2.0 Client Secret, server-only
X_TOKEN_ENCRYPTION_KEY=       # generated output, separate from the other keys
```

`TWITTER_*` is accepted as an alias for each. The OAuth 1.0a consumer key and
secret, and the app-only bearer token, are deliberately **not** used: the
bookmarks endpoint requires OAuth 2.0 user context, so those credentials cannot
work here and storing them would only widen exposure.

### Cost

X bills **per post returned**, not per request. Syncing is therefore only ever
triggered by an explicit user action — never on render, mount, or navigation.
The cursor is persisted on rate limits and failures so a resumed sync never
re-pays for pages that already landed, and both the server and the client cap
total pages so a misbehaving cursor cannot bill in a loop.

### Known upstream limitation

X's bookmarks endpoint has a documented tendency to stop returning
`meta.next_token` after a few pages. When that happens the sync ends cleanly and
still reconciles, so a very large bookmark library may import in several passes
rather than one.

## YouTube integration

SaveSort imports videos from playlists the signed-in user chooses, then makes
them searchable by what the video is actually about rather than only its title.

The pipeline runs in two stages, deliberately separated:

```text
YouTube playlist
      ↓  playlistItems.list  (50 ids per call)
video ids
      ↓  videos.list         (batched, 50 per call)
official metadata → saved_items      ← videos appear here immediately
      ↓  Gemini analyses the public video URL
description → searchable_text + embedding
```

Stage one is fast and cheap, so videos show up in the library right away.
Stage two is slow and can fail per video, so it runs separately and never
blocks the import. Only rows still marked `pending` are analysed, which is what
makes a re-sync free: existing videos are not re-analysed and personal notes and
tags are never touched.

Gemini reads the **public video URL** directly. Nothing is downloaded, no
transcript service is involved, and the YouTube OAuth token is never sent to
Gemini.

### YouTube account sync setup

Create a Google Cloud project, enable **YouTube Data API v3**, and configure an
OAuth client of type **Web application**. Add both callbacks you intend to use:

```text
http://localhost:3000/api/youtube/callback
https://your-deployment/api/youtube/callback
```

Request only this scope — SaveSort never needs write access:

```text
https://www.googleapis.com/auth/youtube.readonly
```

While the OAuth app is in **Testing**, only accounts listed under
_Audience → Test users_ can authorize it, and YouTube-scoped grants expire
after seven days, so expect to reconnect roughly weekly during development.

Generate a token-encryption key of its own and add the variables:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```text
YOUTUBE_CLIENT_ID=                # Google OAuth client ID
YOUTUBE_CLIENT_SECRET=            # Google OAuth client secret, server-only
YOUTUBE_TOKEN_ENCRYPTION_KEY=     # generated output, separate from the other keys
GEMINI_YOUTUBE_MODEL=             # optional; overrides the default analysis model
```

The connect route requests `access_type=offline` with `prompt=consent`, because
Google returns a refresh token only on first consent. A grant that comes back
without one is rejected rather than saved, since it would expire within an hour.

### Quota

The importer uses `playlistItems.list` and a batched `videos.list` (50 ids per
call) and never calls the expensive `search.list`, so a development playlist
costs a negligible fraction of the default daily allocation.

## X historical archive import

A second, independent way to get X data into GRAPPlin, alongside the live API
sync. The user downloads their archive ZIP from X and uploads it; no X API
credentials are involved and the importer never calls the X API.

### Where the work happens, and why

The archive is read **in the browser**, not on the server. Two reasons:

- **Privacy.** An X archive contains direct messages, contacts, IP and device
  history, login records and ad-targeting data. Reading locally means those
  files are never opened, never transmitted, and never reach an AI model.
  Only allowlisted, content-bearing records leave the machine.
- **Practicality.** Archives routinely run to hundreds of megabytes. Vercel
  caps request bodies at 4.5 MB and serverless has no persistent disk, so a
  server-side unzip would require an object-storage layer that does not exist
  in this project.

`.js` files in an archive are treated strictly as data: the assignment prefix
is stripped textually and the payload goes through `JSON.parse`. Nothing is
ever evaluated, imported, or injected — there are tests asserting exactly that.

```text
Archive ZIP (local)
      ↓  allowlist + safety limits
allowlisted datasets only
      ↓  parse, normalize
records
      ↓  reconcile by post id
unique content items
      ↓  batched POST /api/x/archive/batch
saved_items + x_post_relationships
```

### Content and relationships

A post is one `saved_items` row. What the user _did_ with it lives separately
in `x_post_relationships`, so a post that was liked, bookmarked and reposted is
one item with three relationships rather than three copies.

Identity is `x + post_id`, resolved to the canonical `https://x.com/…/status/…`
permalink that `saved_items` already keys on — so a post arriving from both the
archive and the API collapses onto a single row automatically, with provenance
recorded for each source.

### What is never done

- **No fabrication.** When the archive supplies only a post id, the item is
  stored `reference_only` with null text. Reference-only items are never
  classified and never embedded — embedding a numeric id would produce a
  confident vector for nothing.
- **No overwriting.** Richer stored data is never replaced by a poorer archive
  value, an existing embedding is never discarded, and user notes and tags are
  never touched by an import.
- **No timestamp invention.** `bookmarked_at` is used only when the archive
  actually provides it. A post's creation time is never presented as when the
  user saved it.

### Repeat imports and revert

Re-uploading the same archive is safe: content upserts on
`(user_id, normalized_url)` and relationships on their primary key, so nothing
duplicates. Removing an import deletes only the relationships that import
created; content shared with the API sync or another import survives, as does
anything the user annotated.

## Obsidian vault sync

The Windows desktop client in `windows-client/` mirrors a local Obsidian vault
into SaveSort. Synced notes are ordinary `saved_items` rows with
`source = 'obsidian'`, so they appear in the same hybrid search as everything
else with no query changes.

A note's identity is the **client-assigned file id**, not its vault path
(`normalized_url` is `obsidian://note/<clientFileId>`), so renaming or moving a
note updates the existing item instead of creating a duplicate. The `url` is an
`obsidian://open?…` link that opens the note in Obsidian.

### Desktop authentication

The client is a public OAuth client with no embedded secret. It runs a loopback
PKCE flow against `/desktop/authorize`, then exchanges the one-time code at
`/api/desktop/token` for an opaque access token (1 hour) and refresh token
(60 days, rotated single-use on every refresh). Only SHA-256 digests of those
tokens are stored server-side.

Device tokens are deliberately _not_ Supabase sessions: they can be revoked for
one machine without ending browser sessions, and they cannot be used to change
account credentials. `requireUser()` and the cookie-based browser auth are
unchanged — the sync surface authenticates separately through
`requireDesktopSession()`.

### Sync endpoints

All require `Authorization: Bearer <device access token>`.

```text
POST /api/sync/register      register or re-register a vault
POST /api/sync/files/batch   upsert up to 25 Markdown notes
POST /api/sync/delete        remove notes deleted locally
POST /api/sync/move          record a rename or move
GET  /api/sync/status        vault sync state and note count
GET  /api/sync/changes       server note manifest for reconciliation
```

Batch endpoints always return a per-file result rather than failing wholesale,
so a client can commit what succeeded and retry only what did not. An upload
whose `contentHash` already matches the stored note returns `unchanged` without
bumping the revision, which is what makes a retried upload safe after a crash or
a lost response.

### Conflicts

Every note carries a revision. Clients send the `baseRevision` their upload was
based on; if the server has since moved on, it returns `conflict` with its
current hash and **does not overwrite**. The desktop client leaves the local file
untouched and surfaces the conflict for the user to resolve.

### Scope

Markdown only. Attachments are deliberately excluded from v1 — there is no
object storage configured in this project yet, so binary sync would require
introducing Supabase Storage first.

## Reddit and LinkedIn data export import

A third way to get content into GRAPPlin, alongside the live provider syncs.
The user downloads their own account-data export from Reddit or LinkedIn and
uploads it here. **No platform API is called and no platform page is ever
fetched** — the uploaded export is the only source of platform content for this
feature.

### Where the work happens, and why

The export is read **in the browser**, not on the server. Two reasons:

- **Privacy.** A Reddit export contains private messages, chat history, IP
  logs, linked identities and payment records. A LinkedIn export contains
  connections, contacts, message history, login records, ad-targeting
  inferences and the full profile. Reading locally means those files are never
  opened, never transmitted and never reach an AI model. Only allowlisted,
  content-bearing records leave the machine.
- **Practicality.** Vercel caps request bodies at 4.5 MB and serverless has no
  persistent disk, so a server-side unzip would need an object-storage layer
  this project deliberately does not have.

Nothing is executed. Files are parsed strictly as data — there is no `eval`, no
script execution, and imported text is never rendered as HTML.

```text
Export ZIP or CSV (local)
      ↓  allowlist + safety limits
allowlisted datasets only
      ↓  platform detection, parse, normalize
records
      ↓  reconcile by content key, cross-reference within the export
unique items
      ↓  batched POST /api/imports/batch
saved_items + data_import_records
      ↓  bounded POST /api/imports/classify passes
classification, searchable_text, embedding
```

### Getting the export

- **Reddit** — visit `reddit.com/settings/data-request` in a desktop browser,
  sign in, request your full account history, and download the ZIP from the
  link Reddit emails you.
- **LinkedIn** — visit `linkedin.com/mypreferences/d/download-my-data`, pick
  the larger archive if you want your posts and comments as well as saved
  items, and download the ZIP when LinkedIn notifies you.

GRAPPlin never performs either download for you.

### What is recognised

Filenames are a hint, never the contract. Every file is matched on its **column
shape**, so a renamed, reordered or extra-columned file still imports, and a
dataset either platform adds later is ignored safely rather than breaking the
run.

| Platform | Dataset                       | What it yields                                       |
| -------- | ----------------------------- | ---------------------------------------------------- |
| Reddit   | `saved_posts`                 | id + permalink only — this is all Reddit ships       |
| Reddit   | `saved_comments`              | id + permalink only                                  |
| Reddit   | `post_votes`, `comment_votes` | upvotes only; a downvote is not an interest signal   |
| Reddit   | `posts`, `comments`           | the user's own title, body and dates                 |
| LinkedIn | `Saved_Items`                 | URL + saved date only — this is all LinkedIn ships   |
| LinkedIn | `Saved_Jobs`                  | job title, company, URL, saved date                  |
| LinkedIn | `Reactions`                   | dated interaction, no text                           |
| LinkedIn | `Shares`                      | the post's own text, publication date, external link |
| LinkedIn | `Comments`                    | the user's own comment on someone else's post        |
| LinkedIn | `Articles`                    | title and body                                       |

Saved and bookmarked categories are ticked by default; activity history is
opt-in, so importing does not sweep in an entire social-media history.

### Within-export cross-referencing

This is what makes a URL-only saved item findable. A LinkedIn Saved Item and a
Reactions row name the same post through different URL shapes
(`/feed/update/urn:li:activity:<id>` and `/posts/<handle>_<slug>-activity-<id>`),
so reducing both to the activity id lets one file supply text, another supply
the author, and a third supply a date — all from the same upload.

Files the user did not select are still read locally and may add context to the
items they did select; they never become items of their own. That behaviour is
a checkbox in the panel and can be switched off.

Records merge **only** on an equal content key, derived in this order:

```text
platform content id  →  provider permalink  →  canonical normalized URL
```

There is no fuzzy matching. Two posts with near-identical titles stay separate,
because a wrong merge destroys content silently while a missed merge only
leaves an item thinner than it could have been.

### Content availability

Every item is graded on what the export actually contained — a statement about
the file, never a judgement about the content:

- **full** — a substantial body (120+ characters of real text).
- **partial** — something descriptive: a title, a short comment, a subreddit.
- **reference_only** — a link, an id and a date, and nothing else.

A LinkedIn saved item that arrives as a bare URL is `reference_only` because
that is what LinkedIn shipped, and the UI says so rather than implying GRAPPlin
malfunctioned.

### Classification and embeddings

Classification is retrieval enrichment, not a source of truth. Before any
Gemini call, a deterministic gate requires at least 60 characters and 8 words of
real text — a subreddit name and an author handle are labels, not something a
model can summarise. Reference-only items are marked `insufficient_content` and
cost nothing.

Generated summary, topics, category, keywords and language are stored under
`metadata.generated`, never written into the source columns and **never** added
to the user's `tags`. The category comes from a small closed taxonomy; anything
a model invents outside it becomes `Other`.

Classification runs in bounded passes after the import, so items are visible and
keyword-searchable before any AI work finishes. A classification or embedding
failure leaves the item exactly as it was — keyword search keeps working.

### Search

Imported records are ordinary `saved_items` rows with `source = 'reddit'` or
`source = 'linkedin'`. They use the same `searchable_text`, the same generated
tsvector, the same 768-dimension Gemini embedding and the same
`hybrid_search_saved_items`. There is no parallel index and no parallel search
path.

### What is never done

- **No fetching.** GRAPPlin never visits reddit.com or linkedin.com for this
  feature, never uses a headless browser, never asks a model what a URL
  contains, and never inspects a cached preview. LinkedIn is registered as a
  restricted platform, so the generic website enrichment pipeline will not
  scrape a LinkedIn URL either.
- **No fabrication.** When an export supplies only a link, the item is stored
  `reference_only` with null content. A neutral display label like "Saved
  LinkedIn item" fills the title so the card is not blank; it is excluded from
  the search index and never shown to the classifier.
- **No overwriting.** Richer stored data is never replaced by a poorer import,
  an existing embedding is never discarded, and user notes and tags are never
  touched.
- **No timestamp invention.** A saved date, a creation date and an interaction
  date are stored in separate fields. Reddit's export dates no save, so that
  field stays null rather than borrowing the import time.

### Repeat imports and revert

Re-uploading the same export is safe. Identity is the content key stored in
`data_import_records`, so a permalink written two different ways still resolves
to one library row — and a post already synced from a connected Reddit account
is enriched in place rather than duplicated. Removing an import deletes only the
records it created; an item that also came from the connected account, or that
carries a note or a manual tag, survives.

The raw export is never uploaded and never stored. Only a SHA-256 fingerprint of
the file is kept, purely to recognise a repeat upload.

### Known limitations

- A Reddit saved post or comment that no other file in the same export mentions
  stays `reference_only` or `partial`: `saved_posts.csv` contains an id and a
  permalink and nothing more.
- A LinkedIn saved item whose post the user never reacted to, shared or
  commented on stays `reference_only` for the same reason.
- A future export schema that changes both its filenames _and_ its column
  shapes beyond recognition will be ignored safely rather than mis-parsed.
- Saved items pointing somewhere other than the platform itself are reported as
  unresolved rather than imported under a guessed identity.

## Getting the most out of a URL

A saved link is frequently _all_ GRAPPlin gets — LinkedIn's export hands over a
URL and a date, and Reddit's hands over a permalink and an id. `src/lib/urls/`
treats that URL as data rather than an opaque string, because
`reddit.com/r/rust/comments/abc123/why_async_is_hard` already names a platform,
a community, a stable id and most of a title.

Everything is derived from the URL string. **Nothing is fetched.** The same URL
always produces the same analysis.

`analyzeUrl(url)` returns:

| Field                  | What it answers                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `platform`             | Which service, from a registry of ~18                                                                           |
| `source`               | How that maps onto GRAPPlin's existing source union                                                             |
| `contentType`          | post, comment, video, article, repository, issue, paper, job, profile, package, track, document, image, search… |
| `contentId`            | The stable platform id, when the URL carries one                                                                |
| `author` / `community` | Who wrote it and where it lives                                                                                 |
| `titleFromSlug`        | Readable words decoded from the slug                                                                            |
| `dateFromPath`         | A publication date embedded as `/2024/05/12/`                                                                   |
| `descriptors`          | Everything else the pattern named: repo, issue number, playlist, start time                                     |
| `keywords`             | Retrieval terms mined from the path                                                                             |
| `restricted`           | Whether GRAPPlin must never fetch this URL                                                                      |
| `confidence`           | `high` (has an id) → `medium` (title or author) → `low` → `none`                                                |

### Why this matters for search

A reference-only LinkedIn item used to be an unfindable row. Now its slug,
community, content type and path keywords all reach `searchable_text`, so a
vague query has something real to hit — with no AI call and no network request.

### Ordinary websites are the common case

Most saved links are not on a platform we have rules for, so the generic
analyzer does the heavy lifting: it reads a date out of `/2024/05/12/`, decodes
a title from a trailing slug, recognises `/blog/`, `/docs/`, `/careers/` and
`/forum/` segments, classifies by file extension, and treats a trailing numeric
segment as an id. `example.com/blog/2024/05/12/why-rust-wins-on-embedded`
becomes an `article`, dated, titled "Why rust wins on embedded".

`analyzeUrl` never throws. Unusable input returns a `none`-confidence result,
because this runs over whole export files where one bad row must not stop the
rest.

## Reading an export whose schema we have never seen

Platform exports change shape without warning. When a JSON file in an export
matches no known column shape, `src/lib/data-import/json-records.ts` walks it
anyway and works out what each field _is_ from its name, its value shape, and
whether it parses as a URL.

Two rules govern it:

1. **Deny by default.** A field is only extracted if it earns a role — title,
   text, url, author, community, date or id. Anything unrecognised is dropped,
   not stored "just in case".
2. **Privacy first.** Contact details, credentials, locations, payment and
   device history are refused by key name _and_ by value shape, so a column
   called `note` holding an email address is still refused. Key names are
   tokenised (`viewerIp` → `viewer` + `ip`) so camelCase cannot smuggle a field
   past the filter, and every refusal is reported rather than silent.

Field roles are inferred, not configured:

```text
key name says "title"/"body"/"permalink"/"author"/"subreddit"  → that role
value parses as an http(s) URL                                 → a link
value looks like 2024-05-12, or the key mentions a date        → a timestamp
a long free-text value under any name at all                   → content
anything else                                                  → ignored
```

Recovered records are routed back through the **same** platform normalizers the
recognised files use, so a record rescued from an unknown layout lands on
exactly the same `saved_items` row as the same record arriving through a
recognised CSV. Recovery does not get its own identity rules.

A slug-decoded title is passed through with `titleSource: "permalink_slug"`
rather than as a `title` column, so nothing downstream can claim the platform
wrote words we decoded from a URL. Valid JSON that is simply not a dataset — a
settings blob, a manifest — is skipped silently rather than reported as
unreadable.

## Environment variables

```text
NEXT_PUBLIC_SUPABASE_URL=          # required
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY= # required
NEXT_PUBLIC_SITE_URL=http://localhost:3000 # recommended
GEMINI_API_KEY=                    # recommended for semantic search
GITHUB_TOKEN=                      # optional
GITHUB_APP_CLIENT_ID=               # required for GitHub account sync
GITHUB_APP_CLIENT_SECRET=           # required for GitHub account sync, server-only
GITHUB_TOKEN_ENCRYPTION_KEY=        # required for GitHub account sync, server-only
REDDIT_APP_CLIENT_ID=               # required for Reddit account sync
REDDIT_APP_CLIENT_SECRET=           # required for Reddit account sync, server-only
REDDIT_TOKEN_ENCRYPTION_KEY=        # required for Reddit account sync, server-only
REDDIT_USER_AGENT=                  # required for Reddit account sync
YOUTUBE_CLIENT_ID=                  # required for YouTube playlist sync
YOUTUBE_CLIENT_SECRET=              # required for YouTube playlist sync, server-only
YOUTUBE_TOKEN_ENCRYPTION_KEY=       # required for YouTube playlist sync, server-only
GEMINI_YOUTUBE_MODEL=               # optional; overrides the video analysis model
GEMINI_CLASSIFICATION_MODEL=        # optional; overrides the import classification model
SUPABASE_SECRET_KEY=                # required for GitHub and Reddit account sync, server-only
```

Do not expose server-only values through a `NEXT_PUBLIC_` variable.

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
6. Configure the GitHub App homepage and user authorization callback as described above, using the production origin.
7. Run `npx supabase db push` against the linked production Supabase project before first use.

Never expose a server-only key through `NEXT_PUBLIC_`. If any credential has appeared in chat, an issue, a terminal recording, or a public file, revoke and replace it before deploying.

## Current limitations

- Instagram, TikTok, X/Twitter, and Facebook saved-item syncing is not implemented. Users add these links manually with useful text.
- Generic HTML extraction is intentionally conservative and does not run JavaScript or crawl linked pages.
- Semantic quality depends on the configured Gemini embedding model and available API quota.
- Database/RLS integration checks require a configured Supabase project; unit tests cover deterministic local logic.
- There is no browser extension, mobile app, background queue, folder system, chat assistant, billing, or team workspace.

## Future architecture

Plausible later additions are a browser extension, mobile share sheet, user-assisted social export/import, YouTube integration, automated tagging, improved duplicate detection, and evaluated reranking. None are part of this MVP.
