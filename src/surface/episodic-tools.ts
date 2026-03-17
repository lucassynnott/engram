import { Type } from "@sinclair/typebox";
import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

/**
 * Episodic/temporal memory tools.
 *
 * These tools map to OpenStinger Tier 1 tools (memory_get_entity,
 * memory_get_episode, memory_ingest_now, memory_namespace_status,
 * memory_list_agents, memory_job_status) but are implemented over
 * the unified SQLite schema instead of FalkorDB.
 *
 * Implementation status:
 * - memory_get_entity: fully implemented (reads memory_entities)
 * - memory_get_episode: fully implemented (reads memory_episodes)
 * - memory_namespace_status: fully implemented (stats query)
 * - memory_list_agents: stub — multi-agent namespacing is a P3 feature
 * - memory_ingest_now: stub — background ingestion scheduler is a P3 feature
 * - memory_job_status: stub — job queue is a P3 feature
 */

// ── memory_get_entity ────────────────────────────────────────────────────────

const GetEntitySchema = Type.Object({
  entityId: Type.String({
    description: "Entity UUID to look up.",
  }),
});

export function createMemoryGetEntityTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_get_entity",
    label: "Get Memory Entity",
    description:
      "Fetch a specific entity by UUID from the memory entity registry. " +
      "Returns entity metadata and associated memories. " +
      "Get entity IDs from memory_world or memory_search results.",
    parameters: GetEntitySchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const entityId = (typeof p.entityId === "string" ? p.entityId : "").trim();
      if (!entityId) {
        return jsonResult({ error: "entityId is required." });
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

      db.exec(`CREATE TABLE IF NOT EXISTS memory_entities (
        entity_id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'person',
        display_name TEXT NOT NULL, normalized_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', confidence REAL NOT NULL DEFAULT 0.7,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_current (
        memory_id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'CONTEXT',
        content TEXT NOT NULL, normalized TEXT NOT NULL DEFAULT '',
        normalized_hash TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual',
        source_agent TEXT, source_session TEXT, confidence REAL DEFAULT 0.75,
        scope TEXT NOT NULL DEFAULT 'shared', status TEXT NOT NULL DEFAULT 'active',
        value_score REAL, value_label TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        archived_at TEXT, last_reviewed_at TEXT, tags TEXT NOT NULL DEFAULT '[]',
        superseded_by TEXT, content_time TEXT, valid_until TEXT
      )`);

      const entity = db
        .prepare("SELECT * FROM memory_entities WHERE entity_id = ?")
        .get(entityId) as Record<string, unknown> | undefined;

      if (!entity) {
        return jsonResult({ error: `Entity not found: ${entityId}` });
      }

      // Fetch associated memories
      const memories = db
        .prepare(
          `SELECT memory_id, type, content, confidence, created_at
           FROM memory_current
           WHERE status = 'active' AND (tags LIKE ? OR content LIKE ?)
           ORDER BY confidence DESC LIMIT 10`,
        )
        .all(`%${entity.display_name}%`, `%${entity.display_name}%`) as Array<
        Record<string, unknown>
      >;

      return jsonResult({
        entity: {
          id: entity.entity_id,
          kind: entity.kind,
          name: entity.display_name,
          status: entity.status,
          confidence: entity.confidence,
          created_at: entity.created_at,
          updated_at: entity.updated_at,
        },
        memories: memories.map((m) => ({
          id: m.memory_id,
          kind: m.type,
          content: m.content,
          confidence: m.confidence,
          created_at: m.created_at,
        })),
      });
    },
  };
}

// ── memory_get_episode ───────────────────────────────────────────────────────

const GetEpisodeSchema = Type.Object({
  episodeId: Type.String({
    description: "Episode UUID to fetch.",
  }),
});

export function createMemoryGetEpisodeTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_get_episode",
    label: "Get Memory Episode",
    description:
      "Fetch a specific episode by UUID from the memory episode store. " +
      "Episodes are structured summaries of discrete events or decision points. " +
      "Get episode IDs from memory_search or memory_query results.",
    parameters: GetEpisodeSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const episodeId = (typeof p.episodeId === "string" ? p.episodeId : "").trim();
      if (!episodeId) {
        return jsonResult({ error: "episodeId is required." });
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

      db.exec(`CREATE TABLE IF NOT EXISTS memory_episodes (
        episode_id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL,
        start_date TEXT, end_date TEXT, status TEXT NOT NULL DEFAULT 'completed',
        primary_entity_id TEXT, source_memory_ids TEXT NOT NULL DEFAULT '[]',
        payload TEXT NOT NULL DEFAULT '{}'
      )`);

      const episode = db
        .prepare("SELECT * FROM memory_episodes WHERE episode_id = ?")
        .get(episodeId) as Record<string, unknown> | undefined;

      if (!episode) {
        return jsonResult({ error: `Episode not found: ${episodeId}` });
      }

      return jsonResult({
        episode: {
          id: episode.episode_id,
          title: episode.title,
          summary: episode.summary,
          start_date: episode.start_date,
          end_date: episode.end_date,
          status: episode.status,
          primary_entity_id: episode.primary_entity_id,
          source_memory_ids: (() => {
            try {
              return JSON.parse(episode.source_memory_ids as string);
            } catch {
              return [];
            }
          })(),
        },
      });
    },
  };
}

// ── memory_namespace_status ──────────────────────────────────────────────────

export function createMemoryNamespaceStatusTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_namespace_status",
    label: "Memory Namespace Status",
    description:
      "Check memory store health and statistics. " +
      "Returns counts of active memories, entities, episodes, and events. " +
      "Use this to verify the memory system is functioning and check capacity.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      let db: DatabaseSync;
      try {
        db = getLcmConnection(input.config.databasePath);
      } catch (err) {
        return jsonResult({
          status: "unavailable",
          error: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        const memoriesCount = (
          db
            .prepare("SELECT COUNT(*) AS c FROM memory_current WHERE status = 'active'")
            .get() as Record<string, unknown>
        )?.c ?? 0;
        const entitiesCount = (
          db
            .prepare("SELECT COUNT(*) AS c FROM memory_entities WHERE status = 'active'")
            .get() as Record<string, unknown>
        )?.c ?? 0;
        const episodesCount = (
          db.prepare("SELECT COUNT(*) AS c FROM memory_episodes").get() as Record<
            string,
            unknown
          >
        )?.c ?? 0;
        const eventsCount = (
          db.prepare("SELECT COUNT(*) AS c FROM memory_events").get() as Record<
            string,
            unknown
          >
        )?.c ?? 0;

        const byKind = db
          .prepare(
            "SELECT type, COUNT(*) AS c FROM memory_current WHERE status = 'active' GROUP BY type ORDER BY c DESC",
          )
          .all() as Array<Record<string, unknown>>;

        return jsonResult({
          status: "healthy",
          memories: { total: memoriesCount, byKind },
          entities: entitiesCount,
          episodes: episodesCount,
          events: eventsCount,
        });
      } catch (err) {
        return jsonResult({
          status: "degraded",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

// ── memory_list_agents ───────────────────────────────────────────────────────

export function createMemoryListAgentsTool(_input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_list_agents",
    label: "List Memory Agents",
    description:
      "List registered agent namespaces in the memory system. " +
      "Multi-agent namespacing is available in Engram v2 (P3 feature). " +
      "Currently returns the default namespace.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      return jsonResult({
        agents: [
          {
            namespace: "default",
            status: "active",
            note: "Multi-agent namespace isolation available in Engram v2 P3.",
          },
        ],
      });
    },
  };
}

// ── memory_ingest_now ────────────────────────────────────────────────────────

export function createMemoryIngestNowTool(_input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_ingest_now",
    label: "Trigger Memory Ingest",
    description:
      "Trigger immediate ingestion of pending session activity into long-term memory. " +
      "Background ingestion scheduler is a P3 feature. " +
      "Use memory_add to manually capture memories in the meantime.",
    parameters: Type.Object({
      sessionId: Type.Optional(
        Type.String({ description: "Session ID to ingest. Defaults to current session." }),
      ),
    }),
    async execute(_toolCallId, _params) {
      return jsonResult({
        status: "not_available",
        message:
          "Background ingestion scheduler is a P3 feature (not yet implemented). " +
          "Use memory_add to capture memories manually.",
      });
    },
  };
}

// ── memory_job_status ────────────────────────────────────────────────────────

export function createMemoryJobStatusTool(_input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_job_status",
    label: "Memory Job Status",
    description:
      "Check the status of a background ingestion job. " +
      "Background job queue is a P3 feature. " +
      "Returns not_available until the job scheduler is implemented.",
    parameters: Type.Object({
      jobId: Type.Optional(
        Type.String({ description: "Job ID to check. If omitted, returns queue summary." }),
      ),
    }),
    async execute(_toolCallId, _params) {
      return jsonResult({
        status: "not_available",
        message: "Background job queue is a P3 feature (not yet implemented).",
        queue: { pending: 0, running: 0, completed: 0, failed: 0 },
      });
    },
  };
}
