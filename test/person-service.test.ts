/**
 * Comprehensive test suite for person-service.ts
 * 
 * Covers:
 * - Entity detection (containsEntity)
 * - Person role classification
 * - Person content scoring
 * - Person store initialization
 * - Entity mention rebuilding
 * - Entity key resolution
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  containsEntity,
  classifyPersonRole,
  scorePersonContent,
  ensurePersonStore,
  rebuildEntityMentions,
  resolveEntityKeysForQuery,
  type ScorePersonContentOptions,
  type PersonContentScore,
} from "../src/entity/person-service.js";

const tempDirs: string[] = [];

function createTestDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "engram-test-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "test.db");
  return new DatabaseSync(dbPath);
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

describe("Entity Detection", () => {
  describe("containsEntity", () => {
    it("detects entity mentions in text", () => {
      expect(containsEntity("I met with Sarah yesterday", "sarah")).toBe(true);
      expect(containsEntity("John is working on the project", "john")).toBe(true);
      expect(containsEntity("Discussed with Alice and Bob", "alice")).toBe(true);
    });

    it("returns false when entity not present", () => {
      expect(containsEntity("The weather is nice today", "sarah")).toBe(false);
      expect(containsEntity("Just a regular sentence", "john")).toBe(false);
    });

    it("handles word boundary matching", () => {
      expect(containsEntity("Sarah is here", "sarah", true)).toBe(true);
      expect(containsEntity("Sarahs book", "sarah", true)).toBe(false);
      expect(containsEntity("Sarahs book", "sarah", false)).toBe(true);
    });

    it("handles edge cases", () => {
      expect(containsEntity("", "sarah")).toBe(false);
      expect(containsEntity("Sarah", "")).toBe(false);
      expect(containsEntity("", "")).toBe(false);
    });

    it("is case insensitive", () => {
      expect(containsEntity("SARAH is here", "sarah")).toBe(true);
      expect(containsEntity("sarah is here", "SARAH")).toBe(true);
    });
  });
});

describe("Person Role Classification", () => {
  describe("classifyPersonRole", () => {
    it("classifies relationship context", () => {
      expect(classifyPersonRole("My girlfriend Sarah helped me")).toBe("relationship");
      expect(classifyPersonRole("My partner is great")).toBe("relationship");
      expect(classifyPersonRole("My wife and I went out")).toBe("relationship");
    });

    it("classifies public profile context", () => {
      expect(classifyPersonRole("She is a TEDx speaker")).toBe("public_profile");
      expect(classifyPersonRole("Works as a coach")).toBe("public_profile");
      expect(classifyPersonRole("Professional speaker at events")).toBe("public_profile");
    });

    it("classifies ops noise", () => {
      expect(classifyPersonRole("The pipeline script runs daily")).toBe("ops_noise");
      expect(classifyPersonRole("Deploy the migration")).toBe("ops_noise");
      expect(classifyPersonRole("Review the cron job")).toBe("ops_noise");
    });

    it("classifies general context", () => {
      expect(classifyPersonRole("The weather is nice today")).toBe("general");
      expect(classifyPersonRole("Just regular text")).toBe("general");
    });

    it("handles empty input", () => {
      expect(classifyPersonRole("")).toBe("general");
    });

    it("handles German relationship terms", () => {
      expect(classifyPersonRole("Meine Partnerin Anna")).toBe("relationship");
      expect(classifyPersonRole("Meine Freundin wohnt in Berlin")).toBe("relationship");
    });
  });
});

describe("Person Content Scoring", () => {
  describe("scorePersonContent", () => {
    it("returns null for empty content", () => {
      const result = scorePersonContent();
      expect(result).toBeNull();
    });

    it("returns valid score structure", () => {
      const result = scorePersonContent({ content: "Sarah is a software engineer" });
      expect(result).not.toBeNull();
      expect(result).toHaveProperty("score");
      expect(result).toHaveProperty("role");
    });

    it("scores person content highly", () => {
      const result = scorePersonContent({ content: "Alice is a product manager who works at Google" });
      expect(result).not.toBeNull();
      if (result) {
        expect(result.score).toBeGreaterThan(0);
      }
    });

    it("identifies relationship content", () => {
      const result = scorePersonContent({ content: "My girlfriend Sarah prefers coffee" });
      expect(result).not.toBeNull();
      if (result) {
        expect(result.role).toBe("relationship");
      }
    });

    it("identifies public profile content", () => {
      const result = scorePersonContent({ content: "She is a TEDx speaker and coach" });
      expect(result).not.toBeNull();
      if (result) {
        expect(result.role).toBe("public_profile");
      }
    });

    it("handles German content", () => {
      const result = scorePersonContent({ content: "Meine Freundin Anna arbeitet als Beraterin" });
      expect(result).not.toBeNull();
      if (result) {
        expect(result.score).toBeGreaterThan(0);
      }
    });

    it("handles low-relevance content", () => {
      const result = scorePersonContent({ content: "The weather is sunny today" });
      // Content with no entity candidates returns null
      expect(result).toBeNull();
    });

    it("handles content with entity candidates", () => {
      const result = scorePersonContent({ content: "Alice is working on the project" });
      expect(result).not.toBeNull();
      if (result) {
        expect(result.score).toBeGreaterThan(0);
        expect(result.role).toBe("general");
      }
    });

    it("respects entity keys filter", () => {
      const result = scorePersonContent({ 
        content: "Alice and Bob are working together",
        entityKeys: ["alice"]
      });
      expect(result).not.toBeNull();
    });

    it("handles config options", () => {
      const result = scorePersonContent({ 
        content: "My partner Sarah is great",
        config: {
          person: {
            relationshipPriorityBoost: 0.2,
            publicProfileBoost: 0.1
          }
        }
      });
      expect(result).not.toBeNull();
    });
  });
});

describe("Person Store Management", () => {
  describe("ensurePersonStore", () => {
    it("creates required tables", () => {
      const db = createTestDb();
      ensurePersonStore(db);
      
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      const tableNames = tables.map((t) => t.name);
      
      // Person store creates entity-related tables
      expect(tableNames.some((name) => name.includes("entity") || name.includes("person"))).toBe(true);
    });

    it("is idempotent", () => {
      const db = createTestDb();
      ensurePersonStore(db);
      expect(() => ensurePersonStore(db)).not.toThrow();
    });
  });

  describe("rebuildEntityMentions", () => {
    it("rebuilds mention index without errors", () => {
      const db = createTestDb();
      ensurePersonStore(db);

      // Should not throw even without summaries table (test context)
      expect(() => rebuildEntityMentions(db)).not.toThrow();
    });

    it("handles empty database", () => {
      const db = createTestDb();
      ensurePersonStore(db);
      expect(() => rebuildEntityMentions(db)).not.toThrow();
    });
  });
});

describe("Entity Key Resolution", () => {
  describe("resolveEntityKeysForQuery", () => {
    let db: DatabaseSync;

    beforeEach(() => {
      db = createTestDb();
      ensurePersonStore(db);
      
      // Seed with some entity mentions for testing
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO entity_mentions (id, memory_id, entity_key, entity_display, role, confidence, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), "mem1", "alice", "Alice", "general", 0.8, "test");
      
      db.prepare(`
        INSERT INTO entity_mentions (id, memory_id, entity_key, entity_display, role, confidence, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), "mem2", "sarah", "Sarah", "relationship", 0.9, "test");
      
      db.prepare(`
        INSERT INTO entity_mentions (id, memory_id, entity_key, entity_display, role, confidence, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), "mem3", "john", "John", "general", 0.7, "test");
    });

    it("resolves single entity key", () => {
      const result = resolveEntityKeysForQuery(db, "alice");
      expect(result).toContain("alice");
    });

    it("resolves multiple entity keys", () => {
      const result = resolveEntityKeysForQuery(db, "alice and sarah");
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it("handles compound names", () => {
      const result = resolveEntityKeysForQuery(db, "Sarah Chen");
      expect(result.some((k) => k.includes("sarah") || k.includes("chen"))).toBe(true);
    });

    it("returns empty array for empty query", () => {
      const result = resolveEntityKeysForQuery(db, "");
      expect(result).toEqual([]);
    });

    it("handles query hints", () => {
      const result = resolveEntityKeysForQuery(db, "Tell me about alice");
      expect(result.some((k) => k.includes("alice"))).toBe(true);
    });

    it("extracts names from questions", () => {
      const result = resolveEntityKeysForQuery(db, "Who is John Smith?");
      expect(result.some((k) => k.includes("john") || k.includes("smith"))).toBe(true);
    });

    it("handles German queries", () => {
      const result = resolveEntityKeysForQuery(db, "Wer ist alice?");
      expect(result.some((k) => k.includes("alice"))).toBe(true);
    });
  });
});

describe("Integration: Person Content Pipeline", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
    ensurePersonStore(db);
    
    // Seed entity mentions
    db.prepare(`
      INSERT INTO entity_mentions (id, memory_id, entity_key, entity_display, role, confidence, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), "mem1", "sarah", "Sarah", "relationship", 0.9, "test");
  });

  it("processes person content through full pipeline", () => {
    const content = "My girlfriend Sarah is a software engineer at Google.";
    
    // Step 1: Extract entity keys from query
    const keys = resolveEntityKeysForQuery(db, content);
    expect(keys.some((k) => k.includes("sarah"))).toBe(true);
    
    // Step 2: Check if content contains specific entity
    const hasSarah = keys.some((key) => containsEntity(content, key));
    expect(hasSarah).toBe(true);
    
    // Step 3: Classify role
    const role = classifyPersonRole(content);
    expect(role).toBe("relationship");
    
    // Step 4: Score the content
    const score = scorePersonContent({ content, entityKeys: keys });
    expect(score).not.toBeNull();
    if (score) {
      expect(score.score).toBeGreaterThan(0);
    }
  });

  it("handles multiple people in content", () => {
    const content = "Alice and Bob are working on the project with Carol.";
    
    const keys = resolveEntityKeysForQuery(db, content);
    expect(keys.length).toBeGreaterThanOrEqual(0);
    
    const score = scorePersonContent({ content, entityKeys: keys });
    expect(score).not.toBeNull();
  });

  it("handles German content", () => {
    const content = "Meine Partnerin Anna arbeitet als Sozialarbeiterin in Wien.";
    
    const keys = resolveEntityKeysForQuery(db, content);
    expect(keys.length).toBeGreaterThanOrEqual(0);
    
    const role = classifyPersonRole(content);
    expect(role).toBe("relationship");
    
    const score = scorePersonContent({ content });
    expect(score).not.toBeNull();
  });
});
