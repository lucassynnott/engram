/**
 * Public tool surface for the Engram unified memory plugin.
 * Consumers can import from "engram/tools" to get all agent-facing tools.
 *
 * Tool namespaces:
 *   context_*    — LCM conversation history navigation (DAG search, describe, expand)
 *   memory_*     — Long-term memory (capture, recall, search, query, world model, episodic)
 *   alignment_*  — Gradient alignment evaluation (P3 feature, stubs until integrated)
 *
 * Backward compatibility: lcm_* names are also exported alongside context_* aliases.
 */

// ── Context tools (LCM) — canonical names ────────────────────────────────────
export { createContextDescribeTool } from "../surface/context-compat.js";
export { createContextExpandTool } from "../surface/context-compat.js";
export { createContextGrepTool } from "../surface/context-compat.js";
export { createContextQueryTool } from "../surface/context-compat.js";

// ── Context tools (LCM) — legacy lcm_* names (backward compat) ───────────────
export { createLcmDescribeTool } from "../surface/lcm-describe-tool.js";
export { createLcmExpandQueryTool } from "../surface/lcm-expand-query-tool.js";
export { createLcmExpandTool } from "../surface/lcm-expand-tool.js";
export { createLcmGrepTool } from "../surface/lcm-grep-tool.js";

// ── Memory tools ──────────────────────────────────────────────────────────────
export { createMemoryAddTool } from "../surface/memory-add-tool.js";
export { createMemoryGetEntityTool } from "../surface/episodic-tools.js";
export { createMemoryGetEpisodeTool } from "../surface/episodic-tools.js";
export { createMemoryIngestNowTool } from "../surface/episodic-tools.js";
export { createMemoryJobStatusTool } from "../surface/episodic-tools.js";
export { createMemoryListAgentsTool } from "../surface/episodic-tools.js";
export { createMemoryNamespaceStatusTool } from "../surface/episodic-tools.js";
export { createMemoryQueryTool } from "../surface/memory-query-tool.js";
export { createMemoryRecallTool } from "../surface/memory-recall-tool.js";
export { createMemorySearchTool } from "../surface/memory-search-tool.js";
export { createMemoryWorldTool } from "../surface/memory-world-tool.js";

// ── Alignment tools (Gradient — P3 stubs) ────────────────────────────────────
export { createAlignmentCheckTool } from "../surface/alignment-tools.js";
export { createAlignmentDriftTool } from "../surface/alignment-tools.js";
export { createAlignmentStatusTool } from "../surface/alignment-tools.js";
