# Engram v2 — Unified Tool Surface Inventory

Tool mapping from all three legacy systems to the unified Engram v2 namespace.

## Summary

| Count | System |
|-------|--------|
| 5 | Engram/LCM (original) |
| 0 direct MCP | Gigabrain (hooks-only, no agent-facing MCP tools) |
| 9 | OpenStinger Tier 1 (memory) |
| 6 | OpenStinger Gradient (alignment) |
| 6 | OpenStinger Scaffold/Vault |
| **26 raw** | Total legacy tools |
| **19 unified** | Engram v2 agent-facing tools |

---

## Context Tools (LCM → `context_*`)

| Legacy Name | System | New Name | Status | Notes |
|-------------|--------|----------|--------|-------|
| `lcm_grep` | Engram/LCM | `context_grep` | ✅ Implemented | `lcm_grep` alias retained for backward compat |
| `lcm_describe` | Engram/LCM | `context_describe` | ✅ Implemented | `lcm_describe` alias retained |
| `lcm_expand` | Engram/LCM | `context_expand` | ✅ Implemented | `lcm_expand` alias retained |
| `lcm_expand_query` | Engram/LCM | `context_query` | ✅ Implemented | `lcm_expand_query` alias retained |

---

## Memory Tools (`memory_*`)

| Legacy Name | System | New Name | Status | Notes |
|-------------|--------|----------|--------|-------|
| `memory_add` | Engram/LCM | `memory_add` | ✅ Implemented | Merges Engram + OpenStinger `memory_add`; writes to `memory_current` |
| *(Gigabrain capture hook)* | Gigabrain | `memory_add` | ✅ Routed | Gigabrain auto-capture writes via same path |
| *(Gigabrain recall hook)* | Gigabrain | `memory_recall` | ✅ Implemented | New explicit recall tool; surfaces top-k by confidence |
| `memory_search` | OpenStinger Tier 1 | `memory_search` | ✅ Implemented | FTS5 + LIKE fallback over `memory_current` |
| `memory_query` | OpenStinger Tier 1 | `memory_query` | ✅ Implemented | Adds `afterDate`/`beforeDate` temporal filtering |
| `memory_get_entity` | OpenStinger Tier 1 | `memory_get_entity` | ✅ Implemented | Reads `memory_entities` table |
| `memory_get_episode` | OpenStinger Tier 1 | `memory_get_episode` | ✅ Implemented | Reads `memory_episodes` table |
| `memory_ingest_now` | OpenStinger Tier 1 | `memory_ingest_now` | 🔲 Stub (P3) | Background scheduler not yet implemented |
| `memory_namespace_status` | OpenStinger Tier 1 | `memory_namespace_status` | ✅ Implemented | Aggregated stats over all `memory_*` tables |
| `memory_list_agents` | OpenStinger Tier 1 | `memory_list_agents` | 🔲 Stub (P3) | Multi-agent namespacing is a P3 feature |
| `memory_job_status` | OpenStinger Tier 1 | `memory_job_status` | 🔲 Stub (P3) | Job queue not yet implemented |
| *(Gigabrain world model)* | Gigabrain | `memory_world` | ✅ Implemented | Surfaces `memory_entities` with associated memories |

---

## Alignment Tools (`alignment_*` ← `gradient_*`)

| Legacy Name | System | New Name | Status | Notes |
|-------------|--------|----------|--------|-------|
| `gradient_status` | OpenStinger Gradient | `alignment_status` | 🔲 Stub (P3) | Gradient engine not yet ported |
| `gradient_alignment_score` | OpenStinger Gradient | `alignment_check` | 🔲 Stub (P3) | Gradient engine not yet ported |
| `gradient_drift_status` | OpenStinger Gradient | `alignment_drift` | 🔲 Stub (P3) | Gradient engine not yet ported |
| `gradient_alignment_log` | OpenStinger Gradient | **Dropped** | — | Internal operational detail, not agent-facing |
| `gradient_alert` | OpenStinger Gradient | **Dropped** | — | Surfaced via `alignment_status` |
| `gradient_history` | OpenStinger Gradient | **Dropped** | — | Internal operational detail |

---

## Vault Tools (Dropped from agent surface)

OpenStinger vault tools (`vault_status`, `vault_sync_now`, `vault_stats`, `vault_promote_now`, `vault_note_list`, `vault_note_get`) are **not exposed as agent-facing tools** in Engram v2.

Rationale: vault operations are system-managed (cron/hooks). Agents don't need to trigger them. The vault build is handled by `memory_vault_build` in the vault surface layer (see APP-129).

---

## Conflict Resolution

| Conflict | Resolution |
|----------|-----------|
| `memory_add` exists in both Engram and OpenStinger | **Merged** — single `memory_add` writes to `memory_current` (SQLite). Episodic semantics preserved via `kind=EPISODE`. |
| `memory_search` in both Gigabrain and OpenStinger | **OpenStinger wins** — OpenStinger's implementation has smarter fallback strategy (BM25 → vector → numeric → temporal). Gigabrain had no direct MCP tool. |
| `memory_query` vs `memory_search` | **Both kept** — `memory_query` adds temporal date filtering; `memory_search` is unfiltered keyword. Different use cases. |

---

## Full Unified Tool Reference

### Context namespace (4 tools + 4 backward-compat aliases)

```
context_grep          Search conversation history (regex/full-text)
context_describe      Inspect a summary node (fast, no sub-agent)
context_expand        Expand a summary subtree (sub-agent)
context_query         Expand + answer a question (sub-agent)

# Legacy aliases (same implementation):
lcm_grep / lcm_describe / lcm_expand / lcm_expand_query
```

### Memory namespace (12 tools)

```
memory_add            Store a fact, preference, decision, or entity
memory_recall         Load top-k memories by confidence (session prime)
memory_search         Keyword/semantic search over memory store
memory_query          Temporal + keyword search with date filtering
memory_world          Surface entity model (people, projects, orgs)
memory_get_entity     Fetch entity by UUID
memory_get_episode    Fetch episode by UUID
memory_namespace_status  Memory store health + stats
memory_ingest_now     [P3 stub] Trigger background ingestion
memory_list_agents    [P3 stub] List agent namespaces
memory_job_status     [P3 stub] Check background job status
```

### Alignment namespace (3 tools — P3 stubs)

```
alignment_status      Engine health + profile state
alignment_check       Evaluate text/action for alignment
alignment_drift       Rolling drift statistics
```

**Total: 19 agent-facing tools (+ 4 backward-compat aliases)**
