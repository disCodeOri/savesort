# SaveSort Desktop (Windows)

A background sync client that keeps a local Obsidian vault mirrored into the
SaveSort web app. It runs in the system tray, watches the vault for changes, and
uploads Markdown notes through an authenticated sync API.

This is a **one-way local → cloud** sync in v1. The client never writes to your
vault.

## Architecture

The layers are deliberately decoupled: a filesystem event never triggers an HTTP
request directly. Everything passes through a durable queue, which is what makes
the client crash-safe and offline-capable.

```text
Obsidian vault (local files)
        ↓
watcher/     notify → debounce → coalesce → stability wait
        ↓
sync/        normalize into logical operations
        ↓
storage/     SQLite: file manifest + durable operation queue
        ↓
sync/worker  drains the queue, exponential backoff on failure
        ↓
api/         authenticated HTTPS client
        ↓
SaveSort backend  /api/sync/*
```

### Why each layer exists

**Debounce and stability wait.** Windows emits several events for one save, and
an editor may still be writing when the first event arrives. The watcher waits
for a file's size and modified time to stop changing before reading it, so a
half-written note is never uploaded.

**Content hashing over timestamps.** Filesystem timestamps are unreliable for
deciding whether contents actually changed — touching a file, restoring a
backup, or syncing a folder all move the timestamp without changing a byte. The
client hashes content and compares against the last synced hash, so unchanged
files are never re-uploaded.

**Stable file identity.** Each note gets a client-generated UUID on first
discovery, stored in SQLite. Identity is that id, not the path, so renaming or
moving a note is an update rather than a delete plus a re-create — the note keeps
its history and its place in the web app.

**Durable queue.** Operations are committed to SQLite before any upload is
attempted, and only marked complete after the server confirms. A crash mid-upload
leaves the operation queued, and the retry is safe because the server treats an
identical content hash as a no-op.

**Reconciliation scan.** Filesystem watchers miss events — during sleep, on
network drives, under heavy load. A periodic full scan compares local hashes
against the local manifest and the server's `/api/sync/changes` manifest, and
queues anything that drifted. Events are the fast path; reconciliation is the
correctness guarantee.

## Authentication

The client is a public OAuth client and ships **no secrets**.

```text
App generates PKCE verifier + challenge
        ↓
App starts a loopback listener on 127.0.0.1:<ephemeral port>
        ↓
Opens browser → /desktop/authorize?redirect_uri=…&code_challenge=…
        ↓
User approves in the web app (using their existing session)
        ↓
Browser redirects to the loopback listener with a one-time code
        ↓
App exchanges code + verifier at /api/desktop/token
        ↓
Access token (1h) + refresh token (60d), rotated on every refresh
```

Tokens are opaque random strings, stored in **Windows Credential Manager** via
the `keyring` crate — never in a file, never in the registry, never in logs. The
server stores only their SHA-256 digests.

Signing out revokes that device alone; browser sessions are unaffected.

## What syncs

Markdown (`.md`) files only in v1. The exclusion list is configurable in
settings and defaults to:

```text
.obsidian/
.trash/
.git/
node_modules/
*.tmp, *.swp, *~     (editor scratch files)
```

Attachments (images, PDFs, audio) are out of scope for v1. The file-type
handling is behind a trait so they can be added without reworking the queue.

## Conflict handling

Every note carries a server-assigned revision. The client sends the revision its
upload was based on; if the server has moved on, it returns `conflict` with its
current hash instead of overwriting. The client keeps the local file untouched,
marks the note as needing attention in the tray, and surfaces it in the error
list. **Local content is never destroyed to resolve a conflict.**

## Project layout

The sync engine lives in its own crate with **no Tauri dependency**, so
`cargo test -p savesort-core` verifies the entire engine in seconds without
building a webview. The Tauri crate is a thin OS-integration shell on top.

```text
windows-client/
  core/                   savesort-core — the sync engine (83 tests)
    src/
      hashing.rs          SHA-256, byte-identical to the server's hash
      backoff.rs          5s → 15s → 30s → 1m → 2m → 5m retry schedule
      storage/
        schema.rs         SQLite DDL
        manifest.rs       file identity, hashes, revisions
        queue.rs          durable queue: coalescing, leases, retries
      watcher/
        exclude.rs        configurable exclusion rules
        debounce.rs       per-path event coalescing (deterministic clock)
        scan.rs           full vault walk + hashing
      auth/
        pkce.rs           RFC 7636 S256 challenge generation
        token_store.rs    TokenStore trait + in-memory implementation
        client.rs         /api/desktop/token exchange and refresh
      sync/
        protocol.rs       wire types mirroring the server schemas
        api.rs            SyncApi trait + reqwest implementation
        reconcile.rs      scan-vs-manifest diff (incl. move detection)
        worker.rs         processes one queued operation end to end
  src-tauri/              savesort-desktop — the OS shell
    src/
      main.rs             setup, background reconcile loop, HTTPS guard
      commands.rs         the Tauri command surface
      engine.rs           wires storage + api + auth together
      state.rs            sync phases and status snapshots
      watch.rs            notify watcher + stability check
      tray.rs             tray icon, menu, status line
      auth_flow.rs        loopback listener for the PKCE redirect
      keyring_store.rs    Windows Credential Manager token storage
      settings.rs         vault path, exclusions, pause, startup
      logging.rs          structured JSON logs, daily rotation
  src/                    dashboard UI (vanilla HTML/CSS/JS)
  fixtures/               generated test vault (gitignored)
```

### A note on how the watcher and reconciliation relate

The watcher never translates an individual filesystem event into an individual
queue operation. It only decides **when** to look; the reconciliation diff
decides **what** changed, by comparing content hashes against the manifest.

That is what makes duplicated, out-of-order, or entirely missed events
harmless: both the live watcher and the 5-minute periodic scan run the exact
same `reconcile → drain` path, so there is one correctness mechanism rather
than two that can disagree.

## Prerequisites

- Rust (stable, MSVC toolchain) — <https://rustup.rs>
- Visual Studio Build Tools with the **Desktop development with C++** workload
- Node.js 20+

## Build and run

```bash
cd windows-client
npm install
npm run dev
```

The client defaults to production (`https://grapplin.vercel.app`). Point it at
a dev server with an environment variable:

```bash
$env:SAVESORT_BASE_URL="http://localhost:3000"; npm run dev
```

This one variable governs every network path — sign-in, sync, and the tray's
*Open dashboard* link — so a dev build never talks to production by accident.

Only `https://` origins are accepted, except for `127.0.0.1` and `localhost`
so local development works. A misconfigured value falls back to the default
rather than sending notes over an unencrypted connection.

The app starts in the tray with **no window** — a background sync utility
should not pay for a webview until you open the dashboard. Click the tray icon
and choose *Open dashboard*. Closing the dashboard hides it; quitting is an
explicit tray action.

## Test

```bash
cd windows-client
cargo test --workspace
```

Generate the fixture vault first — the scanner tests read it directly:

```bash
pwsh -File ../scripts/generate-obsidian-test-vault.ps1 -VaultRoot ./fixtures/ObsidianTestVault
```

The suite covers:

- **Filesystem**: nested folders, unicode folder and file names (Japanese,
  emoji), a 920KB note, a zero-byte note, exclusion of `.obsidian`/`.trash`,
  and skipping non-Markdown attachments — all against the real fixture vault
- **Queue durability**: a lease left behind by a crashed process is reclaimed
  on reopen; state survives closing and reopening the database
- **Coalescing**: rapid repeated edits collapse to one operation; a delete
  after a queued upsert replaces it rather than stacking
- **Retry**: the exact backoff schedule, requeue-with-incremented-attempt, and
  invisibility until the scheduled retry time
- **Idempotency**: an unchanged content hash is a no-op that never duplicates
- **Conflicts**: a stale `baseRevision` leaves the local file untouched and
  stops retrying rather than looping
- **Reconciliation**: new/changed/deleted detection, plus move detection when a
  path disappears and identical content appears elsewhere
- **Auth**: PKCE challenge correctness, token exchange and refresh against a
  mock HTTP server, and 401/429/404 error mapping

Lint with `cargo clippy --workspace --all-targets -- -D warnings`.

## Release build

```bash
npm run tauri build
```

Produces an MSI installer in `src-tauri/target/release/bundle/msi/`.

## Logging and privacy

Logs are structured and written to `%LOCALAPPDATA%\SaveSort\logs\`. They record
operation ids, file ids, paths, status codes, error categories, retry counts,
and durations — **never note contents and never tokens**. Export them from the
tray menu under *Help → Export diagnostics*.
