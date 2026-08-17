# GRAPPlin — Product Roadmap
*(formerly SaveSort)*

**Scope:** software/product only. See `business-gotchas-and-roadmap.md` for the business-side plan — the two run on parallel but different timelines.

**Guiding rule:** every phase must still pass the MVP's own test — *"can a user recover something they knew they saved but couldn't remember where?"* Nothing below should ship at the cost of that.

Effort estimates assume a small team (1–3 engineers). S = days, M = 1–2 weeks, L = 3–5 weeks, XL = 6+ weeks / needs its own mini-project.

**Platform note (Aug 2026):** GRAPPlin is mobile-first on iOS and Android, with a companion web app. That's a real sequencing change from the original draft of this roadmap, which treated mobile capture as a Phase 2 nice-to-have. It isn't — it's the primary way most users will ever add something to GRAPPlin, so it moves to Phase 0. See "Capture strategy" below.

**Market context (Aug 2026):** Pocket shut down in July 2025 and scattered its user base across a new wave of tools. Several of them — Marqly, mymind, BeeMind — already sell semantic "search by what you remember" as their core hook. Treat that as table stakes now, not a differentiator. GRAPPlin's actual edges are: a developer/builder-flavored source set (GitHub Stars specifically — none of the reading-focused competitors touch it), true mobile-first frictionless capture, the resurfacing loop, and the connection graph. Every priority call below is made in favor of those four things.

---

## Phase 0 — MVP (prove retrieval works)

Goal: validate the core hypothesis with the smallest possible surface area. Nothing here should be skipped; nothing beyond it should be added yet.

### Capture strategy (mobile-first)

The original ask behind this was "a floating icon so I never have to open the app to save something." The real, both-platform-safe version of that:

- **Share Sheet / Share Extension integration is the actual Phase 0 capture mechanism**, not manual paste. User is in Instagram, YouTube, Reddit, or a browser, taps the native Share button, GRAPPlin is right there, one tap, done. No special permissions, no App Store risk, works identically on iOS and Android.
- **A true floating "chat head" bubble is Android-only and belongs in Phase 1, opt-in.** iOS has no equivalent capability at all — it isn't a policy restriction, it's structural (no third-party app can draw a persistent overlay over other apps on iOS). Never let the core capture flow depend on it, or iOS users get a permanently worse product.
- **For Instagram and TikTok specifically, Share Sheet capture isn't a nice-to-have layered on a "real" connector — it's the only compliant ingestion path that will ever exist.** Meta closed third-party read access to personal accounts' saved content in December 2024; nothing in Instagram's or TikTok's current API surface exposes a user's saved/favorited collection to a third party. This also happens to be exactly what `AGENTS.md`'s "never scrape restricted platforms" rule already requires — the compliant path and the good-UX path are the same path here.

| Feature | Effort | Notes |
|---|---|---|
| Auth + account creation | S | Standard. |
| **Share Sheet / Share Extension capture (iOS + Android)** | M | **Moved up from Phase 2.** This is the primary capture mechanism for the whole product, not a later polish item — covers Instagram, TikTok, YouTube, Reddit, and any app with a native Share button. |
| GitHub Stars connector | M | Official API, well-documented, good first integration. Unaffected by anything below. |
| Reddit Saves connector | M | Official API — but as of June 2026, Reddit's Responsible Builder Policy requires prior approval before *any* API access, even free tier. Developers are reporting 2–4 week approval queues. Start the approval process immediately, in parallel with other Phase 0 work, not when you're ready to build the connector. |
| YouTube saved/playlists connector | M | Watch Later, Liked Videos, and user playlists are readable via OAuth with the right scope — confirmed still accurate. Google gates sensitive-scope apps behind its own verification review before real users can use it. Start that process early (see business doc). |
| Notion connector | M–L | Notion's API model (databases/pages) is messier to normalize than the others. |
| Manual URL + text import | S | Cheap insurance against connector delays; also your fallback demo path and the desktop-equivalent capture method. |
| **Capture intent ("why" note)** | S | At the moment of Share Sheet capture, offer one optional field — a one-line note or short voice memo answering "why does this matter?" Skippable in one tap. This is cheap to build now and expensive to retrofit later: the value compounds the longer you've been collecting it, and it's the seed data for Trails (Phase 1). Ship it even if Trails itself ships later. |
| Content normalization (`SavedItem` model) | M | Get this schema right early — everything downstream depends on it. Add a field for captured intent alongside content/summary. |
| Enrichment pipeline (summary, topics, categories, embeddings) | L | The core value-add. Budget real time here. |
| Hybrid search (semantic + keyword + rerank) | L | Don't skip keyword search — technical users search exact repo/library names. |
| Search UI (query box, results, source filter) | M | Keep it search-first, per the spec. |
| "Why it matches" explanation per result | M | High trust payoff for relatively low effort — keep this. |
| **First-run bulk import on connect** | S | When a user connects GitHub (or any connector), backfill their *existing* stars/saves immediately, not just future ones. The "it already found something I forgot" moment has to happen in session one or it doesn't happen. |
| Data isolation / delete / disconnect | M | Non-negotiable, do it now not later (see business doc, privacy section). |
| **One-tap full data export** | S | Small build, outsized trust payoff right now specifically: the users you're recruiting from are the ones Pocket's July 2025 shutdown just stranded, and "will this die and strand me too" is a live, specific fear in this market this year. Make export obvious, not buried in settings. |

**Exit criteria for Phase 0:** a test cohort of ~20–30 real users (ideally your wedge audience — see business doc) can connect 2+ sources, capture via Share Sheet without friction, and report that search found something they'd forgotten, more than once, without prompting.

---

## Phase 1 — v1.1: Retention & Stickiness

This is the phase most similar products skip, and it's the one that determines whether you end up like Recall (sticky) or early Rewind (novel, then abandoned). Nothing here is about search quality — it's about giving people a reason to open the app without a specific memory to chase.

| Feature | Effort | Notes |
|---|---|---|
| **Resurfacing / nudge loop** (see design below) | L | Highest-leverage retention feature. **Don't let this wait for retrieval to fully prove itself first** — the #1 failure mode in this category isn't bad search, it's a user who saves once and never reopens the app. Pull this earlier than "after Phase 0 fully validates" if you can. |
| **Trails — narrative synthesis of a saved cluster** | L | New. A short chronological story connecting the saves in one topic cluster ("this Reddit thread → led you to star this repo → then this video"), built from the captured-intent notes plus light AI connective synthesis where intent wasn't captured. Directly extends the cluster-based trigger below rather than being a separate system. Stays inside the MVP doc's existing "secondary synthesis" allowance — bounded generation over the user's own retrieved items, not open-ended chat. Optional, off-by-default sharing (export a single trail as a link/image) is a real organic-growth lever — nobody else in this space does this — but must never become a social feed inside the app; no follows, no browsing other users' trails. |
| **Android floating capture bubble (opt-in)** | M | The literal "chat heads" experience — a persistent floating icon over other apps. Real, shippable, Android-only (`SYSTEM_ALERT_WINDOW` / "Display over other apps"). Ship as an advanced, opt-in setting, clearly justified in the Play Console listing — it's a flagged "sensitive permission" tied to overlay-malware patterns, so it should never be required or default-on. Genuine Android-only differentiator; iOS has no equivalent and never will. |
| **Quick-capture widgets** | S–M | Home screen widget, iOS Lock Screen widget, Siri Shortcut / Android Quick Settings tile for one-tap "paste and save," plus a foreground-only clipboard check on app open ("we noticed you copied a link — save it?"). Foreground-only by design; background clipboard reading is restricted on both OSes now. Cheap, and each one is another daily touchpoint. |
| Saved / standing searches | M | Pin a query, get notified when new saves match it. Converts search into a persistent thread. |
| Dead-link / content-rot detection | M | Flag saves whose source has been deleted/made private; cache extracted text so the save stays useful even if the link dies. **Weight this higher than effort alone suggests** — GRAPPlin's sources lean social (Reels, Reddit posts), which get taken down far more often than a GitHub repo does. A save that 404s is worse than useless, it's a broken promise. |
| Browser extension (contextual sidebar) | L–XL | Liner-style: "you saved something related to this page." Big lift, big differentiation — the thing most competitors don't do well. |
| Metadata filters (source, date, category, topic) | S–M | Mentioned in spec as "eventual" — pull it forward, it's cheap and users will want it fast. |
| Duplicate detection across sources | M | Same article saved via Reddit and manually — collapse or link them. |

### The resurfacing loop — design sketch

The core mechanic: turn a pull-only product (search) into one with a push-based habit loop, without becoming spammy.

**Trigger types** (start with 1–2, expand later):
1. **Time-based digest** — weekly email/notification: "3 things you saved that might be worth revisiting," selected by recency + low open-rate (surface things they saved but never opened).
2. **Context-based** (needs the browser extension) — while reading a page or repo, silently check for embedding-similarity matches in their saved corpus above a relevance threshold; show a small non-intrusive "related saves" affordance, not a popup.
3. **Cluster-based** — when the enrichment pipeline detects a new save strongly overlaps an existing topic cluster (e.g., 4th save tagged "design systems"), prompt: "You've saved 4 things about this — want a synthesis?" **This is now the direct on-ramp into Trails** (above), not just a soft upsell line — the prompt can open the generated trail itself instead of a generic offer.
4. **Capture-time connections** — surface the graph the moment a new save comes in, not just on a schedule: "you already saved 3 things about this." Cheapest version of context-based resurfacing, since it reuses the embedding you just computed for the new item — no extension required. Worth pulling into the MVP of this feature even before #2.

**Mechanics:**
- Compute via a scheduled job over each user's embedding space — no real-time infra needed for the time-based version.
- User-controlled frequency and an easy off-switch from day one — nudge fatigue kills this feature faster than anything else.
- Track engagement on nudges as a core metric (see business doc, Section 7) — if open/click rate on digests trends toward zero, the loop isn't working and needs redesign, not more triggers.

**Why this order:** context-based resurfacing (via the extension) is the most valuable version but the most expensive to build. Ship the time-based digest first — it validates whether resurfacing drives re-engagement at all before you invest in the extension.

---

## Phase 2 — v2: Depth & Differentiation

By this point search + retention loop should be validated. This phase is about becoming genuinely hard to replace.

| Feature | Effort | Notes |
|---|---|---|
| Cross-item synthesis ("your saves consistently suggest X, Y, Z") | L | Was "secondary" in the spec — promote it. On-demand complement to Trails (Phase 1): Trails tells the story of one cluster automatically, this answers an open question across the whole library on request. |
| Lightweight knowledge graph (recurring entities/topics/people across saves) | XL | High value, high effort — but Trails (Phase 1) already needs a lightweight version of this (a two-table Postgres entity/edge model), so a fair amount of this may already exist by the time you get here. Re-scope down before treating it as a fresh XL project. |
| Global quick-capture + search (omnibar / keyboard shortcut) | M–L | Raycast/Spotlight-style, desktop-focused. The mobile equivalent (widgets, quick-capture) already shipped in Phase 1 — this is the desktop counterpart. |
| **Bidirectional PKM sync** | M | New. Push a saved item's summary or its Trail back into Notion/Obsidian, not just pulling from them — a pattern a couple of the AI-native competitors (Readwise Reader) lean on. Not previously scoped; worth a look once the pull-side connectors are solid. |
| Additional connectors: Obsidian, Apple Notes, browser bookmarks, Google Keep | M each | Prioritize by what your actual users request — don't build all of these speculatively. |
| ~~Instagram/Reels, LinkedIn (via scraping)~~ | — | **Removed, not just deferred.** This was never actually gated on legal review — it's gated on there being no compliant API for it at all. Meta shut off third-party read access to a personal account's saved content in December 2024, and `AGENTS.md` already permanently forbids scraping restricted platforms. Instagram/TikTok content comes into GRAPPlin exclusively through Phase 0 Share Sheet capture. Don't schedule a "connector" for these — there isn't one to build. |
| ~~Mobile share-sheet capture (iOS/Android)~~ | — | **Moved to Phase 0.** This is the primary capture mechanism for the product now, not a later-phase nicety — see the top of Phase 0. |

---

## Phase 3 — Expansion (only after Phase 2 is validated)

Treat these as separate bets, not a natural continuation — each deserves its own go/no-go decision:

- **Team/shared version** — shared saves for a team, with permissions. Different product (multi-tenant, admin controls, likely a different buyer).
- **Broader personal knowledge layer** (per spec Section 22) — documents, highlights, conversations. This is the "PKM system" the MVP doc explicitly said not to become yet — revisit only once retention is proven, not before.
- **People-search / network layer** (the Happenstance-style idea from the original brain-dump) — genuinely a different product with a different buyer and different data model. Don't bolt it onto this one; if you want to pursue it, spin it up as a separate initiative.
- **Cross-user collaborative signal ("people who saved similar things also saved X")** — new, flagged. The single highest network-effect-upside idea discussed so far, and the one in the most direct tension with GRAPPlin's private-by-default positioning — this would be a deliberate departure from the single-user "self-similarity surfacing" approach assumed everywhere else in this roadmap. Only worth considering after Trails is validated, and only as aggregate, anonymized, opt-in — never a default, never exposing another user's individual data.

---

## Suggested sequencing summary

```
Phase 0 (MVP)        →  prove retrieval works, and prove capture is frictionless
Phase 1 (Retention)  →  prove people come back
Phase 2 (Depth)       →  prove you're hard to replace
Phase 3 (Expansion)  →  separate bets, separate decisions
```

Do not start Phase 2 work until Phase 1's retention loop shows measurable engagement — depth features are wasted on a product nobody re-opens.
