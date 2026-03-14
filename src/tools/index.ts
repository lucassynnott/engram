/**
 * Public tool surface re-exports for openclaw-memory plugin.
 * Consumers can import from "openclaw-memory/tools" to get all agent-facing tools.
 */
export { createLcmDescribeTool } from "../surface/lcm-describe-tool.js";
export { createLcmExpandQueryTool } from "../surface/lcm-expand-query-tool.js";
export { createLcmExpandTool } from "../surface/lcm-expand-tool.js";
export { createLcmGrepTool } from "../surface/lcm-grep-tool.js";
