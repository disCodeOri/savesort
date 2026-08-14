# Technical Architecture Blueprint — Building the Search Engine From Scratch

## The core idea

What you're describing isn't one system, it's three systems that Google, Instagram, and LinkedIn/Happenstance each built separately, borrowed and shrunk down to personal scale:

| Company | What they actually built | What it becomes here |
|---|---|---|
| **Google** | Relevance ranking over a huge, mostly-anonymous corpus | Relevance ranking over one person's saved items |
| **Instagram** | Personalized ranking of what to show *you specifically*, unprompted | The resurfacing/nudge engine — proactively showing the right save at the right moment |
| **LinkedIn / Happenstance** | A graph of entities and relationships, with path-finding between them | A graph of topics/technologies/entities connecting your saves to each other |

A good version of this product needs a lightweight version of all three, not just search. Below is how each maps over, then the actual architecture, then a concrete build order.

---

## 1. What to borrow from Google

Google's stack, translated:

| Google concept | What it does there | Equivalent here |
|---|---|---|
| Crawling | Discovers pages across the web | **Connectors** — pull saved items from GitHub, Reddit, YouTube, Notion |
| Indexing | Builds a searchable structure from crawled pages | **Enrichment + dual index** — embeddings + keyword index built from each saved item |
| PageRank (link-based authority) | Pages linked-to by many authoritative pages rank higher | **Personal authority signal** — items you've revisited, or items other saved items reference/co-occur with, rank higher than a save you touched once and forgot |
| Query understanding | Parses intent from a search string | **Intent parsing** — turn "that video about databases handling millions of writes" into a structured retrieval query |
| Ranking signal fusion | Combines hundreds of signals into one score | **Hybrid scoring function** — combine semantic relevance + keyword match + personal authority + recency |

The one thing to actually copy: **Google never relies on a single signal.** Don't build this as "embeddings only" — combine semantic + keyword + a authority/engagement signal, exactly like Google combines relevance + PageRank instead of picking one.

## 2. What to borrow from Instagram

Instagram's real innovation wasn't search — it was realizing that **ranking what to show someone unprompted** is a different, harder problem than ranking search results.

| Instagram concept | What it does there | Equivalent here |
|---|---|---|
| Feed ranking (not reverse-chronological) | Predicts what you'd want to see next, not just what's newest | **Resurfacing engine** — the weekly digest / contextual "you saved something related to this" (from the earlier product roadmap) |
| Engagement signals (dwell time, likes, shares) | Trains the ranking model on what actually gets attention | **Your own engagement signals** — which saves you open, which you re-search for, which you ignore repeatedly |
| Collaborative filtering ("accounts you might like") | Surfaces things similar users engaged with | **Self-similarity surfacing** — items similar to what you've engaged with recently, pulled from your own corpus |
| Embedding-based recommendation | Ranks candidates by embedding similarity to your taste profile | Same technique, just scoped to one person's saved corpus instead of a billion-user graph |

The one thing to actually copy: **search-only products are pull-based and Instagram-style products are push-based.** You need both — this is the resurfacing loop from the product roadmap, and it's the single highest-leverage feature for retention, not an optional extra.

## 3. What to borrow from LinkedIn and Happenstance

These two are really the same underlying idea, applied to people. Applied to *your saved knowledge* instead of people:

| LinkedIn/Happenstance concept | What it does there | Equivalent here |
|---|---|---|
| Graph of nodes (people) and edges (connections) | Models relationships between people | **Knowledge graph** — nodes are entities/topics/technologies extracted from your saves, edges are co-occurrence across items |
| "People you may know" (2nd/3rd-degree connections) | Surfaces people you're indirectly connected to | **Indirect resurfacing** — saves that are two hops away from what you're currently looking at, even if they don't share obvious keywords |
| Entity/profile pages | Aggregates everything connected to one person/company | **Topic pages** — "everything you've saved about Postgres," auto-generated from the graph |
| Six-degrees path-finding | Finds the shortest path between two people through the network | **Connection paths** — "here's the chain: this Reddit post led you to star this repo, which relates to this YouTube video" |

The one thing to actually copy: **the graph is what turns isolated search results into a browsable, explorable structure.** Once you have entities extracted from every saved item, you get topic pages, connection paths, and indirect resurfacing almost for free — this is genuinely your highest-differentiation feature relative to competitors, most of whom stop at plain semantic search.

---

## 4. The actual architecture

```text
                          CONNECTORS
        (GitHub · Reddit · YouTube · Notion · Manual import)
                              │
                              ▼
                     CONTENT NORMALIZER
                    (unified SavedItem schema)
                              │
                              ▼
                    ENRICHMENT PIPELINE
        ┌─────────────┬─────────────┬─────────────┐
        ▼             ▼             ▼             ▼
     Summary        Topics       Entities      Embedding
        │             │             │             │
        └─────────────┴──────┬──────┴─────────────┘
                              ▼
              ┌───────────────┴────────────────┐
              ▼                                 ▼
      DUAL SEARCH INDEX                  KNOWLEDGE GRAPH
   (dense vectors + keyword/            (entity nodes +
    sparse index, hybrid)              co-occurrence edges)
              │                                 │
              └───────────────┬─────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                                              ▼
   QUERY-TIME PATH                          BACKGROUND PATH
  (user types a search)                  (scheduled, no query)
        │                                              │
        ▼                                              ▼
  Query understanding                       RESURFACING ENGINE
        │                                    (Instagram-style
        ▼                                     candidate ranking:
  Hybrid retrieval                            embedding similarity
  (dense + keyword)                           + graph proximity +
        │                                     recency + low-
        ▼                                     engagement boost)
  Graph expansion                                     │
  (pull in connected items)                            ▼
        │                                     Digest / contextual
        ▼                                     nudge delivery
  Re-ranking
  (relevance + personal
   authority + recency)
        │
        ▼
  Explanation generation
  ("why it matches")
        │
        ▼
     RESULTS
```

Two things worth noticing about this diagram: the enrichment pipeline runs once per saved item (cheap, async, off the critical path), while the query-time path has to be fast — this split matters for both cost and latency, covered below.

---

## 5. Component-by-component build plan

### Connectors
Pull only content the user explicitly saved (per the MVP boundary doc) — GitHub Stars, Reddit Saves, YouTube saved/playlists, Notion pages, manual import. Normalize everything into one `SavedItem` schema regardless of source.

### Enrichment pipeline
For each saved item, generate (via LLM call, async, batched):
- A short summary
- Topic/category tags
- Extracted entities (technologies, people, projects, concepts mentioned)
- An embedding vector

This is where most of your per-item compute cost lives — batch it, don't do it synchronously on save.

### Dual search index (the Google layer)
Hybrid search — dense vector similarity plus keyword/sparse matching — is now the standard approach rather than pure semantic search, because keyword precision still matters for exact terms (library names, error strings, usernames) that embeddings alone often miss. Current practical options:

- **Simplest MVP path:** Postgres + `pgvector` for dense vectors, combined with Postgres full-text search for the keyword side. One database, one system to operate, good enough for a single-user-scoped corpus at MVP scale.
- **Dedicated vector DB, if you outgrow Postgres:** Qdrant or Weaviate both support hybrid dense+sparse search natively in one query, which removes the need to bolt on a separate keyword engine like Elasticsearch. Pinecone is the managed option if you'd rather not run infrastructure at all.
- **Embeddings:** OpenAI's `text-embedding-3-large` or Voyage AI's `voyage-3.5` are strong general-purpose managed options; `BGE-M3` is a solid open-source alternative if cost-per-embedding or data privacy (not sending saved content to a third-party embedding API) matters to your positioning — worth weighing given the privacy story is one of your stated differentiators.

### Knowledge graph (the LinkedIn/Happenstance layer)
For MVP scale, you do not need a dedicated graph database — model it as two Postgres tables: `entities` (deduplicated topics/technologies/people extracted across all items) and `item_entity_edges` (which items mention which entities, with a weight). This gets you topic pages and "related items" for free without new infrastructure.

At real scale, or once you want multi-hop path-finding (the "connection chain" feature), migrate this layer to a dedicated graph database like Neo4j, which is built specifically for traversal queries ("find all items within 2 hops of this one") that get slow in a relational join model.

**The entity-resolution problem, flagged early:** "Postgres," "PostgreSQL," and "postgres" all need to collapse to one graph node, or the graph fragments into noise instead of useful structure. Budget real design time for entity normalization — it's the difference between a genuinely useful graph and a messy one.

### Query engine (query-time path)
1. Parse the natural-language query, understand intent.
2. Run hybrid retrieval (dense + keyword) to get a candidate set.
3. Expand candidates using the graph — pull in items connected to the top hits even if they didn't directly match the query text. This is the "LinkedIn 2nd-degree" move and it's what catches the Reddit post that's relevant but doesn't share vocabulary with the query.
4. Re-rank the combined candidate set using relevance score + personal authority signal (how often the user's revisited/engaged with this item) + recency.
5. Generate the "why it matches" explanation per result (short LLM call, or precomputed if latency matters).

### Resurfacing engine (background path, the Instagram layer)
A scheduled job, not a query-time feature. Periodically scans the corpus and:
- Finds items with high embedding similarity to what the user's saved or searched recently
- Finds items that are graph-adjacent to recent activity but haven't been surfaced
- Deprioritizes items already opened recently (don't resurface what's already been seen)
- Ranks candidates and sends the top few as a digest or contextual nudge

This has a **cold-start problem worth planning for explicitly**: with no engagement history yet, you can't do real collaborative-filtering-style ranking. Start with simple heuristics (recency + topic clustering) and only move to a learned ranking model once you have enough click/open data to train on — trying to build the sophisticated version on day one with no data is a common trap.

### Feedback loop
Log opens, dwell time, and re-searches for the same intent. Feed this back into the re-ranking weights over time. This is genuinely how Google, Instagram, and LinkedIn all improve their ranking — not through a better algorithm on day one, but through continuously learning from real usage. Don't try to build a sophisticated learned ranker before you have the usage data to train it on.

---

## 6. Latency and cost — where they actually bite

- **Query-time latency budget:** hybrid retrieval + graph expansion + re-ranking + explanation generation all have to happen in something like 1–2 seconds for search to feel responsive. Keep the LLM calls in the query-time path small and fast (or precompute explanations at enrichment time where possible) — reserve larger, slower LLM calls for the async enrichment pipeline, not the live query path.
- **Enrichment cost scales with import volume**, not with search volume — this connects directly to the unit-economics gotcha in the business doc. A user bulk-importing 10,000 GitHub stars on day one creates a large one-time enrichment bill; budget and possibly rate-limit for this explicitly.
- **The graph can explode** if entity extraction runs unchecked across a large corpus — dedupe and normalize entities as a first-class pipeline step, not an afterthought.

---

## 7. Build order — mapped to the product roadmap

This ties directly to the phased roadmap from earlier:

- **Phase 0 (MVP):** Connectors → enrichment → dual index → hybrid query engine → explanations. This is the Google layer, on its own. Prove retrieval works before building anything else.
- **Phase 1 (Retention):** Add the resurfacing engine. This is the Instagram layer. Start with heuristic ranking (no ML needed yet) — recency + topic clustering is enough to validate whether resurfacing drives re-engagement at all.
- **Phase 2 (Depth):** Add the knowledge graph — entities, edges, topic pages, graph-expanded retrieval, connection paths. This is the LinkedIn/Happenstance layer, and it's what makes the product feel like "a unified library" rather than "search across five apps."
- **Phase 3+:** Migrate to a dedicated graph database and a learned ranking model once usage data justifies the added infrastructure — not before.

Building the graph layer before the search layer works, or the resurfacing layer before you have real usage data to learn from, is the most common way this kind of build goes sideways — each layer depends on the one before it actually working first.
