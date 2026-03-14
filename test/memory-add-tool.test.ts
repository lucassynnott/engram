import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryAddTool } from "../src/surface/memory-add-tool.js";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import type { LcmConfig } from "../src/db/config.js";

const TEST_DB_PATH = ":memory:";

function makeConfig(): LcmConfig {
  return {
    enabled: true,
    databasePath: TEST_DB_PATH,
    contextThreshold: 0.75,
    freshTailCount: 8,
    leafMinFanout: 8,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    incrementalMaxDepth: 0,
    leafChunkTokens: 20_000,
    leafTargetTokens: 600,
    condensedTargetTokens: 900,
    maxExpandTokens: 120,
    largeFileTokenThreshold: 25_000,
    largeFileSummaryProvider: "",
    largeFileSummaryModel: "",
    autocompactDisabled: false,
    timezone: "UTC",
    pruneHeartbeatOk: false,
  };
}

describe("memory_add tool", () => {
  let config: LcmConfig;

  beforeEach(() => {
    config = makeConfig();
  });

  afterEach(() => {
    closeLcmConnection(TEST_DB_PATH);
  });

  it("has the correct name and description", () => {
    const tool = createMemoryAddTool({ config });
    expect(tool.name).toBe("memory_add");
    expect(tool.description).toContain("Manually store");
  });

  it("stores a PREFERENCE memory successfully", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t1", {
      content: "Lucas prefers dark mode in all editor configurations",
      kind: "PREFERENCE",
      scope: "shared",
    });
    expect(result.details.stored).toBe(true);
    expect(result.details.kind).toBe("PREFERENCE");
    expect(result.details.scope).toBe("shared");
    expect(result.details.status).toBe("active");
    expect(result.details.memoryId).toMatch(/^mem_/);
  });

  it("persists to the database", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t1", {
      content: "Lucas is a senior software engineer who builds AI memory systems",
      kind: "USER_FACT",
    });
    expect(result.details.stored).toBe(true);

    // Verify it's actually in the DB
    const db = getLcmConnection(TEST_DB_PATH);
    const row = db
      .prepare("SELECT * FROM memory_current WHERE memory_id = ?")
      .get(result.details.memoryId) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.type).toBe("USER_FACT");
    expect(row?.scope).toBe("shared");
  });

  it("rejects junk content", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t2", { content: "API_KEY=abc123secret" });
    expect(result.details.stored).toBe(false);
    expect(result.details.reason).toBe("rejected_quality_gate");
    expect(result.details.gate).toBe("junk");
  });

  it("rejects content that is too short", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t3", { content: "hi" });
    expect(result.details.stored).toBe(false);
    expect(result.details.gate).toBe("junk");
    expect(result.details.detail).toBe("too_short");
  });

  it("rejects empty content", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t4", { content: "" });
    expect(result.details.error).toBeDefined();
  });

  it("returns error for missing content", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t5", {});
    expect(result.details.error).toBeDefined();
  });

  it("creates an episode for temporal content", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t6", {
      content: "Today Lucas finished implementing the memory_add tool for engram",
    });
    expect(result.details.stored).toBe(true);
    expect(result.details.kind).toBe("EPISODE");
    expect(result.details.episodeId).toMatch(/^ep_/);

    // Verify episode in DB
    const db = getLcmConnection(TEST_DB_PATH);
    const ep = db
      .prepare("SELECT * FROM memory_episodes WHERE episode_id = ?")
      .get(result.details.episodeId) as Record<string, unknown> | undefined;
    expect(ep).toBeDefined();
    expect(ep?.status).toBe("completed");
  });

  it("creates episode when kind is EPISODE explicitly", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t7", {
      content: "Lucas attended the OpenClaw architecture review session last week",
      kind: "EPISODE",
    });
    expect(result.details.kind).toBe("EPISODE");
    expect(result.details.episodeId).not.toBeNull();
  });

  it("links entities and creates them in the DB", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t8", {
      content: "Lucas and Viktor are collaborating on the engram plugin project",
      entities: ["Lucas", "Viktor"],
    });
    expect(result.details.stored).toBe(true);
    expect(result.details.entityIds).toHaveLength(2);

    const db = getLcmConnection(TEST_DB_PATH);
    const entities = db
      .prepare("SELECT * FROM memory_entities ORDER BY normalized_name")
      .all() as Array<Record<string, unknown>>;
    expect(entities.some((e) => e.normalized_name === "lucas")).toBe(true);
    expect(entities.some((e) => e.normalized_name === "viktor")).toBe(true);
  });

  it("infers kind from content when not provided", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t9", {
      content: "User prefers TypeScript over JavaScript for all new projects",
    });
    expect(result.details.stored).toBe(true);
    expect(result.details.kind).toBe("PREFERENCE");
  });

  it("defaults scope to 'shared'", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t10", {
      content: "Lucas is working on an AI-powered memory system for developer agents",
    });
    expect(result.details.scope).toBe("shared");
  });

  it("respects custom scope", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t11", {
      content: "This project uses TypeScript with strict null checks enabled everywhere",
      scope: "engram",
    });
    expect(result.details.scope).toBe("engram");
  });

  it("writes an audit event to memory_events", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t12", {
      content: "Lucas decided to use SQLite with WAL mode for the unified memory store",
      kind: "DECISION",
    });
    expect(result.details.stored).toBe(true);

    const db = getLcmConnection(TEST_DB_PATH);
    const event = db
      .prepare("SELECT * FROM memory_events WHERE memory_id = ?")
      .get(result.details.memoryId) as Record<string, unknown> | undefined;
    expect(event).toBeDefined();
    expect(event?.action).toBe("store");
    expect(event?.component).toBe("memory_add");
  });
});
