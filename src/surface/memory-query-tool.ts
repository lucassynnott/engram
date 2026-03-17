import { Type } from "@sinclair/typebox";
import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
import { sanitizeFts5Query } from "../memory/store/fts5-sanitize.js";
import { getLcmDbFeatures } from "../db/features.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

/**
 * memory_query — temporal/date-filtered memory query.
 *
 * Combines keyword/semantic search with optional date range filtering
 * against the content_time field. Maps to OpenStinger's memory_query
 * (BM25 + date filtering) but implemented over the unified SQLite store.
 */
const MemoryQuerySchema = Type.Object({
  query: Type.String({
    description: "The question or topic to search for.",
  }),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum results (default: 10, max: 50).",
      minimum: 1,
      maximum: 50,
    }),
  ),
  afterDate: Type.Optional(
    Type.String({
      description: 'ISO date lower bound for content_time. Format: "YYYY-MM-DD" or "YYYY-MM".',
    }),
  ),
  beforeDate: Type.Optional(
    Type.String({
      description: 'ISO date upper bound for content_time. Format: "YYYY-MM-DD" or "YYYY-MM".',
    }),
  ),
  scope: Type.Optional(
    Type.String({
      description: 'Scope filter. Defaults to "shared".',
    }),
  ),
  allScopes: Type.Optional(
    Type.Boolean({
      description: "Query across all scopes.",
    }),
  ),
  includeExpired: Type.Optional(
    Type.Boolean({
      description: "Include memories past their valid_until date. Default: false.",
    }),
  ),
});

function parseDate(s: string): string | null {
  // Accept YYYY-MM-DD or YYYY-MM — normalize to YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  return null;
}

export function createMemoryQueryTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_query",
    label: "Memory Query",
    description:
      "Query long-term memory with optional date range filtering. " +
      "Combines keyword search with temporal filtering on content_time. " +
      'Use this for questions like "what happened in March 2026" or ' +
      '"what decisions were made about project X last quarter". ' +
      "For unfiltered keyword search, prefer memory_search.",
    parameters: MemoryQuerySchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const query = (typeof p.query === "string" ? p.query : "").trim();
      if (!query) {
        return jsonResult({ error: "query is required." });
      }
      const limit = typeof p.limit === "number" ? Math.min(Math.trunc(p.limit), 50) : 10;
      const includeExpired = Boolean(p.includeExpired);

      const afterDate =
        typeof p.afterDate === "string" ? parseDate(p.afterDate.trim()) : null;
      const beforeDate =
        typeof p.beforeDate === "string" ? parseDate(p.beforeDate.trim()) : null;

      if (p.afterDate && !afterDate) {
        return jsonResult({ error: `Invalid afterDate: "${p.afterDate}". Use YYYY-MM-DD format.` });
      }
      if (p.beforeDate && !beforeDate) {
        return jsonResult({ error: `Invalid beforeDate: "${p.beforeDate}". Use YYYY-MM-DD format.` });
      }

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

      const where: string[] = ["status = 'active'"];
      const queryParams: (string | number | null)[] = [];

      if (!p.allScopes) {
        const scope =
          typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : "shared";
        where.push("scope = ?");
        queryParams.push(scope);
      }

      if (!includeExpired) {
        where.push("(valid_until IS NULL OR valid_until >= date('now'))");
      }

      if (afterDate) {
        where.push("(content_time IS NULL OR content_time >= ?)");
        queryParams.push(afterDate);
      }
      if (beforeDate) {
        where.push("(content_time IS NULL OR content_time <= ?)");
        queryParams.push(beforeDate);
      }

      const features = getLcmDbFeatures(db);
      let rows: Array<Record<string, unknown>> = [];

      if (features.fts5Available) {
        try {
          const ftsQuery = sanitizeFts5Query(query);
          const sql = `
            SELECT memory_id, type, content, scope, confidence, content_time, tags, created_at
            FROM memory_current
            WHERE ${[...where, "memory_id IN (SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ?)"].join(" AND ")}
            ORDER BY confidence DESC, content_time DESC NULLS LAST, created_at DESC
            LIMIT ?
          `;
          rows = db.prepare(sql).all(...queryParams, ftsQuery, limit) as Array<
            Record<string, unknown>
          >;
        } catch {
          // FTS table not ready
        }
      }

      if (rows.length === 0) {
        const tokens = query.split(/\s+/).filter(Boolean).slice(0, 6);
        const likeWhere = tokens.map(() => "content LIKE ?");
        const likeParams = tokens.map((t) => `%${t}%`);
        const sql = `
          SELECT memory_id, type, content, scope, confidence, content_time, tags, created_at
          FROM memory_current
          WHERE ${[...where, ...likeWhere].join(" AND ")}
          ORDER BY confidence DESC, content_time DESC NULLS LAST, created_at DESC
          LIMIT ?
        `;
        rows = db.prepare(sql).all(...queryParams, ...likeParams, limit) as Array<
          Record<string, unknown>
        >;
      }

      return jsonResult({
        query,
        afterDate,
        beforeDate,
        count: rows.length,
        memories: rows.map((r) => ({
          id: r.memory_id,
          kind: r.type,
          content: r.content,
          scope: r.scope,
          confidence: r.confidence,
          content_time: r.content_time,
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
