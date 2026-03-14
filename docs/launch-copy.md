# Launch Copy — Applied Leverage Channels

## Slack / Primary Channel Post

---

**🧠 openclaw-memory is out.**

If you're running OpenClaw agents in long sessions, you've hit this: the agent starts forgetting things you told it hours ago. Architectural decisions. Preferences you stated. Context from earlier in the session. It's gone because the context window filled up.

openclaw-memory fixes this.

It's a single OpenClaw plugin that gives your agents:
- **Lossless compaction** — every message stored in SQLite, summarized into a DAG, nothing discarded
- **Pre-compaction fact extraction** — durable facts (decisions, preferences, entities) captured *before* the lossy summary step, stored permanently
- **Full memory search** — `lcm_grep`, `memory_query`, and expand tools so agents can reach back into weeks of history
- **Cross-agent memory** — shared memory pool across all your OpenClaw agents

One install:
```
openclaw plugins install openclaw-memory
```

Blog post with the full breakdown: [link]
Demo: [link]

---

## Twitter / X Thread

**Tweet 1:**
Your AI coding agent is quietly forgetting everything you tell it.

Not a bug. Not a limitation you can fix with a longer system prompt. It's structural: context windows fill up, old messages get cut, your agent starts every long session slightly dumber than it ended the last one.

We built something about that.

**Tweet 2:**
openclaw-memory is an OpenClaw plugin that replaces sliding-window compaction with a DAG-based summarization system.

Every message stored. Summaries link to sources. Agents can search and expand back to raw messages from weeks ago.

Nothing is thrown away.

**Tweet 3:**
The part we're most proud of: pre-compaction fact extraction.

Before messages get summarized (a lossy operation), we scan them for durable signals: decisions, preferences, entities, episodes. Extract and store them independently.

Summaries are for context. Facts are for actual long-term memory.

**Tweet 4:**
Install:
```
openclaw plugins install openclaw-memory
```

Absorbs Lossless Claw + Gigabrain + OpenStinger into one plugin.
SQLite-backed, local-first, works with any LLM provider.

Full post: [link]

---

## Newsletter Blurb (Applied Leverage newsletter)

**What we shipped: openclaw-memory**

We spent the last two weeks consolidating three separate OpenClaw memory projects — Lossless Claw, Gigabrain, and OpenStinger — into a single unified plugin.

The headline feature is pre-compaction fact extraction: right before the plugin creates lossy LLM summaries, it scans outgoing messages for durable facts (decisions, preferences, architectural choices, named entities) and extracts them with fast regex heuristics. These facts are stored permanently, independently of the summaries, and are queryable for the lifetime of the agent.

The result: agents that feel like they genuinely remember things, not just agents that have a rough gist of what happened.

Install in one command: `openclaw plugins install openclaw-memory`

---

## Demo Video Script Outline

*(For Lucas to record — ~5 min target)*

**Scene 1: The Problem (30 sec)**
- Show a long OpenClaw session
- Scroll up, show context getting cut — "Here's what gets lost"
- "Every agent does this. Here's the fix."

**Scene 2: Install (30 sec)**
- `openclaw plugins install openclaw-memory`
- Show the plugin enabling, confirm it's wired to contextEngine slot

**Scene 3: Memory in Action (2 min)**
- Start a session, tell the agent something specific ("always use this pattern", name a file path, etc.)
- Let the session run a while / simulate compaction
- Come back, ask the agent about what you told it
- Show it recalling correctly with `memory_query` or `lcm_grep`
- Demonstrate the pre-compaction facts stored in the DB

**Scene 4: Cross-Agent Memory (1 min)**
- Show two agents, one tells something to memory
- Second agent queries and finds it
- "Shared memory pool — out of the box"

**Scene 5: Call to Action (30 sec)**
- `openclaw plugins install openclaw-memory`
- Link to GitHub repo / blog post
