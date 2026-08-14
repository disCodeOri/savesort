# Personal Saved Knowledge Search Engine — MVP

## 1. Project Overview

We are building a centralized, AI-powered search engine for a user's **intentionally saved** digital content.

People save useful information across many disconnected platforms:

- Instagram / Reels
- YouTube
- GitHub
- Reddit
- Notion
- Obsidian
- Personal notes
- Browser bookmarks
- Other note-taking and content-saving applications

The problem is not saving information. The problem is **retrieving it later**.

Users often remember *what they were looking for* or *what they wanted to accomplish*, but do not remember:

- Which platform they saved it on
- The title of the content
- The exact wording
- The URL
- When they saved it
- Which folder, collection, subreddit, playlist, or note contains it

The MVP solves this by creating a **personal semantic search engine across the user's saved content** — and nothing more than that.

### Core product idea

> **Search your saves by what you remember, not by where you saved them.**

The user describes a need in natural language, and the application searches their connected saved content and returns the most relevant results.

---

## 2. Core Product Boundary — What This Is, and Is Not

This is a critical framing decision for the MVP, made deliberately and stated up front.

**This product is not Rewind, not Limitless, and not a general-purpose personal memory system.** We are not trying to capture, record, or remember everything the user does.

| | Rewind / Limitless model | This product |
|---|---|---|
| Input | Continuous screen + audio capture of everything the user does | Only content the user **intentionally saved** |
| Goal | Reconstruct a complete chronological memory of the user's life | Make already-chosen saved knowledge instantly findable |
| Privacy surface | Everything seen, said, or heard | Only what was deliberately kept |
| Hardware | Wearable/pendant capture in its later form | None — software only, connects to existing accounts |
| Interaction model | "Ask AI about your past" | "Search what you already decided was worth keeping" |

The distinction matters, and it should stay explicit throughout the product rather than blur over time:

> Rewind/Limitless: **Capture everything → create a personal memory → ask AI about your past.**
> This product: **User intentionally saves things → organize/index them semantically → search and retrieve the right knowledge.**

The MVP should feel closer to:

> **"Google Search for everything you've saved."**

or:

> **"Your personal search engine for the internet's knowledge you've chosen to keep."**

Not:

- A digital surveillance system
- A personal life recorder
- A screen recorder
- A general AI companion
- A replacement for Rewind
- A generic chatbot with memory

---

## 3. Core User Problem

A typical user may have thousands of saved items distributed across different applications.

For example:

- 500+ GitHub repositories
- Hundreds of Reddit saves
- YouTube playlists and saved videos
- Instagram/Reels saves
- Personal notes
- Notion pages
- Obsidian notes

Traditional search forces the user to know something about the item they are looking for.

For example:

> "What was that GitHub repository I saved about UI components?"

requires remembering that it was a GitHub repository.

The proposed application instead allows:

> "I want to make my vibecoded applications look more polished and less AI-generated."

The system should understand the intent behind the query and retrieve relevant saved content regardless of its original platform.

---

## 4. Example Use Case

A user wants to improve the UI of an application they built using AI coding tools.

They do not remember where they saved useful information.

They enter:

> "How can I make my vibecoded apps look more polished and less generic?"

Their saved knowledge may contain:

1. A GitHub repository containing a UI component library
2. A Reddit post discussing how to improve AI-generated interfaces
3. A YouTube video about modern UI design
4. An Instagram Reel demonstrating a UI animation
5. A personal note containing a frontend design checklist

The system should retrieve these items and explain why each one is relevant.

Example result:

### GitHub — UI Component Library

**Why it matches:**
Contains reusable UI components and design patterns that can improve consistency and polish in frontend applications.

### Reddit — Improving AI-Generated UI

**Why it matches:**
Discusses practical techniques for reducing generic or repetitive AI-generated interface patterns.

### YouTube — Modern UI Design

**Why it matches:**
Covers visual hierarchy, spacing, typography, and other principles relevant to improving interface quality.

### Personal Note — Vibecoding UI Checklist

**Why it matches:**
Contains the user's own notes about improving AI-generated application interfaces.

---

## 5. Product Definition

The MVP is **not primarily a bookmarking application**, and it is **not a personal memory system**.

It is a:

> **Semantic search engine for intentionally saved digital knowledge.**

The system converts fragmented saved content into a unified, searchable knowledge corpus — built only from what the user chose to keep, not from everything the user did.

### MVP Product Principle

> **Capture less. Understand more.**
>
> We don't need to remember everything the user does. We need to make the things they deliberately chose to remember dramatically easier to find.

This principle should govern every scope decision in the MVP. If a proposed feature starts pulling the product toward capturing more than what the user explicitly saved, it's out of scope.

The fundamental product loop is:

```text
Capture (only what was intentionally saved)
   ↓
Understand
   ↓
Index
   ↓
Retrieve
   ↓
Explain
```

---

## 6. Why This Focus Matters

Deliberately limiting the input to things the user chose to save — rather than indiscriminately recording everything — is a strategic advantage, not a limitation.

### 1. Clearer user intent

A saved item already represents an explicit signal: *"this is something I considered worth keeping."* That makes the corpus more meaningful than indiscriminately recorded activity, and makes retrieval more precise because the source data is already curated by the user's own judgment.

### 2. A much simpler privacy model

We are indexing content the user intentionally saved, not continuously monitoring their screen, audio, or activity. This is a major, defensible product advantage — the privacy story is genuinely simple to explain and easy for a user to trust, unlike an always-on capture model.

### 3. A more focused MVP

Instead of solving *"how do we remember everything about a person,"* we solve *"how do we make someone's accumulated saved knowledge instantly searchable."* This dramatically reduces the MVP's technical, behavioral, and privacy surface area.

### 4. A stronger, more interesting retrieval problem

The interesting technical problem becomes **semantic retrieval across heterogeneous sources** — not passive logging. A user should be able to search:

> "that video I saved about how databases handle millions of writes"

and find the relevant YouTube video even if its title doesn't contain those words. Likewise:

> "the Reddit post where someone explained why startups shouldn't use microservices early"

should retrieve the relevant saved Reddit post. The system understands **meaning**, not merely keywords — that's the product's real technical bet, and it doesn't require capturing anything beyond what the user already chose to save.

---

## 7. MVP Goals

The MVP should prove one core hypothesis:

> **When a user cannot remember where they saved something, can the system reliably find it from a natural-language description of what they need?**

The MVP should prioritize:

- Search quality
- Relevance
- Fast retrieval
- Simple ingestion of intentionally saved content
- Clear source attribution
- Explainable results
- A clean search-first interface

The MVP should **not** attempt to build every possible connector, every possible AI feature, or any form of activity capture beyond what the user explicitly saved.

---

## 8. Initial Data Sources

The MVP should focus on a limited number of integrations, all of which ingest content the user has explicitly chosen to save — never passive activity logs.

### Primary integrations

1. GitHub Stars
2. Reddit Saves
3. YouTube saved content / playlists
4. Notion
5. Manual URL import
6. Manual text / note import

### Future integrations

Potential future sources include:

- Instagram / Reels
- Obsidian
- Apple Notes
- Google Keep
- Browser bookmarks
- Other note-taking applications
- Articles and web highlights
- Additional social platforms

Every future source under consideration should pass the same test: does it represent something the user intentionally saved, or is it passive activity? Only the former belongs on this roadmap.

The MVP should avoid excessive integration complexity before the core search experience is validated.

---

## 9. Unified Content Model

Every external source produces different types of data.

The application should normalize these sources into a common internal representation.

Conceptually:

```text
SavedItem

id
user_id
source
source_id
title
url
content
author
saved_at
created_at
metadata
```

Additional fields can be introduced as the system evolves. Note that every field describes a deliberately saved item — there is no concept of a passively logged event in this model, and none should be added.

The purpose of normalization is to allow the search engine to treat a GitHub repository, Reddit post, YouTube video, and personal note as searchable items inside the same system.

---

## 10. Content Understanding Pipeline

Imported content should not simply be stored as raw links.

The system should enrich each item with machine-readable information.

Potential enrichment:

```text
SavedItem
    ↓
Content extraction
    ↓
Summary
    ↓
Topics
    ↓
Categories
    ↓
Key concepts
    ↓
Potential use cases
    ↓
Entities / technologies
    ↓
Embedding
```

For example:

```text
Source: GitHub

Title: Example UI Repository

Categories:
- Development
- Frontend
- UI

Topics:
- React
- Tailwind
- Design Systems
- Accessibility

Potential use cases:
- Building polished interfaces
- Creating reusable UI components
- Improving AI-generated frontend applications
```

This transforms the database from a collection of URLs into a representation of the user's saved knowledge.

---

## 11. Categorization

The application should automatically organize saved content into useful categories and topics.

Example:

```text
Development
├── React
├── Next.js
├── APIs
├── Databases
└── DevOps

Design
├── UI
├── UX
├── Typography
├── Animation
└── Design Systems

AI
├── AI Coding
├── Prompting
├── Agents
└── LLMs

Business
├── SaaS
├── Marketing
├── Growth
└── Startups
```

A saved item should be able to belong to multiple categories.

For example, a GitHub repository may simultaneously be:

```text
AI
Coding
Frontend
UI
Design Systems
```

The MVP should favor flexible semantic classification over rigid folder structures.

---

## 12. Search Experience

The search bar is the primary interface of the MVP. The primary interaction is **search, not conversation** — this is a retrieval product, not a chatbot with memory.

The user should be able to enter a natural-language request such as:

> "Find the things I saved about making AI-generated websites look more professional."

or:

> "videos about building RAG systems"

or:

> "that GitHub repo about local-first apps"

or:

> "the Reddit post about Supabase alternatives"

or:

> "notes where I wrote about startup pricing"

or:

> "something I saved about Postgres indexing"

or:

> "that article comparing Redis and Kafka"

The user should not be required to know:

- The source platform
- The exact title
- Exact keywords
- The URL
- The author

---

## 13. Search Architecture

Search should use a combination of retrieval techniques rather than relying exclusively on keyword matching.

Conceptually:

```text
User Query
    ↓
Query Understanding
    ↓
Semantic Search
    +
Keyword Search
    +
Metadata Filtering
    ↓
Candidate Results
    ↓
Re-ranking
    ↓
Relevant Saved Items
```

### Semantic search

Embeddings should allow the system to find content that is conceptually related even when the user's query does not contain the same words as the saved content.

### Keyword search

Traditional keyword search should still be used for exact terms, technologies, names, repositories, and other identifiers.

### Metadata filtering

The system should eventually support filters such as:

- Source
- Category
- Date saved
- Topic
- Content type

### Re-ranking

The final candidate set should be re-ranked to improve relevance.

---

## 14. Search Results

The MVP should return the original saved content rather than hiding everything behind an AI-generated answer.

A result should communicate:

- Source / platform
- Title
- Creator / author
- Short content snippet
- Relevance
- Why it matched
- Date saved
- Category / topics
- Relevant semantic highlights
- Original URL

Example:

```text
GitHub
UI Component Library

Highly relevant

Reusable UI components and patterns that can
help improve frontend consistency and polish.

Topics:
React · Tailwind · UI · Design Systems

Saved: 3 months ago

[Open Original]
```

The system should preserve the connection to the original source.

---

## 15. Explainable Relevance

A major part of the MVP experience should be explaining **why** a result was returned.

Instead of simply showing:

> GitHub Repository — 92% match

show:

> **Why it matches:**
> This repository contains reusable components and design patterns related to the UI consistency you're looking for.

This helps users trust semantic retrieval — it's also the clearest way to demonstrate that the product is doing real retrieval work, not just producing a plausible-sounding AI answer.

---

## 16. AI Synthesis — Secondary Feature

The system may eventually synthesize information across multiple saved items.

For example:

User:

> "How can I improve the UI of my vibecoded application?"

The system could identify recurring ideas across several saved items:

```text
Your saved content repeatedly recommends:

1. Establish a consistent design system.
2. Improve typography and spacing.
3. Use reusable UI components.
4. Avoid generic AI-generated layouts.
5. Improve visual hierarchy.
```

This feature should be secondary to retrieval in the MVP, and it should remain a synthesis of the user's own saved content — not a general-purpose chat assistant that reasons beyond what the user actually saved.

The core MVP must first prove that the system can **find the right information**.

---

## 17. Explicit Non-Goals

The initial version should not attempt to become all of the following at once:

- A full note-taking application
- A social network
- A bookmarking replacement
- A general-purpose AI chatbot
- A complete personal knowledge management system
- A universal integration platform
- An autonomous research agent

And, drawn directly from the product boundary in Section 2, the MVP explicitly excludes:

- No continuous recording
- No screen capture
- No ambient audio capture
- No automatic tracking of everything the user does
- No wearable device or hardware of any kind
- No attempt to reconstruct the user's entire digital life
- No general-purpose personal-memory assistant
- No autonomous collection of content the user did not intentionally save
- No requirement to become the user's always-on AI companion

If a proposed MVP feature starts moving the product toward any of the above, treat it as scope creep and reject it.

The MVP should stay focused on:

> **Finding information the user already saved.**

---

## 18. Competitive Insight

Rewind and its successor Limitless are a useful strategic reference point, though they should not dominate this document.

Rewind/Limitless demonstrated that "AI memory" as a concept is genuinely compelling to users — but also that capturing a user's entire digital life carries enormous technical, privacy, behavioral, and business complexity. That model's own trajectory (a pivot toward wearable hardware, followed by acquisition and wind-down of the original product) illustrates how much harder that surface area is to sustain as a standalone product.

Our wedge is deliberately narrower:

> **Search the knowledge users have already chosen to save.**

This should be understood as a deliberate product strategy — a smaller, more defensible surface area — not a limitation relative to what Rewind attempted.

---

## 19. MVP User Flow

```text
1. User creates an account
        ↓
2. User connects one or more sources
        ↓
3. Application imports intentionally saved content
        ↓
4. Content is normalized
        ↓
5. Content is analyzed and enriched
        ↓
6. Embeddings are generated
        ↓
7. Content is indexed
        ↓
8. User enters a natural-language query
        ↓
9. Search retrieves relevant saved items
        ↓
10. Results are ranked
        ↓
11. User sees relevant saves + explanations
        ↓
12. User opens the original content
```

---

## 20. Suggested MVP Interface

The interface should be search-first and intentionally simple.

### Main screen

```text
┌─────────────────────────────────────────────┐
│                                             │
│   Search everything you've saved            │
│                                             │
│  What are you trying to find?               │
│                                             │
│  "How do I make my vibecoded apps look     │
│   more polished?"                           │
│                                             │
└─────────────────────────────────────────────┘
```

After searching:

```text
12 relevant saves

[All] [GitHub] [Reddit] [YouTube] [Notes]

─────────────────────────────────────────────

GitHub
UI Component Library

Highly relevant

Reusable UI components and design patterns
for building consistent interfaces.

Why it matches:
Your query is about improving the visual
quality of AI-generated applications.

─────────────────────────────────────────────

Reddit
Improving AI-generated interfaces

Highly relevant

Practical discussion about reducing generic
AI-generated UI patterns.

─────────────────────────────────────────────
```

---

## 21. MVP Technical Architecture

A conceptual architecture:

```text
                External Sources
                       │
       ┌───────────────┼────────────────┐
       ↓               ↓                ↓
    GitHub           Reddit          YouTube
       │               │                │
       └───────────────┼────────────────┘
                       ↓
                Connector Layer
                       ↓
               Content Normalizer
                       ↓
                Processing Layer
                 ┌─────┼─────┐
                 ↓     ↓     ↓
              Summary Topics Embeddings
                 │     │     │
                 └─────┼─────┘
                       ↓
                Search Index
                       ↓
                Query Engine
                       ↓
             Hybrid Retrieval
                       ↓
                  Re-ranking
                       ↓
                  Search UI
```

Note what's deliberately absent from this architecture: there is no screen-capture pipeline, no ambient audio pipeline, and no passive activity logger. Every input to this system originates from an explicit user save action or an explicit connector sync of already-saved content.

---

## 22. Data Processing Requirements

The ingestion pipeline should be designed to handle:

- New saved items
- Existing saved items
- Updated content
- Deleted/unavailable content
- Duplicate content
- Failed imports
- Re-processing

The system should avoid unnecessarily processing the same content repeatedly.

A normalized identifier such as:

```text
source + source_id
```

can be used to identify items from external platforms.

---

## 23. Privacy and User Data

Because this application handles a user's personal saved content, privacy is a core product requirement — and the narrower scope defined in Section 2 makes that requirement dramatically easier to satisfy than a capture-everything model would.

The system should:

- Keep each user's data isolated
- Never expose one user's saved content to another user
- Clearly communicate what data each integration can access
- Store only the data required for the product — explicitly saved items, never passive activity or unrelated account data
- Provide a way to disconnect integrations
- Provide a way to delete imported data
- Preserve links back to original content

Because the product only ever ingests content the user explicitly chose to save, the privacy story is simple to state to a user in one sentence: *we only index what you already decided was worth keeping.* This should be treated as a foundational architectural concern and a core piece of the product's trust narrative, not a later feature or a footnote.

---

## 24. MVP Success Criteria

The MVP should be considered successful if users can:

1. Connect their saved-content sources.
2. Import their saved content.
3. Search using natural language.
4. Find relevant content without remembering its exact title or platform.
5. Understand why a result was considered relevant.
6. Open the original saved content.
7. Repeatedly use the product because retrieval is better than manually searching each individual platform.

The most important metric is not the number of integrations.

It is:

> **Can users successfully recover something they knew they had saved but could not remember where?**

---

## 25. Longer-Term Product Direction

If the MVP proves the retrieval experience, the product can expand from saved content into a broader personal knowledge layer — while continuing to hold the line defined in Section 2. Any future expansion should still be built from things the user intentionally saved or created, not from passively captured activity.

Potential future sources:

```text
Saved content
+
Personal notes
+
Documents
+
Bookmarks
+
Highlights
+
Conversations
+
Articles
+
Research
```

The product could eventually become a personal retrieval layer across a user's fragmented digital memory — of things they chose to keep, not everything they did.

Examples:

> "What have I collected about building SaaS products?"

> "Find everything I've saved about PostgreSQL optimization."

> "I remember seeing a GitHub repo and a Reddit post about this. Find both."

> "What ideas have I saved about improving onboarding?"

> "Show me everything relevant to the project I'm currently working on."

At that point, the product evolves from a **search engine for saves** into a **personal knowledge retrieval and synthesis system** — still bounded by intentional user action, never by ambient capture.

---

## 26. Product Principle

The product should be built around two fundamental principles:

> **The user should not have to remember where they saved something in order to find it again.**

> **Capture less. Understand more.**

Traditional organization asks:

> "Where did you put it?"

Rewind/Limitless-style products ask:

> "What did you do?"

This product asks:

> **"What are you trying to find, among the things you already chose to keep?"**

That distinction is the core of the product.
