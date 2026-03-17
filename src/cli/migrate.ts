import { DatabaseSync } from "node:sqlite";
import { existsSync, copyFileSync, mkdirSync, renameSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { getLcmConnection, closeLcmConnection } from "../db/connection.js";
import { runLcmMigrations } from "../db/migration.js";

export type MigrationOptions = {
  /** Path to the Engram v1 database */
  dbPath: string;
  /** Whether to create a backup before migration */
  backup: boolean;
  /** Path to Gigabrain data directory for import */
  gigabrainDataPath?: string;
  /** Path to OpenStinger data directory for import */
  openstingerDataPath?: string;
  /** Path to Obsidian vault for restructuring */
  obsidianVaultPath?: string;
  /** Whether to run in dry-run mode (validate without applying) */
  dryRun?: boolean;
};

export type MigrationResult = {
  success: boolean;
  backupPath?: string;
  errors: string[];
  warnings: string[];
  tablesCreated: string[];
  recordsImported: {
    gigabrainMemories?: number;
    openstingerEpisodes?: number;
    openstingerEntities?: number;
  };
};

// ============================================================================
// Schema Migration: v1 → v2
// ============================================================================

/**
 * Create new v2 schema tables for Gigabrain and OpenStinger features.
 * These tables are added alongside existing LCM tables.
 */
function createV2Schema(db: DatabaseSync): string[] {
  const tablesCreated: string[] = [];

  // Gigabrain: Episodic memories table
  db.exec(`
    CREATE TABLE IF NOT EXISTS gigabrain_memories (
      memory_id TEXT PRIMARY KEY,
      memory_type TEXT NOT NULL CHECK (memory_type IN ('fact', 'insight', 'preference', 'constraint', 'relationship', 'goal', 'achievement')),
      content TEXT NOT NULL,
      embedding BLOB,
      token_count INTEGER NOT NULL DEFAULT 0,
      source_session_id TEXT,
      source_conversation_id INTEGER,
      confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
      importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_accessed_at TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      quality_score REAL,
      dedupe_hash TEXT,
      metadata TEXT
    );
  `);
  tablesCreated.push("gigabrain_memories");

  // Gigabrain: Memory tags for categorization
  db.exec(`
    CREATE TABLE IF NOT EXISTS gigabrain_memory_tags (
      memory_id TEXT NOT NULL REFERENCES gigabrain_memories(memory_id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (memory_id, tag)
    );
  `);
  tablesCreated.push("gigabrain_memory_tags");

  // Gigabrain: Entity mentions tracking (person service integration)
  db.exec(`
    CREATE TABLE IF NOT EXISTS gigabrain_entity_mentions (
      mention_id TEXT PRIMARY KEY,
      memory_id TEXT REFERENCES gigabrain_memories(memory_id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'organization', 'location', 'concept', 'project')),
      entity_name TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      mention_context TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  tablesCreated.push("gigabrain_entity_mentions");

  // OpenStinger: Temporal episodes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS openstinger_episodes (
      episode_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      conversation_id INTEGER,
      episode_type TEXT NOT NULL CHECK (episode_type IN ('turn', 'session', 'milestone', 'decision', 'error')),
      content TEXT NOT NULL,
      valid_time TEXT NOT NULL DEFAULT (datetime('now')),
      transaction_time TEXT NOT NULL DEFAULT (datetime('now')),
      token_count INTEGER NOT NULL DEFAULT 0,
      embedding BLOB,
      importance REAL NOT NULL DEFAULT 0.5,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      parent_episode_id TEXT REFERENCES openstinger_episodes(episode_id) ON DELETE SET NULL,
      metadata TEXT
    );
  `);
  tablesCreated.push("openstinger_episodes");

  // OpenStinger: Knowledge graph entities
  db.exec(`
    CREATE TABLE IF NOT EXISTS openstinger_entities (
      entity_id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'organization', 'location', 'concept', 'event', 'artifact', 'skill')),
      name TEXT NOT NULL,
      description TEXT,
      properties TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      source_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  tablesCreated.push("openstinger_entities");

  // OpenStinger: Knowledge graph relationships
  db.exec(`
    CREATE TABLE IF NOT EXISTS openstinger_relationships (
      relationship_id TEXT PRIMARY KEY,
      from_entity_id TEXT NOT NULL REFERENCES openstinger_entities(entity_id) ON DELETE CASCADE,
      to_entity_id TEXT NOT NULL REFERENCES openstinger_entities(entity_id) ON DELETE CASCADE,
      relationship_type TEXT NOT NULL,
      strength REAL NOT NULL DEFAULT 1.0 CHECK (strength >= 0 AND strength <= 1),
      evidence TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  tablesCreated.push("openstinger_relationships");

  // OpenStinger: StingerVault self-knowledge entries
  db.exec(`
    CREATE TABLE IF NOT EXISTS openstinger_vault_entries (
      entry_id TEXT PRIMARY KEY,
      category TEXT NOT NULL CHECK (category IN ('identity', 'domain', 'methodology', 'preferences', 'constraints', 'beliefs')),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      source_episodes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  tablesCreated.push("openstinger_vault_entries");

  // Migration tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS engram_migration_log (
      migration_id INTEGER PRIMARY KEY AUTOINCREMENT,
      migration_version TEXT NOT NULL,
      migration_name TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'rolled_back')),
      backup_path TEXT,
      errors TEXT,
      metadata TEXT
    );
  `);
  tablesCreated.push("engram_migration_log");

  // Create indexes for performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_gigabrain_memories_type ON gigabrain_memories(memory_type);
    CREATE INDEX IF NOT EXISTS idx_gigabrain_memories_created ON gigabrain_memories(created_at);
    CREATE INDEX IF NOT EXISTS idx_gigabrain_memories_dedupe ON gigabrain_memories(dedupe_hash) WHERE dedupe_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_entity_mentions_key ON gigabrain_entity_mentions(entity_key);
    CREATE INDEX IF NOT EXISTS idx_openstinger_episodes_session ON openstinger_episodes(session_id);
    CREATE INDEX IF NOT EXISTS idx_openstinger_episodes_valid_time ON openstinger_episodes(valid_time);
    CREATE INDEX IF NOT EXISTS idx_openstinger_entities_type ON openstinger_entities(entity_type);
    CREATE INDEX IF NOT EXISTS idx_openstinger_relationships_from ON openstinger_relationships(from_entity_id);
    CREATE INDEX IF NOT EXISTS idx_openstinger_relationships_to ON openstinger_relationships(to_entity_id);
    CREATE INDEX IF NOT EXISTS idx_openstinger_vault_category ON openstinger_vault_entries(category);
  `);

  return tablesCreated;
}

// ============================================================================
// Config Migration
// ============================================================================

export type LegacyEngramConfig = {
  enabled?: boolean;
  databasePath?: string;
  contextThreshold?: number;
  freshTailCount?: number;
  // ... other legacy fields
};

export type UnifiedEngramConfig = {
  version: "2.0";
  enabled: boolean;
  databasePath: string;
  
  // LCM settings (preserved from v1)
  contextThreshold: number;
  freshTailCount: number;
  leafMinFanout: number;
  condensedMinFanout: number;
  condensedMinFanoutHard: number;
  incrementalMaxDepth: number;
  leafChunkTokens: number;
  leafTargetTokens: number;
  condensedTargetTokens: number;
  maxExpandTokens: number;
  largeFileTokenThreshold: number;
  largeFileSummaryProvider: string;
  largeFileSummaryModel: string;
  autocompactDisabled: boolean;
  timezone: string;
  pruneHeartbeatOk: boolean;
  
  // Vault settings (preserved from v1)
  vaultEnabled: boolean;
  vaultPath: string;
  vaultSubdir: string;
  vaultHomeNoteName: string;
  vaultManualFolders: string;
  vaultClean: boolean;
  vaultReportsEnabled: boolean;
  obsidianMode: string;
  obsidianExportDiagnostics: boolean;
  
  // New Gigabrain settings (with sensible defaults)
  gigabrain: {
    enabled: boolean;
    captureMode: "explicit" | "auto" | "hybrid";
    dedupeThreshold: number;
    qualityGateEnabled: boolean;
    minQualityScore: number;
    maxMemoriesPerSession: number;
    embeddingModel: string;
    nativeMarkdownSync: boolean;
    dailyNotesEnabled: boolean;
  };
  
  // New OpenStinger settings (with sensible defaults)
  openstinger: {
    enabled: boolean;
    episodicMemoryEnabled: boolean;
    knowledgeGraphEnabled: boolean;
    stingerVaultEnabled: boolean;
    gradientAlignmentEnabled: boolean;
    maxEpisodesPerQuery: number;
    graphBackend: "sqlite" | "falkordb";
    falkorDbUrl?: string;
  };
  
  // Unified memory settings
  memory: {
    unifiedSearch: boolean;
    crossSystemDeduplication: boolean;
    importanceDecayDays: number;
    retentionPolicy: "keep" | "archive" | "delete";
  };
};

/**
 * Migrate legacy Engram v1 config to unified v2 config.
 */
export function migrateConfigV1ToV2(legacy: LegacyEngramConfig): UnifiedEngramConfig {
  // Start with sensible defaults for new fields
  return {
    version: "2.0",
    enabled: legacy.enabled ?? true,
    databasePath: legacy.databasePath ?? join(homedir(), ".openclaw", "engram.db"),
    
    // Preserve legacy LCM settings with defaults
    contextThreshold: legacy.contextThreshold ?? 0.75,
    freshTailCount: legacy.freshTailCount ?? 32,
    leafMinFanout: 8,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    incrementalMaxDepth: 0,
    leafChunkTokens: 20000,
    leafTargetTokens: 1200,
    condensedTargetTokens: 2000,
    maxExpandTokens: 4000,
    largeFileTokenThreshold: 25000,
    largeFileSummaryProvider: "",
    largeFileSummaryModel: "",
    autocompactDisabled: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    pruneHeartbeatOk: false,
    
    // Preserve legacy vault settings
    vaultEnabled: false,
    vaultPath: "",
    vaultSubdir: "Engram",
    vaultHomeNoteName: "Home",
    vaultManualFolders: "Inbox,Manual",
    vaultClean: true,
    vaultReportsEnabled: true,
    obsidianMode: "curated",
    obsidianExportDiagnostics: false,
    
    // New Gigabrain settings with sensible defaults
    gigabrain: {
      enabled: true,
      captureMode: "hybrid",
      dedupeThreshold: 0.92,
      qualityGateEnabled: true,
      minQualityScore: 0.6,
      maxMemoriesPerSession: 100,
      embeddingModel: "text-embedding-3-small",
      nativeMarkdownSync: true,
      dailyNotesEnabled: true,
    },
    
    // New OpenStinger settings with sensible defaults
    openstinger: {
      enabled: true,
      episodicMemoryEnabled: true,
      knowledgeGraphEnabled: true,
      stingerVaultEnabled: true,
      gradientAlignmentEnabled: false, // Off by default (computationally expensive)
      maxEpisodesPerQuery: 50,
      graphBackend: "sqlite", // Default to SQLite (no FalkorDB dependency)
    },
    
    // Unified memory settings
    memory: {
      unifiedSearch: true,
      crossSystemDeduplication: true,
      importanceDecayDays: 90,
      retentionPolicy: "archive",
    },
  };
}

// ============================================================================
// Gigabrain Import
// ============================================================================

/**
 * Import memories from Gigabrain database.
 * Returns the number of memories imported.
 */
function importGigabrainData(
  targetDb: DatabaseSync,
  gigabrainDbPath: string,
): { imported: number; errors: string[] } {
  const errors: string[] = [];
  let imported = 0;

  if (!existsSync(gigabrainDbPath)) {
    errors.push(`Gigabrain database not found at: ${gigabrainDbPath}`);
    return { imported, errors };
  }

  try {
    // Attach the Gigabrain database
    targetDb.exec(`ATTACH DATABASE '${gigabrainDbPath}' AS gigabrain_source`);

    // Check if the source has the expected tables
    const tables = targetDb
      .prepare("SELECT name FROM gigabrain_source.sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    if (!tableNames.includes("memories")) {
      errors.push("Gigabrain database does not contain 'memories' table");
      targetDb.exec(`DETACH DATABASE gigabrain_source`);
      return { imported, errors };
    }

    // Import memories
    const insertMemory = targetDb.prepare(`
      INSERT INTO gigabrain_memories (
        memory_id, memory_type, content, token_count, source_session_id,
        confidence, importance, created_at, updated_at, last_accessed_at,
        access_count, is_archived, quality_score, dedupe_hash, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        access_count = gigabrain_memories.access_count + 1
    `);

    const memories = targetDb
      .prepare(`
        SELECT 
          memory_id, memory_type, content, embedding, token_count,
          source_session_id, source_conversation_id, confidence, importance,
          created_at, updated_at, last_accessed_at, access_count, is_archived,
          quality_score, dedupe_hash, metadata
        FROM gigabrain_source.memories
        WHERE is_archived = 0 OR is_archived IS NULL
      `)
      .all() as Array<{
        memory_id: string;
        memory_type: string;
        content: string;
        embedding: Buffer | null;
        token_count: number;
        source_session_id: string | null;
        source_conversation_id: number | null;
        confidence: number;
        importance: number;
        created_at: string;
        updated_at: string;
        last_accessed_at: string | null;
        access_count: number;
        is_archived: number;
        quality_score: number | null;
        dedupe_hash: string | null;
        metadata: string | null;
      }>;

    for (const memory of memories) {
      try {
        insertMemory.run(
          memory.memory_id,
          memory.memory_type,
          memory.content,
          memory.token_count ?? 0,
          memory.source_session_id,
          memory.confidence ?? 1.0,
          memory.importance ?? 0.5,
          memory.created_at,
          memory.updated_at,
          memory.last_accessed_at,
          memory.access_count ?? 0,
          memory.is_archived ?? 0,
          memory.quality_score,
          memory.dedupe_hash,
          memory.metadata,
        );
        imported++;
      } catch (err) {
        errors.push(`Failed to import memory ${memory.memory_id}: ${err}`);
      }
    }

    // Import tags if the table exists
    if (tableNames.includes("memory_tags")) {
      const insertTag = targetDb.prepare(`
        INSERT OR IGNORE INTO gigabrain_memory_tags (memory_id, tag)
        SELECT memory_id, tag FROM gigabrain_source.memory_tags
      `);
      insertTag.run();
    }

    targetDb.exec(`DETACH DATABASE gigabrain_source`);
  } catch (err) {
    errors.push(`Failed to import Gigabrain data: ${err}`);
    try {
      targetDb.exec(`DETACH DATABASE gigabrain_source`);
    } catch {
      // Ignore detach errors
    }
  }

  return { imported, errors };
}

// ============================================================================
// OpenStinger Import
// ============================================================================

/**
 * Import episodes and entities from OpenStinger (FalkorDB export or SQLite).
 * Returns the number of episodes and entities imported.
 */
function importOpenStingerData(
  targetDb: DatabaseSync,
  openstingerDataPath: string,
): {
  episodesImported: number;
  entitiesImported: number;
  errors: string[];
} {
  const errors: string[] = [];
  let episodesImported = 0;
  let entitiesImported = 0;

  if (!existsSync(openstingerDataPath)) {
    errors.push(`OpenStinger data path not found at: ${openstingerDataPath}`);
    return { episodesImported, entitiesImported, errors };
  }

  // Check if it's a SQLite database or a JSON export directory
  const sqlitePath = openstingerDataPath.endsWith(".db")
    ? openstingerDataPath
    : join(openstingerDataPath, "openstinger.db");

  if (existsSync(sqlitePath)) {
    // Import from SQLite database
    return importOpenStingerFromSqlite(targetDb, sqlitePath);
  }

  // Try to import from JSON export files
  return importOpenStingerFromJson(targetDb, openstingerDataPath);
}

function importOpenStingerFromSqlite(
  targetDb: DatabaseSync,
  sqlitePath: string,
): {
  episodesImported: number;
  entitiesImported: number;
  errors: string[];
} {
  const errors: string[] = [];
  let episodesImported = 0;
  let entitiesImported = 0;

  try {
    targetDb.exec(`ATTACH DATABASE '${sqlitePath}' AS openstinger_source`);

    // Import episodes
    const insertEpisode = targetDb.prepare(`
      INSERT INTO openstinger_episodes (
        episode_id, session_id, conversation_id, episode_type, content,
        valid_time, transaction_time, token_count, importance, is_deleted,
        parent_episode_id, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(episode_id) DO UPDATE SET
        transaction_time = excluded.transaction_time
    `);

    const episodes = targetDb
      .prepare(`
        SELECT episode_id, session_id, conversation_id, episode_type, content,
               valid_time, transaction_time, token_count, embedding, importance,
               is_deleted, parent_episode_id, metadata
        FROM openstinger_source.episodes
        WHERE is_deleted = 0 OR is_deleted IS NULL
      `)
      .all() as Array<{
        episode_id: string;
        session_id: string;
        conversation_id: number | null;
        episode_type: string;
        content: string;
        valid_time: string;
        transaction_time: string;
        token_count: number;
        importance: number;
        is_deleted: number;
        parent_episode_id: string | null;
        metadata: string | null;
      }>;

    for (const episode of episodes) {
      try {
        insertEpisode.run(
          episode.episode_id,
          episode.session_id,
          episode.conversation_id,
          episode.episode_type,
          episode.content,
          episode.valid_time,
          episode.transaction_time,
          episode.token_count ?? 0,
          episode.importance ?? 0.5,
          episode.is_deleted ?? 0,
          episode.parent_episode_id,
          episode.metadata,
        );
        episodesImported++;
      } catch (err) {
        errors.push(`Failed to import episode ${episode.episode_id}: ${err}`);
      }
    }

    // Import entities
    const insertEntity = targetDb.prepare(`
      INSERT INTO openstinger_entities (
        entity_id, entity_type, name, description, properties,
        created_at, updated_at, source_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        source_count = openstinger_entities.source_count + 1
    `);

    const entities = targetDb
      .prepare(`
        SELECT entity_id, entity_type, name, description, properties,
               created_at, updated_at, source_count
        FROM openstinger_source.entities
      `)
      .all() as Array<{
        entity_id: string;
        entity_type: string;
        name: string;
        description: string | null;
        properties: string | null;
        created_at: string;
        updated_at: string;
        source_count: number;
      }>;

    for (const entity of entities) {
      try {
        insertEntity.run(
          entity.entity_id,
          entity.entity_type,
          entity.name,
          entity.description,
          entity.properties,
          entity.created_at,
          entity.updated_at,
          entity.source_count ?? 1,
        );
        entitiesImported++;
      } catch (err) {
        errors.push(`Failed to import entity ${entity.entity_id}: ${err}`);
      }
    }

    targetDb.exec(`DETACH DATABASE openstinger_source`);
  } catch (err) {
    errors.push(`Failed to import OpenStinger SQLite data: ${err}`);
    try {
      targetDb.exec(`DETACH DATABASE openstinger_source`);
    } catch {
      // Ignore
    }
  }

  return { episodesImported, entitiesImported, errors };
}

function importOpenStingerFromJson(
  _targetDb: DatabaseSync,
  _jsonPath: string,
): {
  episodesImported: number;
  entitiesImported: number;
  errors: string[];
} {
  // TODO: Implement JSON export import from FalkorDB
  // This would parse JSON files exported from FalkorDB
  return {
    episodesImported: 0,
    entitiesImported: 0,
    errors: ["JSON import from FalkorDB not yet implemented. Please export to SQLite first."],
  };
}

// ============================================================================
// Backup and Rollback
// ============================================================================

/**
 * Create a backup of the database before migration.
 */
function createBackup(dbPath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(dirname(dbPath), ".backups");
  mkdirSync(backupDir, { recursive: true });
  
  const backupPath = join(backupDir, `engram-v1-backup-${timestamp}.db`);
  copyFileSync(dbPath, backupPath);
  
  return backupPath;
}

/**
 * Rollback to a previous backup.
 */
export function rollbackMigration(dbPath: string, backupPath: string): boolean {
  if (!existsSync(backupPath)) {
    return false;
  }
  
  try {
    // Close any open connections
    closeLcmConnection(dbPath);
    
    // Restore the backup
    copyFileSync(backupPath, dbPath);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Obsidian Vault Migration
// ============================================================================

/**
 * Restructure Obsidian vault to merge old surfaces into unified surface.
 */
function migrateObsidianVault(
  vaultPath: string,
  options: { dryRun?: boolean } = {},
): { warnings: string[]; restructured: boolean } {
  const warnings: string[] = [];
  
  if (!existsSync(vaultPath)) {
    warnings.push(`Vault path does not exist: ${vaultPath}`);
    return { warnings, restructured: false };
  }

  const stats = statSync(vaultPath);
  if (!stats.isDirectory()) {
    warnings.push(`Vault path is not a directory: ${vaultPath}`);
    return { warnings, restructured: false };
  }

  // Look for old Gigabrain and OpenStinger vault folders
  const entries = readdirSync(vaultPath, { withFileTypes: true });
  const oldFolders = entries
    .filter((e) => e.isDirectory() && (e.name === "Gigabrain" || e.name === "OpenStinger"))
    .map((e) => e.name);

  if (oldFolders.length === 0) {
    // No old folders to migrate
    return { warnings, restructured: true };
  }

  if (options.dryRun) {
    warnings.push(`Would merge vault folders: ${oldFolders.join(", ")} into unified structure`);
    return { warnings, restructured: false };
  }

  // Create unified structure
  const unifiedDir = join(vaultPath, "Engram");
  mkdirSync(unifiedDir, { recursive: true });
  mkdirSync(join(unifiedDir, "Memories"), { recursive: true });
  mkdirSync(join(unifiedDir, "Episodes"), { recursive: true });
  mkdirSync(join(unifiedDir, "Entities"), { recursive: true });
  mkdirSync(join(unifiedDir, "Daily"), { recursive: true });

  warnings.push(`Created unified vault structure in: ${unifiedDir}`);
  warnings.push(`Manual review needed to merge content from: ${oldFolders.join(", ")}`);

  return { warnings, restructured: true };
}

// ============================================================================
// Main Migration Function
// ============================================================================

/**
 * Run the complete v1 → v2 migration.
 */
export function runEngramMigration(options: MigrationOptions): MigrationResult {
  const result: MigrationResult = {
    success: false,
    errors: [],
    warnings: [],
    tablesCreated: [],
    recordsImported: {},
  };

  // Validate database path
  if (!existsSync(options.dbPath)) {
    result.errors.push(`Database not found at: ${options.dbPath}`);
    return result;
  }

  // Create backup if requested
  if (options.backup) {
    try {
      result.backupPath = createBackup(options.dbPath);
    } catch (err) {
      result.errors.push(`Failed to create backup: ${err}`);
      return result;
    }
  }

  // Dry run: just validate and return
  if (options.dryRun) {
    result.warnings.push("Dry run mode - no changes applied");
    result.success = true;
    return result;
  }

  try {
    // Get database connection
    const db = getLcmConnection(options.dbPath);

    // Run existing LCM migrations (idempotent)
    runLcmMigrations(db);

    // Create v2 schema first (before logging, since log table is part of v2)
    result.tablesCreated = createV2Schema(db);

    // Log migration start
    const logStart = db.prepare(`
      INSERT INTO engram_migration_log (migration_version, migration_name, status)
      VALUES ('2.0', 'v1_to_v2_migration', 'running')
    `);
    logStart.run();
    const migrationLogId = db.prepare("SELECT last_insert_rowid()").get() as {
      "last_insert_rowid()": number;
    };

    // Import Gigabrain data if provided
    if (options.gigabrainDataPath) {
      const gigabrainResult = importGigabrainData(db, options.gigabrainDataPath);
      result.recordsImported.gigabrainMemories = gigabrainResult.imported;
      result.errors.push(...gigabrainResult.errors);
    }

    // Import OpenStinger data if provided
    if (options.openstingerDataPath) {
      const openstingerResult = importOpenStingerData(db, options.openstingerDataPath);
      result.recordsImported.openstingerEpisodes = openstingerResult.episodesImported;
      result.recordsImported.openstingerEntities = openstingerResult.entitiesImported;
      result.errors.push(...openstingerResult.errors);
    }

    // Migrate Obsidian vault if provided
    if (options.obsidianVaultPath) {
      const vaultResult = migrateObsidianVault(options.obsidianVaultPath);
      result.warnings.push(...vaultResult.warnings);
    }

    // Log migration completion
    const logComplete = db.prepare(`
      UPDATE engram_migration_log
      SET status = 'completed', completed_at = datetime('now'), metadata = ?
      WHERE migration_id = ?
    `);
    logComplete.run(
      JSON.stringify({
        tablesCreated: result.tablesCreated,
        recordsImported: result.recordsImported,
        warnings: result.warnings,
      }),
      migrationLogId["last_insert_rowid()"],
    );

    result.success = result.errors.length === 0;
  } catch (err) {
    result.errors.push(`Migration failed: ${err}`);
    result.success = false;
  } finally {
    closeLcmConnection(options.dbPath);
  }

  return result;
}

// ============================================================================
// CLI Entry Point
// ============================================================================

/**
 * Parse CLI arguments and run migration.
 */
export function parseMigrateArgs(args: string[]): MigrationOptions {
  const options: MigrationOptions = {
    dbPath: join(homedir(), ".openclaw", "engram.db"),
    backup: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--from":
        if (args[i + 1] !== "v1") {
          throw new Error('Migration only supports "v1" as source version');
        }
        i++;
        break;
      case "--db-path":
        options.dbPath = resolve(args[++i]);
        break;
      case "--backup":
        options.backup = true;
        break;
      case "--import-gigabrain":
        options.gigabrainDataPath = resolve(args[++i]);
        break;
      case "--import-openstinger":
        options.openstingerDataPath = resolve(args[++i]);
        break;
      case "--obsidian-vault":
        options.obsidianVaultPath = resolve(args[++i]);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
        console.log(`
Engram Migration CLI - v1 to v2

Usage: engram migrate [options]

Options:
  --from v1                  Migrate from Engram v1 (required)
  --db-path <path>           Path to Engram database (default: ~/.openclaw/engram.db)
  --backup                   Create backup before migration
  --import-gigabrain <path>  Import data from Gigabrain database
  --import-openstinger <path> Import data from OpenStinger (SQLite or export dir)
  --obsidian-vault <path>    Path to Obsidian vault for restructuring
  --dry-run                  Validate migration without applying changes
  --help                     Show this help message

Examples:
  engram migrate --from v1 --backup
  engram migrate --from v1 --import-gigabrain ~/.openclaw/plugins/gigabrain/data/
  engram migrate --from v1 --import-openstinger ~/.openstinger/ --obsidian-vault ~/Vault/
`);
        process.exit(0);
        break;
    }
  }

  return options;
}

// Run CLI if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseMigrateArgs(process.argv.slice(2));
    const result = runEngramMigration(options);

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  } catch (err) {
    console.error(`Error: ${err}`);
    process.exit(1);
  }
}
