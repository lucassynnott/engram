import { Type } from "@sinclair/typebox";
import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

/**
 * memory_recall — fetch top-k memories ranked by confidence + recency.
 *
 * Unlike memory_search (keyword-driven), recall returns the highest-quality
 * stored memories for the current context, optionally filtered by scope and kind.
 * This is the "inject context at session start" tool: call it early in a session
 * to load relevant background about the user or project.
 */
const MemoryRecallSchema = Type.Object({
  topK: Type.Optional(
    Type.Number({
      description: "Number of memories to return (default: 8, max: 30).",
      minimum: 1,
      maximum: 30,
    }),
  ),
  scope: Type.Optional(
    Type.String({
      description:
        'Scope to recall from. Defaults to "shared". Pass a project name to recall project-scoped memories.',
    }),
  ),
  kinds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Limit recall to specific memory kinds: USER_FACT, PREFERENCE, DECISION, ENTITY, EPISODE, AGENT_IDENTITY, CONTEXT.",
    }),
  ),
  minConfidence: Type.Optional(
    Type.Number({
      description: "Minimum confidence threshold (default: 0.45, range: 0.0–1.0).",
      minimum: 0,
      maximum: 1,
    }),
  ),
  allScopes: Type.Optional(
    Type.Boolean({
      description: "Recall across all scopes.",
    }),
  ),
});

export function createMemoryRecallTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_recall",
    label: "Memory Recall",
    description:
      "Retrieve the most relevant long-term memories ranked by confidence and recency. " +
      "Use this at the start of a session to load user context, preferences, and key decisions. " +
      "Returns high-confidence memories first. " +
      "For keyword-specific lookup, prefer memory_search. " +
      "For temporal/date-filtered queries, prefer memory_query.",
    parameters: MemoryRecallSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const topK = typeof p.topK === "number" ? Math.min(Math.trunc(p.topK), 30) : 8;
      const minConfidence = typeof p.minConfidence === "number" ? p.minConfidence : 0.45;
      const scope =
        !p.allScopes && typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : null;

      let db: DatabaseSync;
      try {
        db = getLcmConnection(input.config.databasePath);
      } catch (err) {
        return jsonResult({
          error: "Memory store unavailable.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      db.exec(`CREATE TABLE IF NOT EXISTS memory_current (
        memory_id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'CONTEXT',
        content TEXT NOT NULL, normalized TEXT NOT NULL DEFAULT '',
        normalized_hash TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual',
        source_agent TEXT, source_session TEXT, confidence REAL DEFAULT 0.75,
        scope TEXT NOT NULL DEFAULT 'shared', status TEXT NOT NULL DEFAULT 'active',
        value_score REAL, value_label TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        archived_at TEXT, last_reviewed_at TEXT, tags TEXT NOT NULL DEFAULT '[]',
        superseded_by TEXT, content_time TEXT, valid_until TEXT
      )`);

      const where: string[] = ["status = 'active'", "confidence >= ?"];
      const queryParams: (string | number | null)[] = [minConfidence];

      if (scope) {
        where.push("scope = ?");
        queryParams.push(scope);
      }

      const kinds = Array.isArray(p.kinds)
        ? (p.kinds as unknown[]).filter((k): k is string => typeof k === "string").map((k) => k.toUpperCase())
        : [];
      if (kinds.length > 0) {
        where.push(`type IN (${kinds.map(() => "?").join(",")})`);
        queryParams.push(...kinds);
      }

      const sql = `
        SELECT memory_id, type, content, scope, confidence, value_score, tags, created_at
        FROM memory_current
        WHERE ${where.join(" AND ")}
        ORDER BY
          CASE type
            WHEN 'USER_FACT' THEN 1
            WHEN 'PREFERENCE' THEN 2
            WHEN 'AGENT_IDENTITY' THEN 3
            WHEN 'DECISION' THEN 4
            WHEN 'ENTITY' THEN 5
            WHEN 'EPISODE' THEN 6
            ELSE 7
          END ASC,
          confidence DESC,
          created_at DESC
        LIMIT ?
      `;
      queryParams.push(topK);

      const rows = db.prepare(sql).all(...queryParams) as Array<Record<string, unknown>>;

      const grouped: Record<string, Array<{ id: string; content: string; confidence: number }>> =
        {};
      for (const r of rows) {
        const kind = String(r.type);
        if (!grouped[kind]) grouped[kind] = [];
        grouped[kind].push({
          id: String(r.memory_id),
          content: String(r.content),
          confidence: Number(r.confidence),
        });
      }

      return jsonResult({
        recalled: rows.length,
        scope: scope ?? "all",
        minConfidence,
        grouped,
      });
    },
  };
}
