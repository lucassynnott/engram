import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IntegrityChecker,
  RepairEngine,
  repairPlan,
  collectMetrics,
} from "../src/graph/integrity.js";
import type {
  IntegrityReport,
  IntegrityCheck,
} from "../src/graph/integrity.js";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/memory/store/conversation-store.js";
import { SummaryStore } from "../src/memory/store/summary-store.js";

// ── Mock store factories ──────────────────────────────────────────────────────

function makeConversationStoreMock(overrides: Record<string, unknown> = {}) {
  const conversations: any[] = [];
  const messages: any[] = [];
  let nextConvId = 1;
  let nextMsgId = 1;

  return {
    getConversation: vi.fn(
      async (id: number) => conversations.find((c) => c.conversationId === id) ?? null,
    ),
    getMessageById: vi.fn(
      async (id: number) => messages.find((m) => m.messageId === id) ?? null,
    ),
    getMessages: vi.fn(async (convId: number) =>
      messages.filter((m) => m.conversationId === convId).sort((a: any, b: any) => a.seq - b.seq),
    ),
    getMessageCount: vi.fn(
      async (convId: number) => messages.filter((m) => m.conversationId === convId).length,
    ),
    // Helpers to seed data in tests
    _addConversation(convId: number) {
      conversations.push({ conversationId: convId, sessionId: `s-${convId}` });
    },
    _addMessage(msg: {
      messageId: number;
      conversationId: number;
      seq: number;
      tokenCount: number;
    }) {
      messages.push({ role: "user", content: "", createdAt: new Date(), ...msg });
    },
    ...overrides,
  };
}

function makeSummaryStoreMock(overrides: Record<string, unknown> = {}) {
  const summaries: any[] = [];
  const contextItems: any[] = [];
  const summaryMessages: Map<string, number[]> = new Map();
  const summaryParents: Map<string, string[]> = new Map(); // summaryId -> parentIds
  const largeFiles: any[] = [];

  return {
    getSummariesByConversation: vi.fn(
      async (convId: number) =>
        summaries.filter((s) => s.conversationId === convId),
    ),
    getSummary: vi.fn(
      async (summaryId: string) => summaries.find((s) => s.summaryId === summaryId) ?? null,
    ),
    getContextItems: vi.fn(
      async (convId: number) =>
        contextItems
          .filter((ci) => ci.conversationId === convId)
          .sort((a: any, b: any) => a.ordinal - b.ordinal),
    ),
    getContextTokenCount: vi.fn(async () => 0),
    getSummaryMessages: vi.fn(
      async (summaryId: string) => summaryMessages.get(summaryId) ?? [],
    ),
    getSummaryParents: vi.fn(async (summaryId: string) => {
      const parentIds = summaryParents.get(summaryId) ?? [];
      return parentIds.map((pid) => summaries.find((s) => s.summaryId === pid) ?? { summaryId: pid });
    }),
    getSummaryChildren: vi.fn(async (parentSummaryId: string) => {
      return summaries.filter((s) => {
        const parents = summaryParents.get(s.summaryId) ?? [];
        return parents.includes(parentSummaryId);
      });
    }),
    getLargeFilesByConversation: vi.fn(
      async (convId: number) => largeFiles.filter((f) => f.conversationId === convId),
    ),
    // Helpers to seed data in tests
    _addSummary(s: { summaryId: string; conversationId: number; kind: "leaf" | "condensed"; depth?: number; tokenCount?: number }) {
      summaries.push({
        kind: "leaf",
        depth: s.kind === "leaf" ? 0 : 1,
        tokenCount: 10,
        content: "",
        ...s,
      });
    },
    _addContextItem(ci: {
      conversationId: number;
      ordinal: number;
      itemType: "message" | "summary";
      messageId?: number | null;
      summaryId?: string | null;
    }) {
      contextItems.push({ messageId: null, summaryId: null, ...ci });
    },
    _linkSummaryMessages(summaryId: string, messageIds: number[]) {
      summaryMessages.set(summaryId, messageIds);
    },
    _linkSummaryParents(summaryId: string, parentIds: string[]) {
      summaryParents.set(summaryId, parentIds);
    },
    ...overrides,
  };
}

// ── IntegrityChecker tests ────────────────────────────────────────────────────

describe("IntegrityChecker", () => {
  describe("conversation_exists", () => {
    it("passes when conversation exists", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "conversation_exists")!;
      expect(check.status).toBe("pass");
    });

    it("fails when conversation does not exist", async () => {
      const convStore = makeConversationStoreMock();
      const summaryStore = makeSummaryStoreMock();
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(99);
      const check = report.checks.find((c) => c.name === "conversation_exists")!;
      expect(check.status).toBe("fail");
    });
  });

  describe("context_items_contiguous", () => {
    it("passes with no context items", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "context_items_contiguous")!;
      expect(check.status).toBe("pass");
    });

    it("passes with contiguous ordinals", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      convStore._addMessage({ messageId: 1, conversationId: 1, seq: 0, tokenCount: 10 });
      convStore._addMessage({ messageId: 2, conversationId: 1, seq: 1, tokenCount: 10 });
      const summaryStore = makeSummaryStoreMock();
      summaryStore._addContextItem({ conversationId: 1, ordinal: 0, itemType: "message", messageId: 1 });
      summaryStore._addContextItem({ conversationId: 1, ordinal: 1, itemType: "message", messageId: 2 });
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "context_items_contiguous")!;
      expect(check.status).toBe("pass");
    });

    it("fails with ordinal gaps", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      summaryStore._addContextItem({ conversationId: 1, ordinal: 0, itemType: "message", messageId: 1 });
      summaryStore._addContextItem({ conversationId: 1, ordinal: 2, itemType: "message", messageId: 2 });
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "context_items_contiguous")!;
      expect(check.status).toBe("fail");
      expect((check.details as any).gaps).toHaveLength(1);
    });
  });

  describe("context_items_valid_refs", () => {
    it("fails for dangling message reference", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      summaryStore._addContextItem({ conversationId: 1, ordinal: 0, itemType: "message", messageId: 999 });
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "context_items_valid_refs")!;
      expect(check.status).toBe("fail");
      expect((check.details as any).danglingRefs).toHaveLength(1);
    });

    it("fails for dangling summary reference", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      summaryStore._addContextItem({ conversationId: 1, ordinal: 0, itemType: "summary", summaryId: "missing-id" });
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "context_items_valid_refs")!;
      expect(check.status).toBe("fail");
    });

    it("passes when all refs are valid", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      convStore._addMessage({ messageId: 1, conversationId: 1, seq: 0, tokenCount: 10 });
      const summaryStore = makeSummaryStoreMock();
      summaryStore._addContextItem({ conversationId: 1, ordinal: 0, itemType: "message", messageId: 1 });
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "context_items_valid_refs")!;
      expect(check.status).toBe("pass");
    });
  });

  describe("summaries_have_lineage", () => {
    it("passes when leaf summary has message links", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      summaryStore._addSummary({ summaryId: "s1", conversationId: 1, kind: "leaf" });
      summaryStore._linkSummaryMessages("s1", [1]);
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "summaries_have_lineage")!;
      expect(check.status).toBe("pass");
    });

    it("fails when leaf summary has no message links", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      summaryStore._addSummary({ summaryId: "s1", conversationId: 1, kind: "leaf" });
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "summaries_have_lineage")!;
      expect(check.status).toBe("fail");
    });

    it("fails when condensed summary has no parent links", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      summaryStore._addSummary({ summaryId: "c1", conversationId: 1, kind: "condensed", depth: 1 });
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "summaries_have_lineage")!;
      expect(check.status).toBe("fail");
    });
  });

  describe("no_orphan_summaries", () => {
    it("warns when a summary is disconnected from the DAG", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      summaryStore._addSummary({ summaryId: "orphan", conversationId: 1, kind: "leaf" });
      // not referenced in context_items, not a parent of anything
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "no_orphan_summaries")!;
      expect(check.status).toBe("warn");
      expect((check.details as any).orphanedSummaryIds).toContain("orphan");
    });

    it("passes when summary is referenced in context_items", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      summaryStore._addSummary({ summaryId: "s1", conversationId: 1, kind: "leaf" });
      summaryStore._addContextItem({ conversationId: 1, ordinal: 0, itemType: "summary", summaryId: "s1" });
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "no_orphan_summaries")!;
      expect(check.status).toBe("pass");
    });
  });

  describe("message_seq_contiguous", () => {
    it("passes with no messages", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "message_seq_contiguous")!;
      expect(check.status).toBe("pass");
    });

    it("fails when seq values have gaps", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      convStore._addMessage({ messageId: 1, conversationId: 1, seq: 0, tokenCount: 5 });
      convStore._addMessage({ messageId: 2, conversationId: 1, seq: 2, tokenCount: 5 }); // gap at 1
      const summaryStore = makeSummaryStoreMock();
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "message_seq_contiguous")!;
      expect(check.status).toBe("fail");
    });
  });

  describe("no_duplicate_context_refs", () => {
    it("fails when same message is referenced twice", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      summaryStore._addContextItem({ conversationId: 1, ordinal: 0, itemType: "message", messageId: 1 });
      summaryStore._addContextItem({ conversationId: 1, ordinal: 1, itemType: "message", messageId: 1 });
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "no_duplicate_context_refs")!;
      expect(check.status).toBe("fail");
    });
  });

  describe("no_cyclic_summaries", () => {
    it("passes with no summaries", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "no_cyclic_summaries")!;
      expect(check.status).toBe("pass");
    });

    it("passes for a valid acyclic DAG", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      summaryStore._addSummary({ summaryId: "leaf1", conversationId: 1, kind: "leaf", depth: 0 });
      summaryStore._addSummary({ summaryId: "leaf2", conversationId: 1, kind: "leaf", depth: 0 });
      summaryStore._addSummary({ summaryId: "cond1", conversationId: 1, kind: "condensed", depth: 1 });
      // cond1 has parents leaf1 and leaf2
      summaryStore._linkSummaryParents("cond1", ["leaf1", "leaf2"]);
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "no_cyclic_summaries")!;
      expect(check.status).toBe("pass");
    });

    it("detects a direct self-loop cycle", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      summaryStore._addSummary({ summaryId: "s1", conversationId: 1, kind: "condensed", depth: 1 });
      // s1 is its own parent — self-loop
      summaryStore._linkSummaryParents("s1", ["s1"]);
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "no_cyclic_summaries")!;
      expect(check.status).toBe("fail");
      const edges = (check.details as any).cycleEdges as { summaryId: string; parentSummaryId: string }[];
      expect(edges.some((e) => e.summaryId === "s1" && e.parentSummaryId === "s1")).toBe(true);
    });

    it("detects a two-node cycle (A parent of B, B parent of A)", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      summaryStore._addSummary({ summaryId: "sA", conversationId: 1, kind: "condensed", depth: 1 });
      summaryStore._addSummary({ summaryId: "sB", conversationId: 1, kind: "condensed", depth: 1 });
      summaryStore._linkSummaryParents("sA", ["sB"]);
      summaryStore._linkSummaryParents("sB", ["sA"]);
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "no_cyclic_summaries")!;
      expect(check.status).toBe("fail");
    });
  });

  describe("summary_depth_consistency", () => {
    it("passes when all summaries have correct depth", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      summaryStore._addSummary({ summaryId: "leaf1", conversationId: 1, kind: "leaf", depth: 0 });
      summaryStore._addSummary({ summaryId: "cond1", conversationId: 1, kind: "condensed", depth: 1 });
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "summary_depth_consistency")!;
      expect(check.status).toBe("pass");
    });

    it("fails when leaf summary has depth != 0", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      summaryStore._addSummary({ summaryId: "badLeaf", conversationId: 1, kind: "leaf", depth: 2 });
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "summary_depth_consistency")!;
      expect(check.status).toBe("fail");
      const inconsistent = (check.details as any).inconsistent;
      expect(inconsistent[0].summaryId).toBe("badLeaf");
      expect(inconsistent[0].issue).toContain("leaf summary must have depth=0");
    });

    it("fails when condensed summary has depth 0", async () => {
      const convStore = makeConversationStoreMock();
      convStore._addConversation(1);
      const summaryStore = makeSummaryStoreMock();
      summaryStore._addSummary({ summaryId: "badCond", conversationId: 1, kind: "condensed", depth: 0 });
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(1);
      const check = report.checks.find((c) => c.name === "summary_depth_consistency")!;
      expect(check.status).toBe("fail");
      const inconsistent = (check.details as any).inconsistent;
      expect(inconsistent[0].summaryId).toBe("badCond");
      expect(inconsistent[0].issue).toContain("condensed summary must have depth > 0");
    });
  });

  describe("scan() report shape", () => {
    it("returns correct pass/fail/warn counts", async () => {
      const convStore = makeConversationStoreMock();
      const summaryStore = makeSummaryStoreMock();
      const checker = new IntegrityChecker(convStore as any, summaryStore as any);
      const report = await checker.scan(99);
      expect(report.conversationId).toBe(99);
      expect(report.checks.length).toBeGreaterThanOrEqual(10);
      expect(report.passCount + report.failCount + report.warnCount).toBe(report.checks.length);
      expect(report.scannedAt).toBeInstanceOf(Date);
    });
  });
});

// ── repairPlan tests ──────────────────────────────────────────────────────────

describe("repairPlan", () => {
  it("returns empty array for an all-pass report", () => {
    const report: IntegrityReport = {
      conversationId: 1,
      checks: [
        { name: "conversation_exists", status: "pass", message: "ok" },
        { name: "no_cyclic_summaries", status: "pass", message: "ok" },
      ],
      passCount: 2,
      failCount: 0,
      warnCount: 0,
      scannedAt: new Date(),
    };
    expect(repairPlan(report)).toEqual([]);
  });

  it("returns suggestions for no_cyclic_summaries failure", () => {
    const report: IntegrityReport = {
      conversationId: 1,
      checks: [
        {
          name: "no_cyclic_summaries",
          status: "fail",
          message: "cycle found",
          details: {
            cycleEdges: [{ summaryId: "sA", parentSummaryId: "sB" }],
          },
        },
      ],
      passCount: 0,
      failCount: 1,
      warnCount: 0,
      scannedAt: new Date(),
    };
    const suggestions = repairPlan(report);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toContain("sA");
    expect(suggestions[0]).toContain("sB");
  });

  it("returns suggestions for summary_depth_consistency failure", () => {
    const report: IntegrityReport = {
      conversationId: 1,
      checks: [
        {
          name: "summary_depth_consistency",
          status: "fail",
          message: "depth inconsistency",
          details: {
            inconsistent: [
              { summaryId: "bad-leaf", kind: "leaf", depth: 3, issue: "leaf summary must have depth=0, got depth=3" },
              { summaryId: "bad-cond", kind: "condensed", depth: 0, issue: "condensed summary must have depth > 0" },
            ],
          },
        },
      ],
      passCount: 0,
      failCount: 1,
      warnCount: 0,
      scannedAt: new Date(),
    };
    const suggestions = repairPlan(report);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]).toContain("bad-leaf");
    expect(suggestions[1]).toContain("bad-cond");
  });
});

// ── RepairEngine tests (real DB) ──────────────────────────────────────────────

describe("RepairEngine", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    closeLcmConnection();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTestDb() {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-integrity-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.db");
    const db = getLcmConnection(dbPath);
    runLcmMigrations(db);
    return db;
  }

  it("removeDanglingContextItems removes items referencing missing messages", async () => {
    const db = makeTestDb();
    const convStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db, { fts5Available: false });

    const conv = await convStore.createConversation({ sessionId: "test-session" });
    const convId = conv.conversationId;

    // Insert a real message
    const msg = await convStore.createMessage({
      conversationId: convId,
      seq: 0,
      role: "user",
      content: "hello",
      tokenCount: 5,
    });

    // Add context item for the real message and one more to keep
    await summaryStore.appendContextMessage(convId, msg.messageId);

    const msg2 = await convStore.createMessage({
      conversationId: convId,
      seq: 1,
      role: "user",
      content: "world",
      tokenCount: 5,
    });
    await summaryStore.appendContextMessage(convId, msg2.messageId);

    // Bypass FK enforcement to delete msg1 without removing its context item,
    // leaving a truly dangling reference
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("DELETE FROM messages WHERE message_id = ?").run(msg.messageId);
    db.exec("PRAGMA foreign_keys = ON");

    const repair = new RepairEngine(db, convStore, summaryStore);
    const removed = await repair.removeDanglingContextItems(convId);

    expect(removed).toBe(1);
    const remaining = await summaryStore.getContextItems(convId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].messageId).toBe(msg2.messageId);
    // Ordinals resequenced: should start at 0
    expect(remaining[0].ordinal).toBe(0);
  });

  it("removeOrphanSummaries deletes summaries not in context or lineage", async () => {
    const db = makeTestDb();
    const convStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db, { fts5Available: false });

    const conv = await convStore.createConversation({ sessionId: "test-session-2" });
    const convId = conv.conversationId;

    // Insert a real message and a leaf summary
    const msg = await convStore.createMessage({
      conversationId: convId,
      seq: 0,
      role: "user",
      content: "hi",
      tokenCount: 3,
    });

    // Create a referenced summary (in context)
    const refSummary = await summaryStore.insertSummary({
      summaryId: "ref-summary",
      conversationId: convId,
      kind: "leaf",
      depth: 0,
      content: "summary",
      tokenCount: 10,
    });
    await summaryStore.linkSummaryToMessages("ref-summary", [msg.messageId]);
    await summaryStore.appendContextSummary(convId, "ref-summary");

    // Create an orphaned summary
    await summaryStore.insertSummary({
      summaryId: "orphan-summary",
      conversationId: convId,
      kind: "leaf",
      depth: 0,
      content: "orphan",
      tokenCount: 5,
    });

    const repair = new RepairEngine(db, convStore, summaryStore);
    const removed = await repair.removeOrphanSummaries(convId);

    expect(removed).toBe(1);
    const remaining = await summaryStore.getSummariesByConversation(convId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].summaryId).toBe("ref-summary");
  });

  it("resequenceContextItems restores 0-based contiguous ordinals", async () => {
    const db = makeTestDb();
    const convStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db, { fts5Available: false });

    const conv = await convStore.createConversation({ sessionId: "test-session-3" });
    const convId = conv.conversationId;

    // Insert two messages with a gap in ordinals
    const m1 = await convStore.createMessage({ conversationId: convId, seq: 0, role: "user", content: "a", tokenCount: 1 });
    const m2 = await convStore.createMessage({ conversationId: convId, seq: 1, role: "user", content: "b", tokenCount: 1 });

    db.prepare(
      `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES (?, ?, 'message', ?)`,
    ).run(convId, 0, m1.messageId);
    db.prepare(
      `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES (?, ?, 'message', ?)`,
    ).run(convId, 5, m2.messageId); // gap

    const repair = new RepairEngine(db, convStore, summaryStore);
    await repair.resequenceContextItems(convId);

    const items = await summaryStore.getContextItems(convId);
    expect(items[0].ordinal).toBe(0);
    expect(items[1].ordinal).toBe(1);
  });

  it("breakSummaryCycleEdge removes the specified parent edge", async () => {
    const db = makeTestDb();
    const convStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db, { fts5Available: false });

    const conv = await convStore.createConversation({ sessionId: "test-session-4" });
    const convId = conv.conversationId;

    await summaryStore.insertSummary({ summaryId: "sA", conversationId: convId, kind: "condensed", depth: 1, content: "a", tokenCount: 5 });
    await summaryStore.insertSummary({ summaryId: "sB", conversationId: convId, kind: "condensed", depth: 1, content: "b", tokenCount: 5 });

    // Create a cycle: sA → sB and sB → sA
    await summaryStore.linkSummaryToParents("sA", ["sB"]);
    await summaryStore.linkSummaryToParents("sB", ["sA"]);

    // Verify cycle detected
    const checker = new IntegrityChecker(convStore, summaryStore);
    const reportBefore = await checker.scan(convId);
    const cycleBefore = reportBefore.checks.find((c) => c.name === "no_cyclic_summaries")!;
    expect(cycleBefore.status).toBe("fail");

    // Break the cycle by removing sA → sB edge
    const repair = new RepairEngine(db, convStore, summaryStore);
    repair.breakSummaryCycleEdge("sA", "sB");

    // Now only sB → sA remains (no cycle)
    const reportAfter = await checker.scan(convId);
    const cycleAfter = reportAfter.checks.find((c) => c.name === "no_cyclic_summaries")!;
    expect(cycleAfter.status).toBe("pass");
  });
});
