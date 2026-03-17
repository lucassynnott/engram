import type { LcmContextEngine } from "../context/engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { createLcmDescribeTool } from "./lcm-describe-tool.js";
import { createLcmExpandQueryTool } from "./lcm-expand-query-tool.js";
import { createLcmExpandTool } from "./lcm-expand-tool.js";
import { createLcmGrepTool } from "./lcm-grep-tool.js";

/**
 * context_* tools — canonical names for the LCM context navigation tools.
 *
 * These are thin wrappers over the existing lcm_* tools that expose them
 * under the unified `context_` namespace. Both names are registered so
 * existing agent prompts referencing lcm_* continue to work.
 *
 * Mapping:
 *   lcm_grep         → context_grep
 *   lcm_describe     → context_describe
 *   lcm_expand       → context_expand
 *   lcm_expand_query → context_query
 */

type LcmToolInput = {
  deps: LcmDependencies;
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
};

export function createContextGrepTool(input: LcmToolInput): AnyAgentTool {
  const base = createLcmGrepTool(input);
  return {
    ...base,
    name: "context_grep",
    label: "Context Grep",
    description:
      "Search compacted conversation context history using regex or full-text search. " +
      "Canonical name for lcm_grep. Both context_grep and lcm_grep are available. " +
      "Use this to find specific content that may have been compacted away from active context. " +
      "Returns matching snippets with IDs for follow-up with context_describe or context_expand.",
  };
}

export function createContextDescribeTool(input: LcmToolInput): AnyAgentTool {
  const base = createLcmDescribeTool(input);
  return {
    ...base,
    name: "context_describe",
    label: "Context Describe",
    description:
      "Inspect a specific conversation summary or file node by ID. " +
      "Canonical name for lcm_describe. Both context_describe and lcm_describe are available. " +
      "Returns the full content of a summary without spawning a sub-agent (fast, cheap). " +
      "Use this before context_expand to check if a summary has what you need.",
  };
}

export function createContextExpandTool(input: LcmToolInput): AnyAgentTool {
  const base = createLcmExpandTool(input);
  return {
    ...base,
    name: "context_expand",
    label: "Context Expand",
    description:
      "Expand summary IDs to retrieve the full conversation subtree. " +
      "Canonical name for lcm_expand. Both context_expand and lcm_expand are available. " +
      "Spawns a bounded sub-agent to traverse the DAG and return full content. " +
      "Use when context_describe shows you need detail that was compressed away.",
  };
}

export function createContextQueryTool(input: LcmToolInput): AnyAgentTool {
  const base = createLcmExpandQueryTool(input);
  return {
    ...base,
    name: "context_query",
    label: "Context Query",
    description:
      "Expand context and answer a focused question using the full conversation history. " +
      "Canonical name for lcm_expand_query. Both context_query and lcm_expand_query are available. " +
      "Best for: 'What exact error message appeared during X?', 'What config values were used?'. " +
      "Bounded sub-agent (~120s). Don't ration it for exact-detail questions.",
  };
}
