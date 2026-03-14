import { createHash, randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MemoryKind =
  | "USER_FACT"
  | "PREFERENCE"
  | "DECISION"
  | "ENTITY"
  | "EPISODE"
  | "AGENT_IDENTITY"
  | "CONTEXT";

const VALID_KINDS: MemoryKind[] = [
  "USER_FACT",
  "PREFERENCE",
  "DECISION",
  "ENTITY",
  "EPISODE",
  "AGENT_IDENTITY",
  "CONTEXT",
];

// ── Schema ────────────────────────────────────────────────────────────────────

const MemoryAddSchema = Type.Object({
  content: Type.String({
    description: "The memory content to store. Required. Must be meaningful text, not system noise.",
  }),
  kind: Type.Optional(
    Type.String({
      description:
        'Memory kind/type. One of: USER_FACT, PREFERENCE, DECISION, ENTITY, EPISODE, AGENT_IDENTITY, CONTEXT. Inferred from content if omitted.',
      enum: VALID_KINDS,
    }),
  ),
  scope: Type.Optional(
    Type.String({
      description:
        'Memory scope. Defaults to "shared". Use a specific scope to isolate memories to a project or context.',
    }),
  ),
  entities: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Named entities to associate with this memory (people, projects, tools). Used to build entity linkage.",
    }),
  ),
});

// ── Table management ──────────────────────────────────────────────────────────

/** Tracks which DB paths have had memory tables initialized in this process. */
const _tablesInitialized = new WeakMap<DatabaseSync, boolean>();

function ensureMemoryTables(db: DatabaseSync, _dbPath: string): void {
  if (_tablesInitialized.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_current (
      memory_id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'CONTEXT',
      content TEXT NOT NULL,
      normalized TEXT NOT NULL DEFAULT '',
      normalized_hash TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      source_agent TEXT,
      source_session TEXT,
      confidence REAL DEFAULT 0.75,
      scope TEXT NOT NULL DEFAULT 'shared',
      status TEXT NOT NULL DEFAULT 'active',
      value_score REAL,
      value_label TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      last_reviewed_at TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      superseded_by TEXT,
      content_time TEXT,
      valid_until TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_current_status_scope
      ON memory_current(status, scope);
    CREATE INDEX IF NOT EXISTS idx_memory_current_norm
      ON memory_current(normalized_hash, scope, status);
    CREATE INDEX IF NOT EXISTS idx_memory_current_type
      ON memory_current(type, status);

    CREATE TABLE IF NOT EXISTS memory_episodes (
      episode_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      primary_entity_id TEXT,
      source_memory_ids TEXT NOT NULL DEFAULT '[]',
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_memory_episodes_entity
      ON memory_episodes(primary_entity_id, start_date);

    CREATE TABLE IF NOT EXISTS memory_events (
      event_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      component TEXT NOT NULL DEFAULT 'memory_add',
      action TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_memory_events_memory_ts
      ON memory_events(memory_id, timestamp);

    CREATE TABLE IF NOT EXISTS memory_entities (
      entity_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'person',
      display_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 0.7,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entities_name
      ON memory_entities(normalized_name);
  `);
  _tablesInitialized.set(db, true);
}

// ── Quality gates (ported from Gigabrain policy.js) ───────────────────────────

const WRAPPER_RE =
  /<\/?(?:memory_clusters|working_memory|recalled_memories|agent_profile|user_profile|gigabrain-context|context|system|tool_output)\b/i;

const JUNK_PATTERNS: RegExp[] = [
  /Read HEARTBEAT/i,
  /A new session was started/i,
  /^System:/i,
  /API_KEY=/,
  /_API_KEY=/,
  /SECRET=/,
  /PASSWORD=/,
  /Template placeholder/i,
  /\bsmoke test\b/i,
  /Post-Compaction Audit/i,
  /\[Subagent Context\]/,
  /Exec completed \(/,
  /\[System Message\] \[sessionId:/,
  /compaction audit/i,
  /subagent.*depth \d+\/\d+/i,
];

function normalizeContent(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\[m:[0-9a-f-]{8,}\]/gi, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashNormalized(value: string): string {
  const normalized = normalizeContent(value);
  if (!normalized) return "";
  return createHash("sha1").update(normalized).digest("hex");
}

type JunkResult = {
  junk: boolean;
  reason: string | null;
  matchedPattern: string | null;
};

function detectMetadataNoise(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^\[[^\]]+\]$/.test(trimmed)) return true;
  if (/^m:[0-9a-f-]{8,}$/i.test(trimmed)) return true;
  if (/^[A-Z_]+=$/.test(trimmed)) return true;
  const letters = (trimmed.match(/[a-z]/gi) ?? []).length;
  const digits = (trimmed.match(/[0-9]/g) ?? []).length;
  const punctuation = (trimmed.match(/[^a-z0-9\s]/gi) ?? []).length;
  if (letters <= 3 && digits + punctuation >= Math.max(6, trimmed.length * 0.6)) return true;
  if (/^(todo|tbd|n\/a|none)$/i.test(trimmed)) return true;
  return false;
}

function detectJunk(content: string): JunkResult {
  const text = content.trim();
  const MIN_CHARS = 12;

  if (!text) return { junk: true, reason: "empty", matchedPattern: null };
  if (WRAPPER_RE.test(text)) return { junk: true, reason: "junk_wrapper", matchedPattern: WRAPPER_RE.source };
  if (text.length < MIN_CHARS) return { junk: true, reason: "too_short", matchedPattern: null };
  for (const pattern of JUNK_PATTERNS) {
    if (pattern.test(text)) return { junk: true, reason: "junk_pattern", matchedPattern: pattern.source };
  }
  if (detectMetadataNoise(text)) return { junk: true, reason: "metadata_noise", matchedPattern: null };
  return { junk: false, reason: null, matchedPattern: null };
}

// ── Type inference ────────────────────────────────────────────────────────────

const TEMPORAL_RE =
  /\b(?:today|tonight|this morning|this afternoon|this evening|yesterday|last night|right now|currently|just now|an hour ago|\d+ (?:minutes?|hours?|days?) ago)\b/i;

const PREF_RE = /\b(?:user|owner|i)\s+(?:likes?|loves?|prefers?|dislikes?|hates?)\b/i;
const DECISION_RE = /\b(?:decided|decision|we will|we should|always|agreed to|going with)\b/i;
const AGENT_RE = /\b(?:agent identity|agent profile|my personality|agent continuity|agent evolution)\b/i;

function inferKind(content: string): MemoryKind {
  if (AGENT_RE.test(content)) return "AGENT_IDENTITY";
  if (PREF_RE.test(content)) return "PREFERENCE";
  if (DECISION_RE.test(content)) return "DECISION";
  if (TEMPORAL_RE.test(content)) return "EPISODE";
  return "USER_FACT";
}

function hasTemporalContext(content: string): boolean {
  return TEMPORAL_RE.test(content);
}

// ── Value scoring (simplified port from policy.js) ────────────────────────────

type ValueLabel = "core" | "situational" | "archive_candidate" | "low_value" | "junk";
type ValueAction = "keep" | "archive" | "reject";

type ClassifyResult = {
  action: ValueAction;
  value_label: ValueLabel;
  value_score: number;
  reason_codes: string[];
};

const OPS_NOISE_RE =
  /\b(?:run:|script|cron|pipeline|phase\s+\d+|openclaw\s+update|todo:|implement(?:ed|ation)?|api key|endpoint|webhook|token\b|ip address|192\.168\.)\b/i;
const PERSONAL_RE =
  /\b(?:user|owner)\s+(?:likes?|loves?|prefers?|dislikes?|hates?)\b/i;
const RELATIONSHIP_RE =
  /\b(?:partner(?:in)?|wife|husband|girlfriend|boyfriend|best friend|mentor|sibling|proud of|grateful|cares? for|means a lot to)\b/i;
const IDENTITY_RE =
  /\b(?:agent identity|my personality|agent continuity|identity|evolution)\b/i;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function baseTypeScore(type: MemoryKind): number {
  switch (type) {
    case "AGENT_IDENTITY": return 1.0;
    case "PREFERENCE": return 0.92;
    case "USER_FACT": return 0.9;
    case "ENTITY": return 0.85;
    case "DECISION": return 0.75;
    case "EPISODE": return 0.68;
    case "CONTEXT": return 0.5;
  }
}

function classifyValue(content: string, type: MemoryKind, confidence: number): ClassifyResult {
  const text = content.trim();
  const isPersonal = PERSONAL_RE.test(text);
  const isRelationship = RELATIONSHIP_RE.test(text);
  const isIdentity = IDENTITY_RE.test(text) || type === "AGENT_IDENTITY";
  const operationalNoise = clamp01(OPS_NOISE_RE.test(text) ? 0.75 : 0);
  const distinctTokens = new Set(normalizeContent(text).split(/\s+/).filter(Boolean)).size;
  const specificity = clamp01(Math.min(distinctTokens, 24) / 24 + (/[0-9]/.test(text) ? 0.1 : 0));
  const typeScore = baseTypeScore(type);
  const score = clamp01(
    (isPersonal ? 1 : 0) * 0.19 +
    (isRelationship ? 1 : 0) * 0.15 +
    (isIdentity ? 1 : 0) * 0.18 +
    clamp01(typeScore * 0.65 + confidence * 0.35) * 0.2 +
    0.8 * 0.08 + // manual entries always recency=1 (just created)
    specificity * 0.08 -
    operationalNoise * 0.15,
  );

  // Manual entries get a confidence boost — agent explicitly requested storage
  const adjustedScore = clamp01(score + 0.15);

  if (isIdentity) {
    return { action: "keep", value_label: "core", value_score: Math.max(adjustedScore, 0.9), reason_codes: ["agent_identity"] };
  }
  if (isPersonal || isRelationship) {
    return { action: "keep", value_label: "core", value_score: Math.max(adjustedScore, 0.82), reason_codes: ["durable_personal"] };
  }
  if (adjustedScore >= 0.78) {
    return { action: "keep", value_label: "core", value_score: adjustedScore, reason_codes: ["high_utility"] };
  }
  if (adjustedScore >= 0.3) {
    return { action: "keep", value_label: "situational", value_score: adjustedScore, reason_codes: ["manual_add_bias"] };
  }
  return { action: "archive", value_label: "archive_candidate", value_score: adjustedScore, reason_codes: ["low_value"] };
}

// ── Tool factory ──────────────────────────────────────────────────────────────

export function createMemoryAddTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_add",
    label: "Memory Add",
    description:
      "Manually store a fact, preference, decision, entity, or episode into long-term memory. " +
      "Content passes quality gates before storage. " +
      "Temporal content (today, yesterday, etc.) is automatically stored as an episode. " +
      "Params: content (required), kind (optional), scope (optional), entities (optional).",
    parameters: MemoryAddSchema,

    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;

      // ── Parse params ──────────────────────────────────────────────────────
      const content = typeof p.content === "string" ? p.content.trim() : "";
      if (!content) {
        return jsonResult({ error: "content is required and must be non-empty." });
      }

      const rawKind = typeof p.kind === "string" ? p.kind.trim().toUpperCase() : "";
      const kind: MemoryKind = VALID_KINDS.includes(rawKind as MemoryKind)
        ? (rawKind as MemoryKind)
        : inferKind(content);

      const scope =
        typeof p.scope === "string" && p.scope.trim()
          ? p.scope.trim()
          : "shared";

      const entities: string[] =
        Array.isArray(p.entities)
          ? (p.entities as unknown[])
              .map((e) => (typeof e === "string" ? e.trim() : ""))
              .filter(Boolean)
          : [];

      // ── Quality gate: junk detection ──────────────────────────────────────
      const junkResult = detectJunk(content);
      if (junkResult.junk) {
        return jsonResult({
          stored: false,
          reason: "rejected_quality_gate",
          gate: "junk",
          detail: junkResult.reason,
          matchedPattern: junkResult.matchedPattern ?? undefined,
          content,
        });
      }

      // ── Value classification ───────────────────────────────────────────────
      const MANUAL_CONFIDENCE = 0.75; // manual entries carry higher baseline confidence
      const classification = classifyValue(content, kind, MANUAL_CONFIDENCE);

      const isTemporalEpisode = kind === "EPISODE" || hasTemporalContext(content);
      const effectiveKind = isTemporalEpisode && kind !== "EPISODE" && hasTemporalContext(content)
        ? "EPISODE"
        : kind;

      // ── Store ─────────────────────────────────────────────────────────────
      const db = getLcmConnection(input.config.databasePath);
      ensureMemoryTables(db, input.config.databasePath);

      const now = new Date().toISOString();
      const memoryId = `mem_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const normalized = normalizeContent(content);
      const normalizedHash = hashNormalized(content);
      const status = classification.action === "archive" ? "archived" : "active";
      const archivedAt = status === "archived" ? now : null;
      const tags = entities.length > 0 ? JSON.stringify(entities) : "[]";

      const insertMemory = db.prepare(`
        INSERT INTO memory_current (
          memory_id, type, content, normalized, normalized_hash,
          source, confidence, scope, status,
          value_score, value_label,
          created_at, updated_at, archived_at, tags
        ) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertMemory.run(
        memoryId,
        effectiveKind,
        content,
        normalized,
        normalizedHash,
        MANUAL_CONFIDENCE,
        scope,
        status,
        classification.value_score,
        classification.value_label,
        now,
        now,
        archivedAt,
        tags,
      );

      // ── Episode creation ───────────────────────────────────────────────────
      let episodeId: string | null = null;
      if (isTemporalEpisode) {
        episodeId = `ep_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const title = content.length > 80 ? content.slice(0, 77) + "..." : content;
        const insertEpisode = db.prepare(`
          INSERT INTO memory_episodes (
            episode_id, title, summary, status,
            source_memory_ids, payload
          ) VALUES (?, ?, ?, 'completed', ?, '{}')
        `);
        insertEpisode.run(episodeId, title, content, JSON.stringify([memoryId]));
      }

      // ── Entity upsert ──────────────────────────────────────────────────────
      const linkedEntityIds: string[] = [];
      if (entities.length > 0) {
        for (const entityName of entities) {
          const normalizedName = entityName.toLowerCase().trim();
          const existing = db
            .prepare(`SELECT entity_id FROM memory_entities WHERE normalized_name = ? LIMIT 1`)
            .get(normalizedName) as { entity_id: string } | undefined;
          if (existing) {
            linkedEntityIds.push(existing.entity_id);
            db.prepare(`UPDATE memory_entities SET updated_at = ? WHERE entity_id = ?`)
              .run(now, existing.entity_id);
          } else {
            const entityId = `ent_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
            db.prepare(`
              INSERT INTO memory_entities (entity_id, kind, display_name, normalized_name, status, confidence, created_at, updated_at)
              VALUES (?, 'person', ?, ?, 'active', 0.7, ?, ?)
            `).run(entityId, entityName, normalizedName, now, now);
            linkedEntityIds.push(entityId);
          }
        }
      }

      // ── Audit event ───────────────────────────────────────────────────────
      const eventId = randomUUID();
      db.prepare(`
        INSERT INTO memory_events (event_id, timestamp, component, action, memory_id, source, payload)
        VALUES (?, ?, 'memory_add', 'store', ?, 'manual', ?)
      `).run(
        eventId,
        now,
        memoryId,
        JSON.stringify({
          kind: effectiveKind,
          scope,
          value_label: classification.value_label,
          value_score: classification.value_score,
          reason_codes: classification.reason_codes,
          episode_id: episodeId ?? undefined,
          entity_ids: linkedEntityIds.length > 0 ? linkedEntityIds : undefined,
        }),
      );

      // ── Build response ─────────────────────────────────────────────────────
      const lines: string[] = [];
      lines.push("## Memory stored");
      lines.push("");
      lines.push(`**ID:** \`${memoryId}\``);
      lines.push(`**Kind:** ${effectiveKind}`);
      lines.push(`**Scope:** ${scope}`);
      lines.push(`**Status:** ${status}`);
      lines.push(`**Value:** ${classification.value_label} (score: ${classification.value_score.toFixed(3)})`);
      if (episodeId) lines.push(`**Episode:** \`${episodeId}\``);
      if (linkedEntityIds.length > 0) lines.push(`**Entities linked:** ${linkedEntityIds.length}`);
      if (classification.action === "archive") {
        lines.push("");
        lines.push(
          `> Note: content was archived (low value score) but stored. Use \`memory_query\` to retrieve it.`,
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          stored: true,
          memoryId,
          kind: effectiveKind,
          scope,
          status,
          value_label: classification.value_label,
          value_score: classification.value_score,
          reason_codes: classification.reason_codes,
          episodeId: episodeId ?? null,
          entityIds: linkedEntityIds,
        },
      };
    },
  };
}
