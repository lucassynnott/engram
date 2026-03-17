import { Type } from "@sinclair/typebox";
import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
import { getLcmDbFeatures } from "../db/features.js";
import { sanitizeFts5Query } from "../memory/store/fts5-sanitize.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const MemorySearchSchema = Type.Object({
  query: Type.String({
    description: "Search query. Supports natural language and keywords.",
  }),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum results to return (default: 10, max: 50).",
      minimum: 1,
      maximum: 50,
    }),
  ),
  scope: Type.Optional(
    Type.String({
      description:
        'Scope filter. Defaults to "shared". Pass a project name to search project-scoped memories.',
    }),
  ),
  kind: Type.Optional(
    Type.String({
      description:
        "Filter by memory kind: USER_FACT, PREFERENCE, DECISION, ENTITY, EPISODE, AGENT_IDENTITY, CONTEXT.",
      enum: [
        "USER_FACT",
        "PREFERENCE",
        "DECISION",
        "ENTITY",
        "EPISODE",
        "AGENT_IDENTITY",
        "CONTEXT",
      ],
    }),
  ),
  allScopes: Type.Optional(
    Type.Boolean({
      description: "Search across all scopes instead of limiting to scope param.",
    }),
  ),
});

type SQLParam = string | number | null;

function buildBaseWhere(p: Record<string, unknown>): { where: string[]; params: SQLParam[] } {
  const where: string[] = ["status = 'active'"];
  const params: SQLParam[] = [];

  if (!p.allScopes) {
    const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : "shared";
    where.push("scope = ?");
    params.push(scope);
  }

  if (typeof p.kind === "string" && p.kind.trim()) {
    where.push("type = ?");
    params.push(p.kind.trim().toUpperCase());
  }

  return { where, params };
}

export function createMemorySearchTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search long-term memory for relevant facts, preferences, decisions, and entities. " +
      "Uses full-text search with keyword fallback. " +
      "Returns memories ranked by confidence. " +
      "Use this when you need to recall what is known about a person, project, or topic. " +
      "For temporal/date-filtered queries, prefer memory_query.",
    parameters: MemorySearchSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const query = (typeof p.query === "string" ? p.query : "").trim();
      if (!query) {
        return jsonResult({ error: "query is required." });
      }
      const limit = typeof p.limit === "number" ? Math.min(Math.trunc(p.limit), 50) : 10;

      let db: DatabaseSync;
      try {
        db = getLcmConnection(input.config.databasePath);
      } catch (err) {
        return jsonResult({
          error: "Memory store unavailable.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      // Ensure table exists (no-op if already created by memory_add)
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

      const { where, params: baseParams } = buildBaseWhere(p);
      const features = getLcmDbFeatures(db);

      let rows: Array<Record<string, unknown>> = [];

      // Try FTS5 virtual table if available
      if (features.fts5Available) {
        try {
          const ftsQuery = sanitizeFts5Query(query);
          const sql = `
            SELECT memory_id, type, content, scope, confidence, value_score, tags, created_at
            FROM memory_current
            WHERE ${[...where, "memory_id IN (SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ?)"].join(" AND ")}
            ORDER BY confidence DESC, created_at DESC
            LIMIT ?
          `;
          rows = db.prepare(sql).all(...baseParams, ftsQuery, limit) as Array<
            Record<string, unknown>
          >;
        } catch {
          // FTS virtual table not yet set up — fall through to LIKE
        }
      }

      // LIKE fallback
      if (rows.length === 0) {
        const tokens = query.split(/\s+/).filter(Boolean).slice(0, 6);
        const likeWhere = tokens.map(() => "content LIKE ?");
        const likeParams = tokens.map((t) => `%${t}%`);
        const sql = `
          SELECT memory_id, type, content, scope, confidence, value_score, tags, created_at
          FROM memory_current
          WHERE ${[...where, ...likeWhere].join(" AND ")}
          ORDER BY confidence DESC, created_at DESC
          LIMIT ?
        `;
        rows = db.prepare(sql).all(...baseParams, ...likeParams, limit) as Array<
          Record<string, unknown>
        >;
      }

      return jsonResult({
        query,
        count: rows.length,
        memories: rows.map((r) => ({
          id: r.memory_id,
          kind: r.type,
          content: r.content,
          scope: r.scope,
          confidence: r.confidence,
          value_score: r.value_score,
          tags: (() => {
            try {
              return JSON.parse(r.tags as string);
            } catch {
              return [];
            }
          })(),
          created_at: r.created_at,
        })),
      });
    },
  };
}
