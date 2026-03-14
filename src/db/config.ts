import { homedir } from "os";
import { join } from "path";

export type LcmConfig = {
  enabled: boolean;
  databasePath: string;
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
  /** Provider override for large-file text summarization. */
  largeFileSummaryProvider: string;
  /** Model override for large-file text summarization. */
  largeFileSummaryModel: string;
  autocompactDisabled: boolean;
  /** IANA timezone for timestamps in summaries (from TZ env or system default) */
  timezone: string;
  /** When true, retroactively delete HEARTBEAT_OK turn cycles from LCM storage. */
  pruneHeartbeatOk: boolean;
  // ── Vault / Obsidian mirror ────────────────────────────────────────────────
  /** When true, vault mirror generation is enabled. Default: false. */
  vaultEnabled: boolean;
  /** Absolute path to the Obsidian vault root directory. Required when vaultEnabled. */
  vaultPath: string;
  /** Sub-directory inside the vault root where generated files live. Default: "Engram". */
  vaultSubdir: string;
  /** Name for the home note file (without .md extension). Default: "Home". */
  vaultHomeNoteName: string;
  /** Comma-separated list of manually managed folders to protect from cleanup. Default: "Inbox,Manual". */
  vaultManualFolders: string;
  /** When true, remove stale generated files on each build. Default: true. */
  vaultClean: boolean;
  /** When true, write report files (manifest, freshness, build summary). Default: true. */
  vaultReportsEnabled: boolean;
  /** Obsidian surface mode: "curated" (condensed summaries only) or "diagnostic" (full DAG). Default: "curated". */
  obsidianMode: string;
  /** When true, export diagnostic views (summary depth, raw leaf list). Default: false. */
  obsidianExportDiagnostics: boolean;
};

/** Safely coerce an unknown value to a finite number, or return undefined. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Safely coerce an unknown value to a boolean, or return undefined. */
function toBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** Safely coerce an unknown value to a trimmed non-empty string, or return undefined. */
function toStr(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

/**
 * Resolve LCM configuration with three-tier precedence:
 *   1. Environment variables (highest — backward compat)
 *   2. Plugin config object (from plugins.entries.lossless-claw.config)
 *   3. Hardcoded defaults (lowest)
 */
export function resolveLcmConfig(
  env: NodeJS.ProcessEnv = process.env,
  pluginConfig?: Record<string, unknown>,
): LcmConfig {
  const pc = pluginConfig ?? {};

  return {
    enabled:
      env.LCM_ENABLED !== undefined
        ? env.LCM_ENABLED !== "false"
        : toBool(pc.enabled) ?? true,
    databasePath:
      env.LCM_DATABASE_PATH
      ?? toStr(pc.dbPath)
      ?? toStr(pc.databasePath)
      ?? join(homedir(), ".openclaw", "lcm.db"),
    contextThreshold:
      (env.LCM_CONTEXT_THRESHOLD !== undefined ? parseFloat(env.LCM_CONTEXT_THRESHOLD) : undefined)
        ?? toNumber(pc.contextThreshold) ?? 0.75,
    freshTailCount:
      (env.LCM_FRESH_TAIL_COUNT !== undefined ? parseInt(env.LCM_FRESH_TAIL_COUNT, 10) : undefined)
        ?? toNumber(pc.freshTailCount) ?? 32,
    leafMinFanout:
      (env.LCM_LEAF_MIN_FANOUT !== undefined ? parseInt(env.LCM_LEAF_MIN_FANOUT, 10) : undefined)
        ?? toNumber(pc.leafMinFanout) ?? 8,
    condensedMinFanout:
      (env.LCM_CONDENSED_MIN_FANOUT !== undefined ? parseInt(env.LCM_CONDENSED_MIN_FANOUT, 10) : undefined)
        ?? toNumber(pc.condensedMinFanout) ?? 4,
    condensedMinFanoutHard:
      (env.LCM_CONDENSED_MIN_FANOUT_HARD !== undefined ? parseInt(env.LCM_CONDENSED_MIN_FANOUT_HARD, 10) : undefined)
        ?? toNumber(pc.condensedMinFanoutHard) ?? 2,
    incrementalMaxDepth:
      (env.LCM_INCREMENTAL_MAX_DEPTH !== undefined ? parseInt(env.LCM_INCREMENTAL_MAX_DEPTH, 10) : undefined)
        ?? toNumber(pc.incrementalMaxDepth) ?? 0,
    leafChunkTokens:
      (env.LCM_LEAF_CHUNK_TOKENS !== undefined ? parseInt(env.LCM_LEAF_CHUNK_TOKENS, 10) : undefined)
        ?? toNumber(pc.leafChunkTokens) ?? 20000,
    leafTargetTokens:
      (env.LCM_LEAF_TARGET_TOKENS !== undefined ? parseInt(env.LCM_LEAF_TARGET_TOKENS, 10) : undefined)
        ?? toNumber(pc.leafTargetTokens) ?? 1200,
    condensedTargetTokens:
      (env.LCM_CONDENSED_TARGET_TOKENS !== undefined ? parseInt(env.LCM_CONDENSED_TARGET_TOKENS, 10) : undefined)
        ?? toNumber(pc.condensedTargetTokens) ?? 2000,
    maxExpandTokens:
      (env.LCM_MAX_EXPAND_TOKENS !== undefined ? parseInt(env.LCM_MAX_EXPAND_TOKENS, 10) : undefined)
        ?? toNumber(pc.maxExpandTokens) ?? 4000,
    largeFileTokenThreshold:
      (env.LCM_LARGE_FILE_TOKEN_THRESHOLD !== undefined ? parseInt(env.LCM_LARGE_FILE_TOKEN_THRESHOLD, 10) : undefined)
        ?? toNumber(pc.largeFileThresholdTokens)
        ?? toNumber(pc.largeFileTokenThreshold)
        ?? 25000,
    largeFileSummaryProvider:
      env.LCM_LARGE_FILE_SUMMARY_PROVIDER?.trim() ?? toStr(pc.largeFileSummaryProvider) ?? "",
    largeFileSummaryModel:
      env.LCM_LARGE_FILE_SUMMARY_MODEL?.trim() ?? toStr(pc.largeFileSummaryModel) ?? "",
    autocompactDisabled:
      env.LCM_AUTOCOMPACT_DISABLED !== undefined
        ? env.LCM_AUTOCOMPACT_DISABLED === "true"
        : toBool(pc.autocompactDisabled) ?? false,
    timezone: env.TZ ?? toStr(pc.timezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    pruneHeartbeatOk:
      env.LCM_PRUNE_HEARTBEAT_OK !== undefined
        ? env.LCM_PRUNE_HEARTBEAT_OK === "true"
        : toBool(pc.pruneHeartbeatOk) ?? false,
    vaultEnabled:
      env.LCM_VAULT_ENABLED !== undefined
        ? env.LCM_VAULT_ENABLED === "true"
        : toBool(pc.vaultEnabled) ?? false,
    vaultPath:
      env.LCM_VAULT_PATH?.trim() ?? toStr(pc.vaultPath) ?? "",
    vaultSubdir:
      env.LCM_VAULT_SUBDIR?.trim() ?? toStr(pc.vaultSubdir) ?? "Engram",
    vaultHomeNoteName:
      env.LCM_VAULT_HOME_NOTE_NAME?.trim() ?? toStr(pc.vaultHomeNoteName) ?? "Home",
    vaultManualFolders:
      env.LCM_VAULT_MANUAL_FOLDERS?.trim() ?? toStr(pc.vaultManualFolders) ?? "Inbox,Manual",
    vaultClean:
      env.LCM_VAULT_CLEAN !== undefined
        ? env.LCM_VAULT_CLEAN !== "false"
        : toBool(pc.vaultClean) ?? true,
    vaultReportsEnabled:
      env.LCM_VAULT_REPORTS_ENABLED !== undefined
        ? env.LCM_VAULT_REPORTS_ENABLED !== "false"
        : toBool(pc.vaultReportsEnabled) ?? true,
    obsidianMode:
      env.LCM_OBSIDIAN_MODE?.trim() ?? toStr(pc.obsidianMode) ?? "curated",
    obsidianExportDiagnostics:
      env.LCM_OBSIDIAN_EXPORT_DIAGNOSTICS !== undefined
        ? env.LCM_OBSIDIAN_EXPORT_DIAGNOSTICS === "true"
        : toBool(pc.obsidianExportDiagnostics) ?? false,
  };
}
