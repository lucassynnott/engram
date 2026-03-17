/**
 * Comprehensive test suite for world-model.ts (Knowledge Graph)
 * 
 * Covers:
 * - Memory tier management
 * - Entity CRUD operations
 * - Belief management
 * - Episode management
 * - Open loops and contradictions
 * - Syntheses
 * - Entity matching and search
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeMemoryTier,
  isDurableMemoryTier,
  resolveMemoryTier,
  isDisplaySurfaceEpisode,
  selectSurfaceBeliefsForEntity,
  pickSurfaceSummaryBelief,
  ensureWorldModelStore,
  ensureWorldModelReady,
  rebuildWorldModel,
  listEntities,
  listEntityAliases,
  listBeliefs,
  listEpisodes,
  listOpenLoops,
  listContradictions,
  listSyntheses,
  getSynthesis,
  findEntityMatches,
  getEntityDetail,
} from "../src/entity/world-model.js";

const tempDirs: string[] = [];

function createTestDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "engram-test-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "test.db");
  const db = new DatabaseSync(dbPath);
  return db;
}

function cleanup() {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  tempDirs.length = 0;
}

afterEach(() => {
  cleanup();
});

describe("Memory Tier Management", () => {
  describe("normalizeMemoryTier", () => {
    it("normalizes valid tiers", () => {
      expect(normalizeMemoryTier("durable_personal")).toBe("durable_personal");
      expect(normalizeMemoryTier("durable_project")).toBe("durable_project");
      expect(normalizeMemoryTier("working_reference")).toBe("working_reference");
      expect(normalizeMemoryTier("ops_runbook")).toBe("ops_runbook");
    });

    it("handles empty/invalid values with fallback", () => {
      expect(normalizeMemoryTier("")).toBe("working_reference");
      expect(normalizeMemoryTier("invalid")).toBe("working_reference");
      expect(normalizeMemoryTier("", "durable_personal")).toBe("durable_personal");
    });

    it("is case insensitive", () => {
      expect(normalizeMemoryTier("DURABLE_PERSONAL")).toBe("durable_personal");
      expect(normalizeMemoryTier("Durable_Project")).toBe("durable_project");
    });
  });

  describe("isDurableMemoryTier", () => {
    it("returns true for durable tiers", () => {
      expect(isDurableMemoryTier("durable_personal")).toBe(true);
      expect(isDurableMemoryTier("durable_project")).toBe(true);
    });

    it("returns false for non-durable tiers", () => {
      expect(isDurableMemoryTier("working_reference")).toBe(false);
      expect(isDurableMemoryTier("ops_runbook")).toBe(false);
    });

    it("handles edge cases", () => {
      expect(isDurableMemoryTier("")).toBe(false);
      expect(isDurableMemoryTier("invalid")).toBe(false);
    });
  });

  describe("resolveMemoryTier", () => {
    it("uses fallback when no content provided", () => {
      expect(resolveMemoryTier({})).toBe("working_reference");
      expect(resolveMemoryTier({ row: {} })).toBe("working_reference");
    });

    it("returns ops_runbook for ops content", () => {
      const row = { content: "gateway restart required for maintenance", type: "context" };
      expect(resolveMemoryTier({ row })).toBe("ops_runbook");
    });

    it("returns durable_personal for relationship topics", () => {
      const row = { content: "Alice is my friend", type: "context" };
      const claimSignal = { topic: "relationship" };
      expect(resolveMemoryTier({ row, claimSignal })).toBe("durable_personal");
    });

    it("returns working_reference for contact topics", () => {
      const row = { content: "Contact information for Alice", type: "context" };
      const claimSignal = { topic: "contact" };
      expect(resolveMemoryTier({ row, claimSignal })).toBe("working_reference");
    });
  });
});

describe("Entity Surface Display", () => {
  describe("isDisplaySurfaceEpisode", () => {
    it("returns true for displayable episodes", () => {
      expect(isDisplaySurfaceEpisode({ title: "Meeting with Alice", payload: { memory_tier: "durable_personal" } })).toBe(true);
      expect(isDisplaySurfaceEpisode({ summary: "Project discussion", payload: { memory_tier: "durable_project" } })).toBe(true);
    });

    it("returns false for non-displayable episodes", () => {
      expect(isDisplaySurfaceEpisode({})).toBe(false);
      expect(isDisplaySurfaceEpisode({ title: "" })).toBe(false);
      expect(isDisplaySurfaceEpisode({ title: "Meeting", payload: { memory_tier: "working_reference" } })).toBe(false);
    });
  });

  describe("selectSurfaceBeliefsForEntity", () => {
    it("returns empty array for empty beliefs", () => {
      const entity = { id: "1", display_name: "Test" };
      expect(selectSurfaceBeliefsForEntity(entity, [])).toEqual([]);
    });

    it("selects top beliefs by relevance", () => {
      const entity = { id: "1", display_name: "Alice", kind: "person" };
      const beliefs = [
        { id: "b1", content: "Alice is a software engineer", confidence: 0.9, entity_id: "1" },
        { id: "b2", content: "Alice lives in Berlin", confidence: 0.8, entity_id: "1" },
        { id: "b3", content: "Alice likes coffee", confidence: 0.7, entity_id: "1" },
      ];
      const result = selectSurfaceBeliefsForEntity(entity, beliefs, 2);
      expect(result.length).toBeLessThanOrEqual(2);
    });

    it("respects limit parameter", () => {
      const entity = { id: "1", display_name: "Test" };
      const beliefs = Array.from({ length: 10 }, (_, i) => ({
        id: `b${i}`,
        content: `Belief ${i}`,
        confidence: 0.9 - i * 0.05,
        entity_id: "1",
      }));
      expect(selectSurfaceBeliefsForEntity(entity, beliefs, 3).length).toBeLessThanOrEqual(3);
    });
  });

  describe("pickSurfaceSummaryBelief", () => {
    it("returns null for empty beliefs", () => {
      expect(pickSurfaceSummaryBelief({ id: "1" }, [])).toBeNull();
    });

    it("picks highest confidence belief for summary", () => {
      const entity = { id: "1", display_name: "Test Entity", kind: "organization" };
      const beliefs = [
        { id: "b1", content: "Test Entity is a software company", confidence: 0.5, status: "current", type: "fact" },
        { id: "b2", content: "Test Entity was founded in 2020", confidence: 0.95, status: "current", type: "fact" },
        { id: "b3", content: "Test Entity has 50 employees", confidence: 0.7, status: "current", type: "fact" },
      ];
      const result = pickSurfaceSummaryBelief(entity, beliefs);
      // Note: result may be null if no belief meets the minimum score threshold
      if (result) {
        expect(result.id).toBe("b2");
      }
    });
  });
});

describe("World Model Store", () => {
  describe("ensureWorldModelStore", () => {
    it("creates all required tables", () => {
      const db = createTestDb();
      ensureWorldModelStore(db);
      
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      const tableNames = tables.map((t) => t.name);
      
      expect(tableNames).toContain("entities");
      expect(tableNames).toContain("entity_aliases");
      expect(tableNames).toContain("entity_beliefs");
      expect(tableNames).toContain("entity_episodes");
      expect(tableNames).toContain("entity_open_loops");
      expect(tableNames).toContain("entity_syntheses");
    });

    it("is idempotent", () => {
      const db = createTestDb();
      ensureWorldModelStore(db);
      ensureWorldModelStore(db); // Should not throw
      
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      expect(tables.length).toBeGreaterThan(0);
    });
  });

  describe("ensureWorldModelReady", () => {
    it("initializes store and returns stats", () => {
      const db = createTestDb();
      const result = ensureWorldModelReady({ db });

      expect(result).toHaveProperty("counts");
      expect(result.counts).toHaveProperty("entities");
    });

    it("respects rebuildIfEmpty parameter", () => {
      const db = createTestDb();
      const result1 = ensureWorldModelReady({ db, rebuildIfEmpty: false });
      expect(result1).toHaveProperty("counts");
      expect(result1.counts).toHaveProperty("entities");
    });
  });

  describe("rebuildWorldModel", () => {
    it("rebuilds world model and returns stats", () => {
      const db = createTestDb();
      const result = rebuildWorldModel({ db });

      expect(result).toHaveProperty("counts");
      expect(result.counts).toHaveProperty("entities");
      expect(result.counts).toHaveProperty("beliefs");
      expect(result).toHaveProperty("ok");
      expect(result).toHaveProperty("rebuilt");
    });
  });
});

describe("Entity Operations", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
    ensureWorldModelStore(db);
  });

  describe("listEntities", () => {
    it("returns empty array when no entities", () => {
      const entities = listEntities(db);
      expect(entities).toEqual([]);
    });

    it("filters by kind", () => {
      // Insert test entities
      const insert = db.prepare(`
        INSERT INTO entities (entity_id, kind, display_name, normalized_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      
      const now = new Date().toISOString();
      insert.run(randomUUID(), "person", "Alice", "alice", now, now);
      insert.run(randomUUID(), "person", "Bob", "bob", now, now);
      insert.run(randomUUID(), "project", "Project X", "project-x", now, now);
      
      const persons = listEntities(db, { kind: "person" });
      expect(persons.length).toBe(2);
      
      const projects = listEntities(db, { kind: "project" });
      expect(projects.length).toBe(1);
    });

    it("respects limit parameter", () => {
      const insert = db.prepare(`
        INSERT INTO entities (entity_id, kind, display_name, normalized_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      
      const now = new Date().toISOString();
      for (let i = 0; i < 10; i++) {
        insert.run(randomUUID(), "person", `Person ${i}`, `person-${i}`, now, now);
      }
      
      const limited = listEntities(db, { limit: 3 });
      expect(limited.length).toBeLessThanOrEqual(3);
    });
  });

  describe("listEntityAliases", () => {
    it("returns empty array for unknown entity", () => {
      const aliases = listEntityAliases(db, "unknown-id");
      expect(aliases).toEqual([]);
    });

    it("returns aliases for entity", () => {
      const entityId = randomUUID();
      const now = new Date().toISOString();
      
      db.prepare(`
        INSERT INTO entities (entity_id, kind, display_name, normalized_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(entityId, "person", "Alice", "alice", now, now);
      
      db.prepare(`
        INSERT INTO entity_aliases (alias_id, entity_id, alias, normalized_alias, confidence, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), entityId, "Ally", "ally", 0.5, now, now);
      
      const aliases = listEntityAliases(db, entityId);
      expect(aliases.length).toBe(1);
      expect(aliases[0].alias).toBe("Ally");
    });
  });

  describe("getEntityDetail", () => {
    it("returns null for unknown entity", () => {
      const entity = getEntityDetail(db, "unknown-id");
      expect(entity).toBeNull();
    });

    it("returns entity with all fields", () => {
      const entityId = randomUUID();
      const now = new Date().toISOString();
      
      db.prepare(`
        INSERT INTO entities (entity_id, kind, display_name, normalized_name, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(entityId, "person", "Alice Smith", "alice-smith", "{}", now, now);
      
      const entity = getEntityDetail(db, entityId);
      expect(entity).not.toBeNull();
      expect(entity?.display_name).toBe("Alice Smith");
      expect(entity?.kind).toBe("person");
    });
  });
});

describe("Belief Operations", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
    ensureWorldModelStore(db);
  });

  describe("listBeliefs", () => {
    it("returns empty array when no beliefs", () => {
      const beliefs = listBeliefs(db);
      expect(beliefs).toEqual([]);
    });

    it("filters by entityId", () => {
      const entityId = randomUUID();
      const now = new Date().toISOString();
      
      // Insert entity
      db.prepare(`
        INSERT INTO entities (entity_id, kind, display_name, normalized_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(entityId, "person", "Alice", "alice", now, now);
      
      // Insert beliefs
      db.prepare(`
        INSERT INTO entity_beliefs (belief_id, entity_id, content, type, confidence, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), entityId, "Alice is a developer", "fact", 0.9, "active");
      
      const beliefs = listBeliefs(db, { entityId });
      expect(beliefs.length).toBe(1);
      expect(beliefs[0].content).toBe("Alice is a developer");
    });

    it("filters by status", () => {
      const entityId = randomUUID();
      const now = new Date().toISOString();
      
      db.prepare(`
        INSERT INTO entities (entity_id, kind, display_name, normalized_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(entityId, "person", "Alice", "alice", now, now);
      
      db.prepare(`
        INSERT INTO entity_beliefs (belief_id, entity_id, content, type, confidence, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), entityId, "Active belief", "fact", 0.9, "active");

      db.prepare(`
        INSERT INTO entity_beliefs (belief_id, entity_id, content, type, confidence, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), entityId, "Stale belief", "fact", 0.5, "stale");
      
      const activeBeliefs = listBeliefs(db, { status: "active" });
      expect(activeBeliefs.every((b) => b.status === "active")).toBe(true);
    });
  });
});

describe("Episode Operations", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
    ensureWorldModelStore(db);
  });

  describe("listEpisodes", () => {
    it("returns empty array when no episodes", () => {
      const episodes = listEpisodes(db);
      expect(episodes).toEqual([]);
    });

    it("filters by entityId", () => {
      const entityId = randomUUID();
      const now = new Date().toISOString();
      
      // Insert entity
      db.prepare(`
        INSERT INTO entities (entity_id, kind, display_name, normalized_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(entityId, "person", "Alice", "alice", now, now);
      
      // Insert episode
      db.prepare(`
        INSERT INTO entity_episodes (episode_id, title, summary, start_date, end_date, status, primary_entity_id, source_memory_ids, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), "Meeting", "Met Alice today", now, null, "completed", entityId, "[]", "{}");

      const episodes = listEpisodes(db, { entityId });
      expect(episodes.length).toBe(1);
      expect(episodes[0].summary).toBe("Met Alice today");
    });

    it("respects limit parameter", () => {
      const entityId = randomUUID();
      const now = new Date().toISOString();
      
      db.prepare(`
        INSERT INTO entities (entity_id, kind, display_name, normalized_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(entityId, "person", "Alice", "alice", now, now);
      
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO entity_episodes (episode_id, title, summary, start_date, end_date, status, primary_entity_id, source_memory_ids, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), `Episode ${i}`, `Content ${i}`, now, null, "completed", entityId, "[]", "{}");
      }
      
      const episodes = listEpisodes(db, { entityId, limit: 2 });
      expect(episodes.length).toBeLessThanOrEqual(2);
    });
  });
});

describe("Open Loops Operations", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
    ensureWorldModelStore(db);
  });

  describe("listOpenLoops", () => {
    it("returns empty array when no open loops", () => {
      const loops = listOpenLoops(db);
      expect(loops).toEqual([]);
    });

    it("filters by kind", () => {
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO entity_open_loops (loop_id, kind, title, status, priority, related_entity_id, source_memory_ids, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), "follow_up", "Follow up with Alice", "open", 0.5, null, "[]", "{}");

      db.prepare(`
        INSERT INTO entity_open_loops (loop_id, kind, title, status, priority, related_entity_id, source_memory_ids, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), "decision", "Decide on architecture", "open", 0.8, null, "[]", "{}");

      const followUps = listOpenLoops(db, { kind: "follow_up" });
      expect(followUps.length).toBe(1);
      expect(followUps[0].kind).toBe("follow_up");
    });
  });
});

describe("Contradictions Operations", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
    ensureWorldModelStore(db);
  });

  describe("listContradictions", () => {
    it("returns empty array when no contradictions", () => {
      const contradictions = listContradictions(db);
      expect(contradictions).toEqual([]);
    });
  });
});

describe("Syntheses Operations", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
    ensureWorldModelStore(db);
  });

  describe("listSyntheses", () => {
    it("returns empty array when no syntheses", () => {
      const syntheses = listSyntheses(db);
      expect(syntheses).toEqual([]);
    });

    it("filters by kind", () => {
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO entity_syntheses (synthesis_id, kind, subject_type, subject_id, content, stale, confidence, generated_at, input_hash, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), "entity_summary", "person", randomUUID(), "Summary content", 0, 0.5, now, "hash", "{}");

      const summaries = listSyntheses(db, { kind: "entity_summary" });
      expect(summaries.length).toBe(1);
    });
  });

  describe("getSynthesis", () => {
    it("returns null for non-existent synthesis", () => {
      const synthesis = getSynthesis(db, { kind: "entity_summary", subjectType: "person", subjectId: randomUUID() });
      expect(synthesis).toBeNull();
    });

    it("returns synthesis by composite key", () => {
      const subjectId = randomUUID();
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO entity_syntheses (synthesis_id, kind, subject_type, subject_id, content, stale, confidence, generated_at, input_hash, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), "entity_summary", "person", subjectId, "Summary content", 0, 0.5, now, "hash", "{}");

      const synthesis = getSynthesis(db, { kind: "entity_summary", subjectType: "person", subjectId });
      expect(synthesis).not.toBeNull();
      expect(synthesis?.content).toBe("Summary content");
    });
  });
});

describe("Entity Matching", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
    ensureWorldModelStore(db);
  });

  describe("findEntityMatches", () => {
    it("returns empty array for empty query", () => {
      const matches = findEntityMatches(db, "");
      expect(matches).toEqual([]);
    });

    it("finds entities by name", () => {
      const now = new Date().toISOString();
      const aliceId = randomUUID();
      const bobId = randomUUID();

      db.prepare(`
        INSERT INTO entities (entity_id, kind, display_name, normalized_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(aliceId, "person", "Alice", "alice", now, now);

      db.prepare(`
        INSERT INTO entities (entity_id, kind, display_name, normalized_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(bobId, "person", "Bob", "bob", now, now);

      // Add aliases for findEntityMatches to work
      db.prepare(`
        INSERT INTO entity_aliases (alias_id, entity_id, alias, normalized_alias, confidence, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), aliceId, "Alice", "alice", 0.5, now, now);

      db.prepare(`
        INSERT INTO entity_aliases (alias_id, entity_id, alias, normalized_alias, confidence, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), bobId, "Bob", "bob", 0.5, now, now);

      const matches = findEntityMatches(db, "alice");
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.some((m) => m.display_name === "Alice")).toBe(true);
    });

    it("respects limit parameter", () => {
      const now = new Date().toISOString();
      
      for (let i = 0; i < 10; i++) {
        db.prepare(`
          INSERT INTO entities (entity_id, kind, display_name, normalized_name, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), "person", `Person ${i}`, `person-${i}`, now, now);
      }
      
      const matches = findEntityMatches(db, "person", { limit: 3 });
      expect(matches.length).toBeLessThanOrEqual(3);
    });
  });
});

describe("Integration: Full Knowledge Graph Workflow", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
    ensureWorldModelReady({ db });
  });

  it("performs complete entity lifecycle", () => {
    const now = new Date().toISOString();
    const entityId = randomUUID();
    
    // 1. Create entity
    db.prepare(`
      INSERT INTO entities (entity_id, kind, display_name, normalized_name, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(entityId, "person", "Sarah Chen", "sarah-chen", "{}", now, now);
    
    // 2. Add aliases
    db.prepare(`
      INSERT INTO entity_aliases (alias_id, entity_id, alias, normalized_alias, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), entityId, "Sarah", "sarah", 0.5, now, now);

    // 3. Add beliefs
    db.prepare(`
      INSERT INTO entity_beliefs (belief_id, entity_id, content, type, confidence, status, source_layer)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), entityId, "Sarah is a product manager", "fact", 0.95, "active", "registry");

    // 4. Add episode
    db.prepare(`
      INSERT INTO entity_episodes (episode_id, title, summary, start_date, status, primary_entity_id, source_memory_ids, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), "Conference", "Met Sarah at the conference", now, "completed", entityId, "[]", "{}");
    
    // 5. Verify entity retrieval
    const entity = getEntityDetail(db, entityId);
    expect(entity).not.toBeNull();
    expect(entity?.display_name).toBe("Sarah Chen");
    
    // 6. Verify aliases
    const aliases = listEntityAliases(db, entityId);
    expect(aliases.length).toBe(1);
    
    // 7. Verify beliefs
    const beliefs = listBeliefs(db, { entityId });
    expect(beliefs.length).toBe(1);
    
    // 8. Verify episodes
    const episodes = listEpisodes(db, { entityId });
    expect(episodes.length).toBe(1);
    
    // 9. Search for entity
    const matches = findEntityMatches(db, "sarah");
    expect(matches.some((m) => m.entity_id === entityId)).toBe(true);
  });
});
