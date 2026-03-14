# Your AI Agent Has Been Quietly Forgetting Everything. Now It Doesn't Have to.

*Introducing engram — the plugin that captures what Claude knows before it forgets.*

---

There's a dirty secret about every AI coding agent running long sessions today: the moment the conversation gets too long, it starts throwing away context.

Not summarizing it. Not compressing it smartly. **Throwing it away.** Claude, Codex, every long-running agent — when the context window fills up, messages get cut. Code decisions you explained three hours ago. Architectural rationale. The specific bug you told the agent to never repeat. Gone.

If you're running agents continuously — and if you're doing serious AI-assisted development, you probably are — this is a real problem. It's the hidden tax on every long session.

**engram eliminates it.**

---

## What It Does

engram is an OpenClaw plugin that gives your agents persistent, searchable memory across their entire session lifetime. It replaces OpenClaw's default sliding-window compaction with three interlocking systems:

### 1. DAG-Based Lossless Compaction

Instead of dropping old messages when context gets full, engram:

1. **Persists every message** in a local SQLite database
2. **Summarizes chunks** of older messages using your configured LLM
3. **Condenses summaries** into higher-level nodes as they accumulate, forming a Directed Acyclic Graph (DAG)
4. **Assembles context** each turn: recent raw messages + relevant summaries
5. **Provides search tools** (`lcm_grep`, `lcm_describe`, `lcm_expand`) so agents can reach back into compacted history

Nothing is discarded. The raw messages stay in the database. Summaries link back to their source messages. The agent can drill into any summary and recover the original detail.

In practice: your agent feels like it never forgets. Because it doesn't.

### 2. Pre-Compaction Fact Extraction *(the killer feature)*

Here's what makes engram different from every other memory solution.

Right before messages get compacted into summaries, the plugin scans them for **durable facts**: entities, decisions, preferences, episodes. These are extracted using fast heuristics — no LLM call, no extra latency, under 500ms — and stored with `source=pre_compaction`.

Why does this matter? Because LLM-generated summaries are lossy by design. A summary of a long debugging session captures the *gist* — but it might drop the specific library version you pinned, the edge case you documented, the preference you stated ("never use X pattern").

Pre-compaction extraction captures those durable signals *before* the lossy step. The facts live independently in memory, permanently, queryable even after the summary that contained them has been condensed away.

This is why we call it the killer feature. Summaries are for context assembly. Facts are for actual long-term agent memory.

### 3. Gigabrain-Style Capture Pipeline

Beyond compaction, engram ships with a full Gigabrain-compatible memory capture system:

- **Episode storage** — meaningful events captured as discrete memory entries
- **Quality gates** — filters out noise before storage
- **Cross-agent memory** — multiple agents sharing a unified memory pool (replaces OpenStinger)
- **Native sync** — keeps `MEMORY.md` and daily note files in sync with the database
- **`memory_query` tool** — semantic + full-text search across all captured memory

The result is a unified memory layer that works for both in-session context management and long-term persistent knowledge.

---

## Why Pre-Compaction Capture Matters

Think about what happens in a typical 3-hour coding session:

- You tell the agent your preferred test structure
- The agent discovers a subtle bug and you explain why it happens
- You make an architectural decision and explain the tradeoff
- You correct the agent when it uses a pattern you don't like
- You specify a constraint that affects future decisions

All of that is conversational context. In a normal session, it's fine — the agent has it in its window. But the moment compaction runs? Those specifics get filtered through a lossy summary. The agent technically "knows" the session happened, but the exact preference, the specific constraint, the precise reason — those are gone.

Pre-compaction extraction says: before we summarize this, let's extract the signals that are too important to lose. Store them directly. Make them permanently queryable.

This is what gives engram sessions their distinctive feel: the agent remembers things you said hours ago *specifically*, not vaguely.

---

## How to Install

### Prerequisites

- OpenClaw with plugin context engine support
- Node.js 22+
- An LLM provider configured in OpenClaw (used for summarization)

### One command

```bash
openclaw plugins install engram
```

If you're running from a local OpenClaw checkout:

```bash
pnpm openclaw plugins install engram
```

That's it. The installer records the plugin, enables it, and automatically wires it into the `contextEngine` slot.

### Recommended starting configuration

Add these to your environment or OpenClaw config:

```bash
LCM_FRESH_TAIL_COUNT=32
LCM_INCREMENTAL_MAX_DEPTH=-1
LCM_CONTEXT_THRESHOLD=0.75
```

- `FRESH_TAIL_COUNT=32` — protects the last 32 messages from compaction (recent context stays raw)
- `INCREMENTAL_MAX_DEPTH=-1` — enables full cascade condensation after each compaction pass
- `CONTEXT_THRESHOLD=0.75` — triggers at 75% of the model's context window, leaving headroom

For long-lived sessions (7+ days of continuous agent operation), also set:

```json
{
  "session": {
    "reset": {
      "mode": "idle",
      "idleMinutes": 10080
    }
  }
}
```

This keeps sessions alive across idle gaps so memory accumulates over weeks, not hours.

### Local development

```bash
openclaw plugins install --link /path/to/engram
```

---

## What You Get

Once installed, your agents automatically have:

| Feature | What it does |
|---|---|
| `lcm_grep` | Full-text search across all stored conversation history |
| `lcm_describe` | Get a summary with metadata for any stored summary node |
| `lcm_expand` / `lcm_expand_query` | Recursively expand summaries back to source messages |
| `memory_query` | Semantic search across all captured episodes and facts |
| Pre-compaction facts | Durable signals extracted before summarization |
| Cross-agent memory | Shared memory pool across multiple OpenClaw agents |
| MEMORY.md sync | Human-readable memory file kept in sync automatically |

No configuration changes to your agent prompts. No new workflows to learn. The memory just works.

---

## Under the Hood

engram is built on:

- **SQLite** (via `better-sqlite3`) for zero-dependency local storage
- **DAG-based summary tree** — each summary links to its sources, condensed summaries link to leaf summaries, all the way down to raw messages
- **Depth-aware prompt generation** — summarization prompts change based on DAG depth to stay coherent as condensation cascades
- **FTS5 full-text search** (optional) — enable for fast grep across millions of stored messages

The plugin absorbs three previously separate projects: Lossless Claw (context management), Gigabrain (memory capture), and OpenStinger (cross-agent memory). One install, one config, one database.

---

## Get It

```bash
openclaw plugins install engram
```

Source code, docs, and configuration reference: [github.com/applied-leverage/engram](https://github.com/applied-leverage/engram)

Full documentation: see `docs/` in the repo — architecture, configuration guide, agent tools reference, TUI reference.

---

*engram is built by Applied Leverage. If you're running OpenClaw agents at scale and want to talk about what we're building, reach out.*
