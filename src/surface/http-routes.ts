import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getLcmConnection, closeLcmConnection } from "../db/connection.js";
import { getLcmDbFeatures } from "../db/features.js";
import { ConversationStore } from "../memory/store/conversation-store.js";
import { SummaryStore } from "../memory/store/summary-store.js";
import type { LcmConfig } from "../db/config.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type LcmHttpHandlerOptions = {
  config: LcmConfig;
  /** Gateway auth token. When set, all non-health routes require it. */
  gatewayToken?: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const parseJsonBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 262144) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > 262144) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });

const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
};

const getBearerToken = (req: IncomingMessage): string => {
  const authorization = String(
    (req.headers as Record<string, string | string[] | undefined>)?.authorization ?? "",
  ).trim();
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ? String(match[1]).trim() : "";
};

const requireToken = (req: IncomingMessage, token: string | undefined): boolean => {
  const expectedToken = String(token ?? "").trim();
  if (!expectedToken) return true; // No token configured → open access
  const candidate = String(
    (req.headers as Record<string, string | string[] | undefined>)?.["x-memory-token"] ??
      (req.headers as Record<string, string | string[] | undefined>)?.["x-openclaw-token"] ??
      getBearerToken(req) ??
      "",
  ).trim();
  if (candidate.length !== expectedToken.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expectedToken));
};

const toNum = (v: string | null, fallback: number): number => {
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// ── Route table (for introspection) ──────────────────────────────────────────

export const MEMORY_HTTP_ROUTES = [
  { path: "/memory", match: "exact" },
  { path: "/memory/", match: "exact" },
  { path: "/memory/health", match: "exact" },
  { path: "/memory/conversations", match: "exact" },
  { path: "/memory/conversations/", match: "prefix" },
  { path: "/memory/summaries/", match: "prefix" },
  { path: "/memory/search", match: "exact" },
] as const;

// ── Handler factory ───────────────────────────────────────────────────────────

/**
 * Creates an HTTP handler for LCM web-console routes mounted at /memory/*.
 *
 * Routes:
 *   GET  /memory/                              – service info
 *   GET  /memory/health                        – health check
 *   GET  /memory/conversations                 – list conversations
 *   GET  /memory/conversations/:id             – get conversation
 *   GET  /memory/conversations/:id/messages    – list messages (raw)
 *   GET  /memory/conversations/:id/summaries   – list summaries (recall tree)
 *   GET  /memory/conversations/:id/context     – get ordered context items
 *   GET  /memory/summaries/:id                 – get summary detail
 *   GET  /memory/summaries/:id/subtree         – get full subtree under summary
 *   POST /memory/search                        – full-text / regex message search
 *
 * Auth: bearer token / x-memory-token / x-openclaw-token must match
 * the OpenClaw gateway auth token (config.gateway.auth.token) when set.
 *
 * Returns `true` when the request was handled, `false` otherwise.
 */
export const createLcmHttpHandler = (opts: LcmHttpHandlerOptions) => {
  const { config, gatewayToken } = opts;

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    try {
      if (!req?.url) return false;
      const full = new URL(req.url, "http://localhost");
      const pathname = full.pathname;
      const method = String(req.method ?? "GET").toUpperCase();

      // ── Service root ───────────────────────────────────────────────────────
      if (pathname === "/memory" || pathname === "/memory/") {
        sendJson(res, 200, { ok: true, service: "engram", version: "1.0" });
        return true;
      }

      // ── Health (no auth) ───────────────────────────────────────────────────
      if (pathname === "/memory/health" && method === "GET") {
        sendJson(res, 200, { ok: true });
        return true;
      }

      // ── All routes below require auth ──────────────────────────────────────
      if (!requireToken(req, gatewayToken)) {
        sendJson(res, 401, { detail: "invalid token" });
        return true;
      }

      // ── List conversations ─────────────────────────────────────────────────
      if (pathname === "/memory/conversations" && method === "GET") {
        const limit = Math.min(500, toNum(full.searchParams.get("limit"), 100));
        const offset = toNum(full.searchParams.get("offset"), 0);
        const db = getLcmConnection(config.databasePath);
        try {
          const rows = db
            .prepare(
              `SELECT conversation_id, session_id, title, bootstrapped_at, created_at, updated_at
               FROM conversations
               ORDER BY updated_at DESC
               LIMIT ? OFFSET ?`,
            )
            .all(limit, offset) as Array<{
            conversation_id: number;
            session_id: string;
            title: string | null;
            bootstrapped_at: string | null;
            created_at: string;
            updated_at: string;
          }>;
          const total = (
            db.prepare("SELECT COUNT(*) AS c FROM conversations").get() as { c: number }
          ).c;
          sendJson(res, 200, {
            ok: true,
            items: rows.map((r) => ({
              conversationId: r.conversation_id,
              sessionId: r.session_id,
              title: r.title,
              bootstrappedAt: r.bootstrapped_at,
              createdAt: r.created_at,
              updatedAt: r.updated_at,
            })),
            count: rows.length,
            total,
            limit,
            offset,
          });
        } finally {
          closeLcmConnection(config.databasePath);
        }
        return true;
      }

      // ── Conversation detail ────────────────────────────────────────────────
      const convMatch = pathname.match(/^\/memory\/conversations\/([^/]+)(?:\/([^/]*))?$/);
      if (convMatch) {
        const rawId = decodeURIComponent(convMatch[1] ?? "");
        const subpath = convMatch[2] ?? "";
        const conversationId = Number(rawId);

        if (!Number.isFinite(conversationId) || conversationId <= 0) {
          sendJson(res, 400, { detail: "invalid conversation id" });
          return true;
        }

        const db = getLcmConnection(config.databasePath);
        const { fts5Available } = getLcmDbFeatures(db);
        const convStore = new ConversationStore(db, { fts5Available });
        const sumStore = new SummaryStore(db, { fts5Available });

        try {
          const conv = await convStore.getConversation(conversationId);
          if (!conv) {
            sendJson(res, 404, { detail: "conversation not found" });
            return true;
          }

          // GET /memory/conversations/:id
          if (subpath === "" && method === "GET") {
            const msgCount = await convStore.getMessageCount(conversationId);
            const tokenCount = await sumStore.getContextTokenCount(conversationId);
            sendJson(res, 200, {
              ok: true,
              item: {
                conversationId: conv.conversationId,
                sessionId: conv.sessionId,
                title: conv.title,
                bootstrappedAt: conv.bootstrappedAt,
                createdAt: conv.createdAt,
                updatedAt: conv.updatedAt,
                messageCount: msgCount,
                contextTokenCount: tokenCount,
              },
            });
            return true;
          }

          // GET /memory/conversations/:id/messages
          if (subpath === "messages" && method === "GET") {
            const limit = Math.min(500, toNum(full.searchParams.get("limit"), 100));
            const afterSeq = toNum(full.searchParams.get("after_seq"), -1);
            const messages = await convStore.getMessages(conversationId, { afterSeq, limit });
            sendJson(res, 200, {
              ok: true,
              items: messages.map((m) => ({
                messageId: m.messageId,
                seq: m.seq,
                role: m.role,
                content: m.content,
                tokenCount: m.tokenCount,
                createdAt: m.createdAt,
              })),
              count: messages.length,
            });
            return true;
          }

          // GET /memory/conversations/:id/summaries
          if (subpath === "summaries" && method === "GET") {
            const summaries = await sumStore.getSummariesByConversation(conversationId);
            sendJson(res, 200, {
              ok: true,
              items: summaries.map((s) => ({
                summaryId: s.summaryId,
                kind: s.kind,
                depth: s.depth,
                tokenCount: s.tokenCount,
                descendantCount: s.descendantCount,
                earliestAt: s.earliestAt,
                latestAt: s.latestAt,
                createdAt: s.createdAt,
              })),
              count: summaries.length,
            });
            return true;
          }

          // GET /memory/conversations/:id/context
          if (subpath === "context" && method === "GET") {
            const items = await sumStore.getContextItems(conversationId);
            const tokenCount = await sumStore.getContextTokenCount(conversationId);
            sendJson(res, 200, {
              ok: true,
              contextTokenCount: tokenCount,
              items: items.map((ci) => ({
                ordinal: ci.ordinal,
                type: ci.itemType,
                refId: ci.itemType === "message" ? ci.messageId : ci.summaryId,
              })),
              count: items.length,
            });
            return true;
          }

          sendJson(res, 404, { detail: "not found" });
          return true;
        } finally {
          closeLcmConnection(config.databasePath);
        }
      }

      // ── Summary detail / subtree ───────────────────────────────────────────
      const sumMatch = pathname.match(/^\/memory\/summaries\/([^/]+)(?:\/([^/]*))?$/);
      if (sumMatch) {
        const summaryId = decodeURIComponent(sumMatch[1] ?? "");
        const subpath = sumMatch[2] ?? "";

        if (!summaryId) {
          sendJson(res, 400, { detail: "summary id required" });
          return true;
        }

        const db = getLcmConnection(config.databasePath);
        const { fts5Available } = getLcmDbFeatures(db);
        const sumStore = new SummaryStore(db, { fts5Available });

        try {
          const summary = await sumStore.getSummary(summaryId);
          if (!summary) {
            sendJson(res, 404, { detail: "summary not found" });
            return true;
          }

          // GET /memory/summaries/:id
          if (subpath === "" && method === "GET") {
            const parents = await sumStore.getSummaryParents(summaryId);
            const children = await sumStore.getSummaryChildren(summaryId);
            const sourceMessageIds = await sumStore.getSummaryMessages(summaryId);
            sendJson(res, 200, {
              ok: true,
              item: {
                summaryId: summary.summaryId,
                conversationId: summary.conversationId,
                kind: summary.kind,
                depth: summary.depth,
                content: summary.content,
                tokenCount: summary.tokenCount,
                descendantCount: summary.descendantCount,
                earliestAt: summary.earliestAt,
                latestAt: summary.latestAt,
                createdAt: summary.createdAt,
                parents: parents.map((p) => ({
                  summaryId: p.summaryId,
                  kind: p.kind,
                  depth: p.depth,
                })),
                children: children.map((c) => ({
                  summaryId: c.summaryId,
                  kind: c.kind,
                  depth: c.depth,
                })),
                sourceMessageIds,
              },
            });
            return true;
          }

          // GET /memory/summaries/:id/subtree
          if (subpath === "subtree" && method === "GET") {
            const subtree = await sumStore.getSummarySubtree(summaryId);
            sendJson(res, 200, {
              ok: true,
              rootSummaryId: summaryId,
              nodes: subtree.map((n) => ({
                summaryId: n.summaryId,
                depth: n.depth,
                kind: n.kind,
                tokenCount: n.tokenCount,
                descendantCount: n.descendantCount,
                earliestAt: n.earliestAt,
                latestAt: n.latestAt,
              })),
              count: subtree.length,
            });
            return true;
          }

          sendJson(res, 404, { detail: "not found" });
          return true;
        } finally {
          closeLcmConnection(config.databasePath);
        }
      }

      // ── Message search ─────────────────────────────────────────────────────
      if (pathname === "/memory/search" && method === "POST") {
        const body = await parseJsonBody(req);
        const query = String(body?.query ?? "").trim();
        if (!query) {
          sendJson(res, 400, { detail: "query required" });
          return true;
        }
        const mode = String(body?.mode ?? "full_text") as "full_text" | "regex";
        const limit = Math.min(200, Math.max(1, toNum(String(body?.limit ?? ""), 50)));
        const conversationIdRaw = body?.conversationId;
        const conversationId =
          conversationIdRaw != null && Number.isFinite(Number(conversationIdRaw))
            ? Number(conversationIdRaw)
            : undefined;

        const db = getLcmConnection(config.databasePath);
        const { fts5Available } = getLcmDbFeatures(db);
        const convStore = new ConversationStore(db, { fts5Available });

        try {
          const results = await convStore.searchMessages({
            query,
            mode: mode === "regex" ? "regex" : "full_text",
            conversationId,
            limit,
          });
          sendJson(res, 200, {
            ok: true,
            query,
            mode,
            results: results.map((r) => ({
              messageId: r.messageId,
              conversationId: r.conversationId,
              role: r.role,
              snippet: r.snippet,
              createdAt: r.createdAt,
              rank: r.rank,
            })),
            count: results.length,
          });
        } finally {
          closeLcmConnection(config.databasePath);
        }
        return true;
      }

      return false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { detail: "internal error", message: msg });
      return true;
    }
  };
};
