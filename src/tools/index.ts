/**
 * Public tool surface re-exports for engram plugin.
 * Consumers can import from "engram/tools" to get all agent-facing tools.
 */
export { createLcmDescribeTool } from "../surface/lcm-describe-tool.js";
export { createLcmExpandQueryTool } from "../surface/lcm-expand-query-tool.js";
export { createLcmExpandTool } from "../surface/lcm-expand-tool.js";
export { createLcmGrepTool } from "../surface/lcm-grep-tool.js";
export { createMemoryAddTool } from "../surface/memory-add-tool.js";
