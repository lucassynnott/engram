# Engram v2 Migration Guide

How to migrate from the three legacy systems (Engram/LCM, Gigabrain, OpenStinger) to the unified Engram v2 plugin.

---

## Quick Decision: Which path are you on?

| You are using… | Migration path |
|---------------|----------------|
| Engram/LCM only | [Path A — LCM users](#path-a--lcm-only-users) |
| Gigabrain only | [Path B — Gigabrain users](#path-b--gigabrain-only-users) |
| OpenStinger only | [Path C — OpenStinger users](#path-c--openstinger-users) |
| All three | [Path D — Full migration](#path-d--full-migration-all-three-systems) |

---

## Path A — LCM-only users

**Before:** `openclaw plugins install engram` (original LCM plugin)

**After:** Same install, no breaking changes.

### What changed

- All `lcm_*` tools are still available under their original names.
- New `context_*` aliases are also registered — same implementation, different names.
- New `memory_*` tools are available immediately (empty store on first use).

### Agent prompt changes (optional)

If you want to use the unified names, update prompts:

```
lcm_grep         → context_grep    (or keep lcm_grep — both work)
lcm_describe     → context_describe
lcm_expand       → context_expand
lcm_expand_query → context_query
```

### Data migration

**None required.** The LCM database (`lcm.db`) is unchanged. The memory store (`memory_current` tables) is new and starts empty.

---

## Path B — Gigabrain-only users

**Before:** `openclaw plugins install gigabrain`

**After:** `openclaw plugins install engram` (uninstall gigabrain first)

### Step 1: Export Gigabrain memories

```bash
# Export active memories from the Gigabrain SQLite registry
node -e "
const db = require('node:sqlite');
const d = new db.DatabaseSync(process.env.HOME + '/.openclaw/memory/gigabrain.db');
const rows = d.prepare('SELECT * FROM memories WHERE status = \"active\"').all();
require('node:fs').writeFileSync('/tmp/gb-export.json', JSON.stringify(rows, null, 2));
console.log('Exported', rows.length, 'memories');
"
```

### Step 2: Install Engram v2 and import

```bash
openclaw plugins install engram

# Import exported memories
node -e "
const fs = require('node:fs');
const rows = JSON.parse(fs.readFileSync('/tmp/gb-export.json', 'utf8'));
// Use the engram CLI migrator
// engram migrate --from gigabrain --input /tmp/gb-export.json
console.log('Import', rows.length, 'memories via: engram migrate --from gigabrain');
"
```

### Step 3: Update agent prompts

| Old call | New call |
|---------|---------|
| *(automatic capture hook)* | `memory_add` — now explicit in tool calls |
| *(automatic recall hook)* | `memory_recall` — call explicitly at session start |
| N/A (no MCP tools) | `memory_search`, `memory_query`, `memory_world` now available |

### Configuration mapping

| Gigabrain config | Engram v2 config |
|------------------|-----------------|
| `capture.enabled` | `memory.capture.enabled` |
| `capture.minConfidence` | `memory.capture.minConfidence` |
| `recall.topK` | `memory.recall.topK` |
| `recall.minScore` | `memory.recall.minConfidence` |
| `worldModel.enabled` | `memory.worldModel.enabled` |
| `vault.enabled` | `vault.enabled` |
| `llm.provider` | `llm.provider` |

---

## Path C — OpenStinger users

**Before:** OpenStinger Python MCP server (`openstinger serve`)

**After:** `openclaw plugins install engram` (no Python, no FalkorDB)

### What changed

| OpenStinger tool | Engram v2 tool | Notes |
|-----------------|----------------|-------|
| `memory_add` | `memory_add` | Same semantics, SQLite backend |
| `memory_query` | `memory_query` | Adds `afterDate`/`beforeDate` params |
| `memory_search` | `memory_search` | FTS5 + LIKE fallback (no vector yet) |
| `memory_get_entity` | `memory_get_entity` | SQLite-backed |
| `memory_get_episode` | `memory_get_episode` | SQLite-backed |
| `memory_namespace_status` | `memory_namespace_status` | Available |
| `memory_list_agents` | `memory_list_agents` | P3 stub |
| `memory_ingest_now` | `memory_ingest_now` | P3 stub |
| `memory_job_status` | `memory_job_status` | P3 stub |
| `gradient_status` | `alignment_status` | P3 stub |
| `gradient_alignment_score` | `alignment_check` | P3 stub |
| `gradient_drift_status` | `alignment_drift` | P3 stub |
| `vault_*` (6 tools) | **Not exposed** | Vault managed internally |

### Data migration

OpenStinger used FalkorDB (Postgres-backed). Engram v2 uses SQLite.

```bash
# Export OpenStinger episodes to JSONL
python3 -m openstinger export --format jsonl --output /tmp/os-episodes.jsonl

# Import into Engram v2
engram migrate --from openstinger --input /tmp/os-episodes.jsonl
```

### Removed dependencies

- FalkorDB / Redis — not needed
- PostgreSQL — not needed
- Python runtime — not needed (Engram v2 is Node.js)

---

## Path D — Full migration (all three systems)

### Step 1: Stop all three services

```bash
# Stop OpenStinger
pkill -f openstinger

# Uninstall old plugins
openclaw plugins uninstall gigabrain
```

### Step 2: Export data from each system

```bash
# Gigabrain
node scripts/export-gigabrain.js > /tmp/gb-export.json

# OpenStinger (requires Python env)
python3 -m openstinger export --format jsonl --output /tmp/os-episodes.jsonl

# LCM (no export needed — database is preserved)
```

### Step 3: Install Engram v2

```bash
openclaw plugins install engram
```

### Step 4: Run migration CLI

```bash
# Import Gigabrain memories
engram migrate --from gigabrain --input /tmp/gb-export.json

# Import OpenStinger episodes
engram migrate --from openstinger --input /tmp/os-episodes.jsonl

# Verify
engram status
```

### Step 5: Update agent prompts

Replace in all system prompt templates:

```
# OLD — three separate tool sets
lcm_grep / lcm_describe / lcm_expand / lcm_expand_query
memory_query / memory_search / memory_get_entity / ...
gradient_status / gradient_alignment_score / ...

# NEW — unified tool set
context_grep / context_describe / context_expand / context_query
memory_recall / memory_add / memory_search / memory_query / memory_world
alignment_status / alignment_check / alignment_drift
```

Or use the generated system prompt:

```typescript
import { generateEngramSystemPrompt } from "engram/tools";

const systemPrompt = generateEngramSystemPrompt({
  lcmEnabled: true,
  memoryEnabled: true,
  episodicEnabled: false,  // set true when P3 ships
  alignmentEnabled: false, // set true when P3 ships
});
```

---

## Backward compatibility guarantees

- `lcm_grep`, `lcm_describe`, `lcm_expand`, `lcm_expand_query` remain available indefinitely.
- `memory_add` signature unchanged.
- OpenStinger `memory_query` params (`afterDate`, `beforeDate`, `limit`) are accepted without change.
- OpenStinger `memory_search` is a drop-in replacement (same param names, same return shape).

---

## What is NOT yet available in v2

These features are planned for P3/P4:

- Background ingestion scheduler (`memory_ingest_now`, `memory_job_status`)
- Multi-agent namespace isolation (`memory_list_agents`)
- Gradient alignment evaluation (`alignment_check`, `alignment_status`, `alignment_drift`)
- Vector similarity search (currently uses FTS5 + LIKE fallback)
- sqlite-vec embeddings for semantic search

When these features ship, the stubs will activate automatically — no prompt changes needed.
