# Refocus the MVP: Saved Knowledge Search, Not Personal Memory

Update the existing MVP document to incorporate a critical product focus:

## Core Product Boundary

This product is **not Rewind, Limitless, or a general-purpose personal memory system**.

We are **not trying to capture, record, or remember everything the user does**.

The MVP should focus specifically on:

> **Helping users find and understand things they intentionally saved across the internet and their personal knowledge tools.**

The user's existing saved knowledge is the source of truth.

Examples include:

- Saved Instagram/YouTube Reels and videos
- YouTube saved/watch-later content
- Starred/saved GitHub repositories
- Reddit saved posts
- Bookmarks
- Personal notes
- Notion notes
- Obsidian notes
- Other intentionally saved digital content

The central problem is:

> **"I know I saved something about this somewhere, but I don't remember where or what it was called."**

The product should allow the user to search by **meaning and intent**, rather than requiring them to remember the exact title, URL, platform, folder, or keyword.

---

## Important: Do NOT Clone Rewind

Explicitly establish in the MVP document that we are deliberately avoiding the Rewind/Limitless model.

Do NOT build around:

- Continuous screen recording
- Recording everything the user does
- Recording ambient conversations
- Always-on microphones
- Automatic surveillance of the user's digital activity
- Capturing the user's entire computer history
- Building a complete chronological "memory" of the user
- Hardware/wearable capture
- "AI that remembers your entire life"

These are **out of scope for the MVP** and should not accidentally creep into the architecture or product vision.

The distinction should be extremely clear:

**Rewind/Limitless:**
> Capture everything → create a personal memory → ask AI about your past.

**Our product:**
> User intentionally saves things → organize/index them semantically → search and retrieve the right knowledge.

---

## Product Positioning

Refine the positioning throughout the MVP document so that the product is understood as a:

**Universal semantic search engine for your saved knowledge.**

Not:

- A digital surveillance system
- A personal life recorder
- A screen recorder
- A general AI companion
- A replacement for Rewind
- A generic chatbot with memory

The product should feel closer to:

> **"Google Search for everything you've saved."**

or:

> **"Your personal search engine for the internet's knowledge you've chosen to keep."**

The exact wording can be improved, but the underlying positioning must remain.

---

## Why This Focus Matters

Add a concise product rationale explaining that deliberately limiting the input to **things the user chose to save** provides several advantages:

### 1. Clearer user intent

A saved item already represents an explicit signal:

> "This is something I considered worth keeping."

That makes the corpus more meaningful than indiscriminately recording everything.

### 2. Much simpler privacy model

We are indexing content the user intentionally saved rather than continuously monitoring their life.

This should be a major product advantage.

### 3. More focused MVP

Instead of solving:

> "How do we remember everything about a person?"

we solve:

> "How do we make someone's accumulated saved knowledge instantly searchable?"

This dramatically reduces the MVP surface area.

### 4. Stronger retrieval problem

The interesting technical problem becomes **semantic retrieval across heterogeneous sources**.

A user should be able to search something like:

> "that video I saved about how databases handle millions of writes"

and find the relevant YouTube video even if its title doesn't contain those words.

Likewise:

> "the Reddit post where someone explained why startups shouldn't use microservices early"

should retrieve the relevant saved Reddit post.

The system should understand **meaning**, not merely keywords.

---

# MVP Product Principle

Add a prominent principle to the MVP:

> **Capture less. Understand more.**
>
> We don't need to remember everything the user does. We need to make the things they deliberately chose to remember dramatically easier to find.

This should guide the scope of the entire MVP.

---

# What the MVP Should Actually Build

Ensure the MVP remains centered around this pipeline:

**Connect sources**
→ **Import saved content**
→ **Normalize metadata/content**
→ **Generate semantic representations**
→ **Index**
→ **Search by natural language**
→ **Retrieve relevant saved items**
→ **Explain/summarize why they are relevant**
→ **Open the original source**

The MVP should prioritize retrieval quality over building an elaborate AI assistant.

---

# Search Experience

The document should emphasize that the primary interaction is **search**, not conversation.

The user should be able to enter natural-language queries such as:

- "videos about building RAG systems"
- "that GitHub repo about local-first apps"
- "the Reddit post about Supabase alternatives"
- "notes where I wrote about startup pricing"
- "something I saved about Postgres indexing"
- "that article comparing Redis and Kafka"

The system should return relevant saved items across platforms.

Results should ideally show:

- Source/platform
- Title
- Creator/author
- Short content snippet
- Why it matched
- Date saved
- Original link
- Relevant semantic highlights

AI can enhance the retrieval experience, but **search/retrieval is the core product**.

---

# Explicit Non-Goals

Strengthen the existing MVP's non-goals with:

- No continuous recording
- No screen capture
- No ambient audio capture
- No automatic tracking of everything the user does
- No wearable device
- No hardware
- No attempt to reconstruct the user's entire life
- No general-purpose personal-memory assistant
- No autonomous collection of content the user did not intentionally save
- No requirement to become the user's always-on AI companion

If a proposed MVP feature starts moving the product toward these areas, treat it as scope creep.

---

# Competitive Insight

You may briefly mention Rewind/Limitless as a **strategic reference point**, but do not make the MVP document primarily about them.

The important takeaway is:

> Rewind/Limitless demonstrates that "AI memory" is compelling, but the MVP should avoid taking on the enormous technical, privacy, behavioral, and business complexity of capturing a user's entire digital life.

Our wedge is narrower:

> **Search the knowledge users have already chosen to save.**

This should be presented as a deliberate product strategy rather than a limitation.

---

# Final Editing Instruction

Review the entire existing MVP document after making these changes.

Wherever the existing document implies that the product should:

- remember everything,
- capture everything,
- monitor activity,
- become a complete personal memory,
- behave like Rewind,
- or operate as an always-on assistant,

rewrite that language so it aligns with the **saved knowledge search** thesis.

Do not unnecessarily expand the MVP.

Do not add hardware.

Do not add screen recording.

Do not add ambient recording.

Do not turn the product into a generic AI assistant.

Keep the MVP focused on one core promise:

> **Connect the places where you save things, then let you search all of that saved knowledge as if it were one intelligent, unified library.**

The final MVP document should make it immediately obvious that this is a **semantic search engine for intentionally saved knowledge**, not a Rewind clone.