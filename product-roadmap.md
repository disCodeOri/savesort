# Product Roadmap — Saved Content Search Engine

**Scope:** software/product only. See `business-gotchas-and-roadmap.md` for the business-side plan — the two run on parallel but different timelines.

**Guiding rule:** every phase must still pass the MVP's own test — *"can a user recover something they knew they saved but couldn't remember where?"* Nothing below should ship at the cost of that.

Effort estimates assume a small team (1–3 engineers). S = days, M = 1–2 weeks, L = 3–5 weeks, XL = 6+ weeks / needs its own mini-project.

---

## Phase 0 — MVP (prove retrieval works)

Goal: validate the core hypothesis with the smallest possible surface area. Nothing here should be skipped; nothing beyond it should be added yet.

| Feature | Effort | Notes |
|---|---|---|
| Auth + account creation | S | Standard. |
| GitHub Stars connector | M | Official API, well-documented, good first integration. |
| Reddit Saves connector | M | Official API; watch rate limits. |
| YouTube saved/playlists connector | M | Requires OAuth verification lead time — start early (see business doc). |
| Notion connector | M–L | Notion's API model (databases/pages) is messier to normalize than the others. |
| Manual URL + text import | S | Cheap insurance against connector delays; also your fallback demo path. |
| Content normalization (`SavedItem` model) | M | Get this schema right early — everything downstream depends on it. |
| Enrichment pipeline (summary, topics, categories, embeddings) | L | The core value-add. Budget real time here. |
| Hybrid search (semantic + keyword + rerank) | L | Don't skip keyword search — technical users search exact repo/library names. |
| Search UI (query box, results, source filter) | M | Keep it search-first, per the spec. |
| "Why it matches" explanation per result | M | High trust payoff for relatively low effort — keep this. |
| Data isolation / delete / disconnect | M | Non-negotiable, do it now not later (see business doc, privacy section). |

**Exit criteria for Phase 0:** a test cohort of ~20–30 real users (ideally your wedge audience — see business doc) can connect 2+ sources and report that search found something they'd forgotten, more than once, without prompting.

---

## Phase 1 — v1.1: Retention & Stickiness

This is the phase most similar products skip, and it's the one that determines whether you end up like Recall (sticky) or early Rewind (novel, then abandoned). Nothing here is about search quality — it's about giving people a reason to open the app without a specific memory to chase.

| Feature | Effort | Notes |
|---|---|---|
| **Resurfacing / nudge loop** (see design below) | L | Highest-leverage retention feature. Build this before more integrations. |
| Saved / standing searches | M | Pin a query, get notified when new saves match it. Converts search into a persistent thread. |
| Dead-link / content-rot detection | M | Flag saves whose source has been deleted/made private; where feasible, cache extracted text so the save stays useful even if the link dies. |
| Browser extension (contextual sidebar) | L–XL | Liner-style: "you saved something related to this page." Big lift, big differentiation — the thing most competitors don't do well. |
| Metadata filters (source, date, category, topic) | S–M | Mentioned in spec as "eventual" — pull it forward, it's cheap and users will want it fast. |
| Duplicate detection across sources | M | Same article saved via Reddit and manually — collapse or link them. |

### The resurfacing loop — design sketch

The core mechanic: turn a pull-only product (search) into one with a push-based habit loop, without becoming spammy.

**Trigger types** (start with 1–2, expand later):
1. **Time-based digest** — weekly email/notification: "3 things you saved that might be worth revisiting," selected by recency + low open-rate (surface things they saved but never opened).
2. **Context-based** (needs the browser extension) — while reading a page or repo, silently check for embedding-similarity matches in their saved corpus above a relevance threshold; show a small non-intrusive "related saves" affordance, not a popup.
3. **Cluster-based** — when the enrichment pipeline detects a new save strongly overlaps an existing topic cluster (e.g., 4th save tagged "design systems"), prompt: "You've saved 4 things about this — want a synthesis?" This doubles as a soft upsell into the synthesis feature (Phase 2).

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
| Cross-item synthesis ("your saves consistently suggest X, Y, Z") | L | Was "secondary" in the spec — promote it. This is your strongest differentiator for the builder/dev wedge. |
| Lightweight knowledge graph (recurring entities/topics/people across saves) | XL | High value, high effort — sequence after synthesis, which delivers similar value more cheaply. |
| Global quick-capture + search (omnibar / keyboard shortcut) | M–L | Raycast/Spotlight-style. Reduces capture friction, which is currently 100% dependent on the source platform's own "save" button. |
| Mobile share-sheet capture (iOS/Android) | M | Lets users save directly into the product from any app, not just from connected sources. |
| Additional connectors: Obsidian, Apple Notes, browser bookmarks, Google Keep | M each | Prioritize by what your actual users request — don't build all of these speculatively. |
| Instagram/Reels, LinkedIn (via scraping) | L, **legal review required first** | See business doc — do not schedule this without a ToS/legal decision. |

---

## Phase 3 — Expansion (only after Phase 2 is validated)

Treat these as separate bets, not a natural continuation — each deserves its own go/no-go decision:

- **Team/shared version** — shared saves for a team, with permissions. Different product (multi-tenant, admin controls, likely a different buyer).
- **Broader personal knowledge layer** (per spec Section 22) — documents, highlights, conversations. This is the "PKM system" the MVP doc explicitly said not to become yet — revisit only once retention is proven, not before.
- **People-search / network layer** (the Happenstance-style idea from the original brain-dump) — genuinely a different product with a different buyer and different data model. Don't bolt it onto this one; if you want to pursue it, spin it up as a separate initiative.

---

## Suggested sequencing summary

```
Phase 0 (MVP)        →  prove retrieval works
Phase 1 (Retention)  →  prove people come back
Phase 2 (Depth)       →  prove you're hard to replace
Phase 3 (Expansion)  →  separate bets, separate decisions
```

Do not start Phase 2 work until Phase 1's retention loop shows measurable engagement — depth features are wasted on a product nobody re-opens.
