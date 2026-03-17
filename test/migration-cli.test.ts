import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  runEngramMigration,
  migrateConfigV1ToV2,
  rollbackMigration,
  parseMigrateArgs,
  type MigrationOptions,
} from "../src/cli/migrate.js";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "engram-migration-test-"));
  tempDirs.push(dir);
  return dir;
}

function createV1Database(dbPath: string): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new DatabaseSync(dbPath);
  
  // Create v1 schema (minimal LCM schema)
  db.exec(`
    CREATE TABLE conversations (
      conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      title TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE messages (
      message_id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (conversation_id, seq)
    );

    CREATE TABLE summaries (
      summary_id TEXT PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('leaf', 'condensed')),
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      file_ids TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE summary_messages (
      summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
      message_id INTEGER NOT NULL REFERENCES messages(message_id) ON DELETE RESTRICT,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (summary_id, message_id)
    );

    CREATE TABLE summary_parents (
      summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
      parent_summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE RESTRICT,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (summary_id, parent_summary_id)
    );
  `);

  // Insert test data
  db.prepare(`INSERT INTO conversations (conversation_id, session_id, title) VALUES (?, ?, ?)`)
    .run(1, "test-session", "Test Conversation");
  
  db.prepare(`INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(1, 1, 1, "user", "Hello", 1);
  db.prepare(`INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(2, 1, 2, "assistant", "Hi there!", 3);
  
  db.prepare(`INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, ?, ?, ?, ?)`)
    .run("sum-1", 1, "leaf", "Test summary", 10);
  db.prepare(`INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES (?, ?, ?)`)
    .run("sum-1", 1, 0);
  db.prepare(`INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES (?, ?, ?)`)
    .run("sum-1", 2, 1);

  db.close();
}

function createGigabrainDatabase(dbPath: string): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new DatabaseSync(dbPath);
  
  db.exec(`
    CREATE TABLE memories (
      memory_id TEXT PRIMARY KEY,
      memory_type TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB,
      token_count INTEGER DEFAULT 0,
      source_session_id TEXT,
      source_conversation_id INTEGER,
      confidence REAL DEFAULT 1.0,
      importance REAL DEFAULT 0.5,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      last_accessed_at TEXT,
      access_count INTEGER DEFAULT 0,
      is_archived INTEGER DEFAULT 0,
      quality_score REAL,
      dedupe_hash TEXT,
      metadata TEXT
    );

    CREATE TABLE memory_tags (
      memory_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (memory_id, tag)
    );
  `);

  // Insert test memories
  db.prepare(`INSERT INTO memories (memory_id, memory_type, content, token_count, confidence, importance) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("mem-1", "fact", "User prefers TypeScript over JavaScript", 10, 0.95, 0.8);
  db.prepare(`INSERT INTO memories (memory_id, memory_type, content, token_count, confidence, importance) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("mem-2", "preference", "User likes dark mode interfaces", 8, 0.9, 0.7);
  
  db.prepare(`INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)`)
    .run("mem-1", "technology");
  db.prepare(`INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)`)
    .run("mem-1", "preferences");

  db.close();
}

function createOpenStingerDatabase(dbPath: string): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new DatabaseSync(dbPath);
  
  db.exec(`
    CREATE TABLE episodes (
      episode_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      conversation_id INTEGER,
      episode_type TEXT NOT NULL,
      content TEXT NOT NULL,
      valid_time TEXT NOT NULL DEFAULT (datetime('now')),
      transaction_time TEXT NOT NULL DEFAULT (datetime('now')),
      token_count INTEGER DEFAULT 0,
      embedding BLOB,
      importance REAL DEFAULT 0.5,
      is_deleted INTEGER DEFAULT 0,
      parent_episode_id TEXT,
      metadata TEXT
    );

    CREATE TABLE entities (
      entity_id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      properties TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      source_count INTEGER DEFAULT 1
    );
  `);

  // Insert test data
  db.prepare(`INSERT INTO episodes (episode_id, session_id, episode_type, content, token_count, importance) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("ep-1", "session-1", "turn", "User asked about database migration", 15, 0.8);
  db.prepare(`INSERT INTO episodes (episode_id, session_id, episode_type, content, token_count, importance) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("ep-2", "session-1", "turn", "System explained migration process", 20, 0.75);
  
  db.prepare(`INSERT INTO entities (entity_id, entity_type, name, description) VALUES (?, ?, ?, ?)`)
    .run("ent-1", "concept", "Database Migration", "Process of moving data between systems");
  db.prepare(`INSERT INTO entities (entity_id, entity_type, name, description) VALUES (?, ?, ?, ?)`)
    .run("ent-2", "skill", "SQLite", "Database management system");

  db.close();
}

describe("Engram Migration CLI", () => {
  afterEach(() => {
    closeLcmConnection();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("runEngramMigration", () => {
    it("creates v2 schema tables", () => {
      const tempDir = createTempDir();
      const dbPath = join(tempDir, "engram.db");
      createV1Database(dbPath);

      const result = runEngramMigration({
        dbPath,
        backup: false,
      });

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.tablesCreated).toContain("gigabrain_memories");
      expect(result.tablesCreated).toContain("openstinger_episodes");
      expect(result.tablesCreated).toContain("openstinger_entities");
      expect(result.tablesCreated).toContain("engram_migration_log");

      // Verify tables exist
      const db = getLcmConnection(dbPath);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);
      
      expect(tableNames).toContain("gigabrain_memories");
      expect(tableNames).toContain("openstinger_episodes");
      expect(tableNames).toContain("openstinger_entities");
      expect(tableNames).toContain("openstinger_relationships");
      expect(tableNames).toContain("openstinger_vault_entries");
      
      closeLcmConnection(dbPath);
    });

    it("preserves existing v1 data", () => {
      const tempDir = createTempDir();
      const dbPath = join(tempDir, "engram.db");
      createV1Database(dbPath);

      runEngramMigration({ dbPath, backup: false });

      const db = getLcmConnection(dbPath);
      
      // Verify conversations preserved
      const conversations = db.prepare("SELECT * FROM conversations").all() as Array<{ session_id: string; title: string }>;
      expect(conversations).toHaveLength(1);
      expect(conversations[0].session_id).toBe("test-session");
      
      // Verify messages preserved
      const messages = db.prepare("SELECT * FROM messages ORDER BY seq").all() as Array<{ content: string }>;
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe("Hello");
      expect(messages[1].content).toBe("Hi there!");
      
      // Verify summaries preserved
      const summaries = db.prepare("SELECT * FROM summaries").all() as Array<{ summary_id: string }>;
      expect(summaries).toHaveLength(1);
      expect(summaries[0].summary_id).toBe("sum-1");
      
      closeLcmConnection(dbPath);
    });

    it("creates backup when requested", () => {
      const tempDir = createTempDir();
      const dbPath = join(tempDir, "engram.db");
      createV1Database(dbPath);

      const result = runEngramMigration({
        dbPath,
        backup: true,
      });

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeDefined();
      expect(existsSync(result.backupPath!)).toBe(true);
      
      // Verify backup contains v1 schema
      const backupDb = new DatabaseSync(result.backupPath!);
      const tables = backupDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);
      
      expect(tableNames).toContain("conversations");
      expect(tableNames).toContain("messages");
      expect(tableNames).toContain("summaries");
      expect(tableNames).not.toContain("gigabrain_memories");
      expect(tableNames).not.toContain("openstinger_episodes");
      
      backupDb.close();
    });

    it("imports Gigabrain data", () => {
      const tempDir = createTempDir();
      const dbPath = join(tempDir, "engram.db");
      const gigabrainPath = join(tempDir, "gigabrain.db");
      
      createV1Database(dbPath);
      createGigabrainDatabase(gigabrainPath);

      const result = runEngramMigration({
        dbPath,
        backup: false,
        gigabrainDataPath: gigabrainPath,
      });

      expect(result.success).toBe(true);
      expect(result.recordsImported.gigabrainMemories).toBe(2);

      const db = getLcmConnection(dbPath);
      const memories = db.prepare("SELECT * FROM gigabrain_memories ORDER BY memory_id").all() as Array<{ memory_id: string; content: string }>;
      
      expect(memories).toHaveLength(2);
      expect(memories[0].memory_id).toBe("mem-1");
      expect(memories[0].content).toBe("User prefers TypeScript over JavaScript");
      expect(memories[1].memory_id).toBe("mem-2");
      expect(memories[1].content).toBe("User likes dark mode interfaces");
      
      // Verify tags were imported
      const tags = db.prepare("SELECT * FROM gigabrain_memory_tags").all() as Array<{ memory_id: string; tag: string }>;
      expect(tags).toHaveLength(2);
      expect(tags.map((t) => t.tag)).toContain("technology");
      expect(tags.map((t) => t.tag)).toContain("preferences");
      
      closeLcmConnection(dbPath);
    });

    it("imports OpenStinger data", () => {
      const tempDir = createTempDir();
      const dbPath = join(tempDir, "engram.db");
      const openstingerPath = join(tempDir, "openstinger.db");
      
      createV1Database(dbPath);
      createOpenStingerDatabase(openstingerPath);

      const result = runEngramMigration({
        dbPath,
        backup: false,
        openstingerDataPath: openstingerPath,
      });

      expect(result.success).toBe(true);
      expect(result.recordsImported.openstingerEpisodes).toBe(2);
      expect(result.recordsImported.openstingerEntities).toBe(2);

      const db = getLcmConnection(dbPath);
      
      const episodes = db.prepare("SELECT * FROM openstinger_episodes ORDER BY episode_id").all() as Array<{ episode_id: string; content: string }>;
      expect(episodes).toHaveLength(2);
      expect(episodes[0].episode_id).toBe("ep-1");
      expect(episodes[1].episode_id).toBe("ep-2");
      
      const entities = db.prepare("SELECT * FROM openstinger_entities ORDER BY entity_id").all() as Array<{ entity_id: string; name: string }>;
      expect(entities).toHaveLength(2);
      expect(entities[0].entity_id).toBe("ent-1");
      expect(entities[0].name).toBe("Database Migration");
      
      closeLcmConnection(dbPath);
    });

    it("runs in dry-run mode without applying changes", () => {
      const tempDir = createTempDir();
      const dbPath = join(tempDir, "engram.db");
      createV1Database(dbPath);

      const result = runEngramMigration({
        dbPath,
        backup: false,
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.warnings).toContain("Dry run mode - no changes applied");

      // Verify v2 tables were NOT created
      const db = new DatabaseSync(dbPath);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);
      
      expect(tableNames).not.toContain("gigabrain_memories");
      expect(tableNames).not.toContain("openstinger_episodes");
      
      db.close();
    });

    it("fails gracefully with missing database", () => {
      const result = runEngramMigration({
        dbPath: "/nonexistent/path/engram.db",
        backup: false,
      });

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("Database not found");
    });

    it("is idempotent - can run multiple times", () => {
      const tempDir = createTempDir();
      const dbPath = join(tempDir, "engram.db");
      createV1Database(dbPath);

      // First migration
      const result1 = runEngramMigration({ dbPath, backup: false });
      expect(result1.success).toBe(true);

      // Second migration (should succeed without errors)
      const result2 = runEngramMigration({ dbPath, backup: false });
      expect(result2.success).toBe(true);
      expect(result2.errors).toHaveLength(0);

      // Verify data still intact
      const db = getLcmConnection(dbPath);
      const conversations = db.prepare("SELECT * FROM conversations").all() as Array<{ session_id: string }>;
      expect(conversations).toHaveLength(1);
      
      closeLcmConnection(dbPath);
    });

    it("tracks migration in log table", () => {
      const tempDir = createTempDir();
      const dbPath = join(tempDir, "engram.db");
      createV1Database(dbPath);

      runEngramMigration({ dbPath, backup: false });

      const db = getLcmConnection(dbPath);
      const logs = db.prepare("SELECT * FROM engram_migration_log").all() as Array<{
        migration_version: string;
        migration_name: string;
        status: string;
      }>;
      
      expect(logs).toHaveLength(1);
      expect(logs[0].migration_version).toBe("2.0");
      expect(logs[0].migration_name).toBe("v1_to_v2_migration");
      expect(logs[0].status).toBe("completed");
      
      closeLcmConnection(dbPath);
    });
  });

  describe("migrateConfigV1ToV2", () => {
    it("migrates minimal config with defaults", () => {
      const legacy = { enabled: true };
      const migrated = migrateConfigV1ToV2(legacy);

      expect(migrated.version).toBe("2.0");
      expect(migrated.enabled).toBe(true);
      expect(migrated.gigabrain.enabled).toBe(true);
      expect(migrated.gigabrain.captureMode).toBe("hybrid");
      expect(migrated.openstinger.enabled).toBe(true);
      expect(migrated.openstinger.episodicMemoryEnabled).toBe(true);
      expect(migrated.memory.unifiedSearch).toBe(true);
    });

    it("preserves legacy LCM settings", () => {
      const legacy = {
        enabled: false,
        databasePath: "/custom/path.db",
        contextThreshold: 0.8,
        freshTailCount: 50,
      };
      const migrated = migrateConfigV1ToV2(legacy);

      expect(migrated.enabled).toBe(false);
      expect(migrated.databasePath).toBe("/custom/path.db");
      expect(migrated.contextThreshold).toBe(0.8);
      expect(migrated.freshTailCount).toBe(50);
    });

    it("applies sensible defaults for new Gigabrain fields", () => {
      const migrated = migrateConfigV1ToV2({});

      expect(migrated.gigabrain.dedupeThreshold).toBe(0.92);
      expect(migrated.gigabrain.qualityGateEnabled).toBe(true);
      expect(migrated.gigabrain.minQualityScore).toBe(0.6);
      expect(migrated.gigabrain.embeddingModel).toBe("text-embedding-3-small");
      expect(migrated.gigabrain.nativeMarkdownSync).toBe(true);
    });

    it("applies sensible defaults for new OpenStinger fields", () => {
      const migrated = migrateConfigV1ToV2({});

      expect(migrated.openstinger.gradientAlignmentEnabled).toBe(false);
      expect(migrated.openstinger.graphBackend).toBe("sqlite");
      expect(migrated.openstinger.maxEpisodesPerQuery).toBe(50);
    });
  });

  describe("rollbackMigration", () => {
    it("restores database from backup", () => {
      const tempDir = createTempDir();
      const dbPath = join(tempDir, "engram.db");
      createV1Database(dbPath);

      // Create backup
      const backupPath = join(tempDir, "backup.db");
      writeFileSync(backupPath, readFileSync(dbPath));

      // Run migration
      runEngramMigration({ dbPath, backup: false });

      // Verify v2 tables exist
      const db1 = new DatabaseSync(dbPath);
      const tables1 = db1.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      expect(tables1.some((t) => t.name === "gigabrain_memories")).toBe(true);
      db1.close();

      // Rollback
      const rollbackResult = rollbackMigration(dbPath, backupPath);
      expect(rollbackResult).toBe(true);

      // Verify v2 tables are gone
      const db2 = new DatabaseSync(dbPath);
      const tables2 = db2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      expect(tables2.some((t) => t.name === "gigabrain_memories")).toBe(false);
      expect(tables2.some((t) => t.name === "conversations")).toBe(true);
      db2.close();
    });

    it("returns false for missing backup", () => {
      const result = rollbackMigration("/path/to/db.db", "/nonexistent/backup.db");
      expect(result).toBe(false);
    });
  });

  describe("parseMigrateArgs", () => {
    it("parses basic migration args", () => {
      const args = ["--from", "v1", "--backup"];
      const options = parseMigrateArgs(args);

      expect(options.backup).toBe(true);
      expect(options.dryRun).toBe(false);
    });

    it("parses import paths", () => {
      const args = [
        "--from", "v1",
        "--import-gigabrain", "/path/to/gigabrain",
        "--import-openstinger", "/path/to/openstinger",
      ];
      const options = parseMigrateArgs(args);

      expect(options.gigabrainDataPath).toBe(resolve("/path/to/gigabrain"));
      expect(options.openstingerDataPath).toBe(resolve("/path/to/openstinger"));
    });

    it("parses dry-run flag", () => {
      const args = ["--from", "v1", "--dry-run"];
      const options = parseMigrateArgs(args);

      expect(options.dryRun).toBe(true);
    });

    it("throws on invalid source version", () => {
      expect(() => {
        parseMigrateArgs(["--from", "v0"]);
      }).toThrow('Migration only supports "v1" as source version');
    });
  });
});
