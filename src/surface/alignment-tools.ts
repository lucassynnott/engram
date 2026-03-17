import { Type } from "@sinclair/typebox";
import type { LcmConfig } from "../db/config.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

/**
 * Alignment / Gradient tools.
 *
 * These map to OpenStinger Gradient MCP tools (gradient_status,
 * gradient_alignment_score, gradient_drift_status) renamed to the
 * unified `alignment_*` namespace.
 *
 * The Gradient alignment evaluator requires the alignment engine from
 * OpenStinger (P3 feature). These stubs return graceful degradation
 * responses until the evaluator is integrated.
 *
 * Renamed: gradient_status → alignment_status
 *          gradient_alignment_score → alignment_check
 *          gradient_drift_status → alignment_drift
 * Dropped:  gradient_alignment_log, gradient_alert, gradient_history
 *           (internal operational details — not needed in agent tool surface)
 */

// ── alignment_status ─────────────────────────────────────────────────────────

export function createAlignmentStatusTool(_input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "alignment_status",
    label: "Alignment Status",
    description:
      "Check the alignment engine health, profile state, and current mode. " +
      "Returns whether alignment evaluation is active, the current profile, " +
      "and whether observe-only mode is enabled. " +
      "Requires Gradient alignment engine (Engram v2 P3 feature).",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      return jsonResult({
        status: "not_available",
        mode: "observe",
        observe_only: true,
        message:
          "Gradient alignment engine requires Engram v2 P3 integration. " +
          "Currently running in passive observe mode.",
      });
    },
  };
}

// ── alignment_check ──────────────────────────────────────────────────────────

export function createAlignmentCheckTool(_input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "alignment_check",
    label: "Alignment Check",
    description:
      "Evaluate a text passage or action against the agent's alignment profile. " +
      "Returns a score (0.0–1.0) and pass/warn/fail verdict. " +
      "Requires Gradient alignment engine (Engram v2 P3 feature).",
    parameters: Type.Object({
      text: Type.String({
        description: "Text or action description to evaluate for alignment.",
      }),
      context: Type.Optional(
        Type.String({
          description: "Additional context for the evaluation.",
        }),
      ),
    }),
    async execute(_toolCallId, _params) {
      return jsonResult({
        status: "not_available",
        score: null,
        verdict: "unknown",
        message:
          "Gradient alignment engine requires Engram v2 P3 integration. " +
          "Alignment evaluation is not yet active.",
      });
    },
  };
}

// ── alignment_drift ──────────────────────────────────────────────────────────

export function createAlignmentDriftTool(_input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "alignment_drift",
    label: "Alignment Drift Status",
    description:
      "Get rolling window alignment drift statistics. " +
      "Shows pass rate trends and whether drift thresholds have been exceeded. " +
      "Requires Gradient alignment engine (Engram v2 P3 feature).",
    parameters: Type.Object({
      windowDays: Type.Optional(
        Type.Number({
          description: "Number of days to compute drift over (default: 7).",
          minimum: 1,
          maximum: 90,
        }),
      ),
    }),
    async execute(_toolCallId, _params) {
      return jsonResult({
        status: "not_available",
        drift: null,
        pass_rate: null,
        message:
          "Gradient alignment engine requires Engram v2 P3 integration. " +
          "Drift monitoring is not yet active.",
      });
    },
  };
}
