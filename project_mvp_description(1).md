# Personal Saves Search Engine — MVP

## 1. Project Overview

We are building a centralized, AI-powered search engine for a user's saved digital content.

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

The MVP solves this by creating a **personal semantic search engine across the user's saved content**.

### Core product idea

> **Search your saves by what you remember, not by where you saved them.**

The user describes a need in natural language, and the application searches their connected saved content and returns the most relevant results.

---

# 2. Core User Problem

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

# 3. Example Use Case

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

# 4. Product Definition

The MVP is **not primarily a bookmarking application**.

It is a:

> **Personal semantic search engine for saved digital knowledge.**

The system converts fragmented saved content into a unified, searchable knowledge corpus.

The fundamental product loop is:

```text
Capture
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

# 5. MVP Goals

The MVP should prove one core hypothesis:

> **When a user cannot remember where they saved something, can the system reliably find it from a natural-language description of what they need?**

The MVP should prioritize:

- Search quality
- Relevance
- Fast retrieval
- Simple ingestion
- Clear source attribution
- Explainable results
- A clean search-first interface

The MVP should **not** attempt to build every possible connector or every possible AI feature.

---

# 6. Initial Data Sources

The MVP should focus on a limited number of integrations.

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

The MVP should avoid excessive integration complexity before the core search experience is validated.

---

# 7. Unified Content Model

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

Additional fields can be introduced as the system evolves.

The purpose of normalization is to allow the search engine to treat a GitHub repository, Reddit post, YouTube video, and personal note as searchable items inside the same system.

---

# 8. Content Understanding Pipeline

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

# 9. Categorization

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

# 10. Search Experience

The search bar is the primary interface of the MVP.

The user should be able to enter a natural-language request such as:

> "Find the things I saved about making AI-generated websites look more professional."

or:

> "What have I saved about building AI agents?"

or:

> "I remember saving something about PostgreSQL performance."

or:

> "Find the GitHub repo and Reddit post I saved about UI design systems."

The user should not be required to know:

- The source platform
- The exact title
- Exact keywords
- The URL
- The author

---

# 11. Search Architecture

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

# 12. Search Results

The MVP should return the original saved content rather than hiding everything behind an AI-generated answer.

A result should communicate:

- Source
- Title
- Short summary
- Relevance
- Why it matches
- Category / topics
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

[Open Original]
```

The system should preserve the connection to the original source.

---

# 13. Explainable Relevance

A major part of the MVP experience should be explaining **why** a result was returned.

Instead of simply showing:

> GitHub Repository — 92% match

show:

> **Why it matches:**  
> This repository contains reusable components and design patterns related to the UI consistency you're looking for.

This helps users trust semantic retrieval.

---

# 14. AI Synthesis — Secondary Feature

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

This feature should be secondary to retrieval in the MVP.

The core MVP must first prove that the system can **find the right information**.

---

# 15. What the MVP Should NOT Become

The initial version should not attempt to become all of the following at once:

- A full note-taking application
- A social network
- A bookmarking replacement
- A general-purpose AI chatbot
- A complete personal knowledge management system
- A universal integration platform
- An autonomous research agent

The MVP should stay focused on:

> **Finding information the user already saved.**

---

# 16. MVP User Flow

```text
1. User creates an account
        ↓
2. User connects one or more sources
        ↓
3. Application imports saved content
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

# 17. Suggested MVP Interface

The interface should be search-first and intentionally simple.

### Main screen

```text
┌─────────────────────────────────────────────┐
│                                             │
│       Search everything you've saved       │
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

# 18. MVP Technical Architecture

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

---

# 19. Data Processing Requirements

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

# 20. Privacy and User Data

Because this application handles a user's personal saved content, privacy is a core product requirement.

The system should:

- Keep each user's data isolated
- Never expose one user's saved content to another user
- Clearly communicate what data each integration can access
- Store only the data required for the product
- Provide a way to disconnect integrations
- Provide a way to delete imported data
- Preserve links back to original content

Privacy should be treated as a foundational architectural concern rather than a later feature.

---

# 21. MVP Success Criteria

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

# 22. Longer-Term Product Direction

If the MVP proves the retrieval experience, the product can expand from saved content into a broader personal knowledge layer.

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

The product could eventually become a personal retrieval layer across a user's fragmented digital memory.

Examples:

> "What have I collected about building SaaS products?"

> "Find everything I've saved about PostgreSQL optimization."

> "I remember seeing a GitHub repo and a Reddit post about this. Find both."

> "What ideas have I saved about improving onboarding?"

> "Show me everything relevant to the project I'm currently working on."

At that point, the product evolves from a **search engine for saves** into a **personal knowledge retrieval and synthesis system**.

---

# 23. Product Principle

The product should be built around one fundamental principle:

> **The user should not have to remember where they saved something in order to find it again.**

Traditional organization asks:

> "Where did you put it?"

This product asks:

> **"What are you trying to find?"**

That distinction is the core of the product.
