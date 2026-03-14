/**
 * vault-mirror.ts — Obsidian vault surface generator for engram.
 *
 * Mirrors LCM conversation/summary data into a structured set of Obsidian
 * markdown notes. Ported from gigabrain lib/core/vault-mirror.js, adapted
 * for the conversation-centric engram data model.
 *
 * Exports (mirrors gigabrain surface):
 *   buildVaultSurface      — main vault build entry point
 *   inspectVaultHealth     — freshness/health check without full rebuild
 *   loadSurfaceSummary     — load the last written surface-summary artifact
 *   renderVaultBuildMarkdown   — render a build-report markdown string
 *   renderVaultDoctorMarkdown  — render a health-report markdown string
 *   syncVaultPull          — rsync pull helper
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";

// ── Constants ────────────────────────────────────────────────────────────────

const GENERATED_DIRS = Object.freeze([
  "00 Home",
  "10 Sessions",
  "20 Agents",
  "30 Views",
  "40 Reports",
]);

const STALE_VAULT_DAYS = 2;

// ── Types ─────────────────────────────────────────────────────────────────────

export type VaultFreshness = {
  session: {
    last_session_at: string | null;
    stale: boolean;
  };
  vault: {
    last_built_at: string | null;
    stale: boolean;
  };
  manual_protection: {
    ok: boolean;
    issues: string[];
  };
};

export type VaultManifest = {
  generated_at: string;
  vault_root: string;
  mirror_root: string;
  generated_files: string[];
  manual_folders: string[];
  conversation_count: number;
  summary_count: number;
};

export type VaultBuildSummary = {
  enabled: boolean;
  generated_at: string;
  run_id: string;
  vault_root: string;
  subdir: string;
  mirror_root: string;
  conversation_count: number;
  agent_count: number;
  summary_count: number;
  leaf_summary_count: number;
  condensed_summary_count: number;
  copied_files: number;
  skipped_unchanged: number;
  removed_files: number;
  freshness: VaultFreshness;
  manifest: VaultManifest;
  surface_summary_path: string;
  manifest_path: string;
  freshness_path: string;
  build_report_path: string;
};

export type VaultHealthReport = {
  enabled: boolean;
  vault_root: string;
  mirror_root: string;
  session: {
    last_session_at: string | null;
    stale: boolean;
  };
  vault: {
    last_built_at: string | null;
    stale: boolean;
  };
  manual_protection: {
    ok: boolean;
    issues: string[];
  };
  summary_path: string;
};

export type VaultPullResult = {
  ok: boolean;
  host: string | null;
  remote_path: string;
  target: string;
  dry_run: boolean;
  preserve_manual: boolean;
  manual_folders: string[];
  subdir: string;
  changed_paths: string[];
  command: string;
};

// ── Internal DB row types ─────────────────────────────────────────────────────

interface ConversationRow {
  conversation_id: number;
  session_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

interface SummaryRow {
  summary_id: string;
  conversation_id: number;
  kind: string;
  depth: number;
  content: string;
  token_count: number;
  earliest_at: string | null;
  latest_at: string | null;
  descendant_count: number | null;
  descendant_token_count: number | null;
  created_at: string;
}

interface CountRow {
  count: number;
}

// ── Writer state ──────────────────────────────────────────────────────────────

type WriterState = {
  mirrorRoot: string;
  dryRun: boolean;
  copied: number;
  skipped: number;
  removed: number;
  generatedFiles: Set<string>;
};

// ── Pure helpers ──────────────────────────────────────────────────────────────

const toPosix = (value: string): string => String(value || "").replace(/\\/g, "/");

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const ensureFileDir = (filePath: string): void => {
  ensureDir(path.dirname(filePath));
};

const readUtf8IfExists = (filePath: string): string => {
  if (!filePath || !fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
};

const readJsonIfExists = <T>(filePath: string, fallback: T): T => {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
};

const listFilesRecursively = (rootDir: string): string[] => {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(filePath);
        continue;
      }
      out.push(filePath);
    }
  };
  walk(rootDir);
  return out;
};

const listDirsDeepestFirst = (rootDir: string): string[] => {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const dirPath = path.join(current, entry.name);
      if (!entry.isDirectory()) continue;
      walk(dirPath);
      out.push(dirPath);
    }
  };
  walk(rootDir);
  return out.sort((a, b) => b.length - a.length);
};

const safeFileName = (value: string, fallback = "note"): string => {
  const text = String(value || "").trim();
  const cleaned = text
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
};

const wikiLink = (relPath: string, label = ""): string => {
  const notePath = toPosix(relPath).replace(/\.md$/i, "");
  if (!label) return `[[${notePath}]]`;
  return `[[${notePath}|${label}]]`;
};

const yamlScalar = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (/^[A-Za-z0-9_.:-]+$/.test(text)) return text;
  return JSON.stringify(text);
};

const renderFrontmatter = (payload: Record<string, unknown>): string => {
  const lines = ["---"];
  for (const [key, raw] of Object.entries(payload)) {
    if (Array.isArray(raw)) {
      if (raw.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of raw) {
        lines.push(`  - ${yamlScalar(item)}`);
      }
      continue;
    }
    lines.push(`${key}: ${yamlScalar(raw)}`);
  }
  lines.push("---", "");
  return `${lines.join("\n")}\n`;
};

const daysToMs = (days: number): number =>
  Math.max(1, Number(days || 0)) * 24 * 60 * 60 * 1000;

const isVaultProtectedPath = (relPath: string): boolean => {
  const normalized = toPosix(relPath);
  return (
    normalized.startsWith(".obsidian/") ||
    normalized === ".obsidian" ||
    normalized.startsWith(".git/") ||
    normalized === ".git" ||
    normalized.startsWith(".stfolder/") ||
    normalized === ".stfolder"
  );
};

const firstSegment = (relPath: string): string => {
  const normalized = toPosix(relPath).replace(/^\/+/, "");
  return normalized.split("/")[0] ?? "";
};

const isManualPath = (relPath: string, manualFolders: string[]): boolean =>
  manualFolders.includes(firstSegment(relPath));

const isManagedGeneratedPath = (relPath: string): boolean => {
  const normalized = toPosix(relPath);
  if (normalized === "vault-index.md") return true;
  return GENERATED_DIRS.includes(firstSegment(normalized));
};

// ── Path helpers ──────────────────────────────────────────────────────────────

const homeNotePath = (homeNoteName = "Home"): string =>
  toPosix(path.join("00 Home", `${homeNoteName}.md`));

const sessionNotePath = (sessionId: string): string =>
  toPosix(path.join("10 Sessions", `${safeFileName(sessionId, "session")}.md`));

const agentNotePath = (agentId: string): string =>
  toPosix(path.join("20 Agents", `${safeFileName(agentId, "agent")}.md`));

/** Parse `agent:<agentId>:<suffix...>` session keys → agentId, or null. */
const parseAgentId = (sessionId: string): string | null => {
  const value = String(sessionId || "").trim();
  if (!value.startsWith("agent:")) return null;
  const parts = value.split(":");
  if (parts.length < 3) return null;
  const agentId = parts[1]?.trim();
  return agentId?.length ? agentId : null;
};

// ── Config helpers ────────────────────────────────────────────────────────────

const resolveMirrorRoot = (
  config: LcmConfig,
): { vaultRoot: string; subdir: string; mirrorRoot: string } => {
  const vaultRoot = String(config.vaultPath || "").trim();
  const subdir = String(config.vaultSubdir || "Engram").trim() || "Engram";
  return { vaultRoot, subdir, mirrorRoot: path.join(vaultRoot, subdir) };
};

const resolveManualFolders = (config: LcmConfig): string[] => {
  const raw = String(config.vaultManualFolders || "Inbox,Manual").trim();
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

// ── Writer state helpers ──────────────────────────────────────────────────────

const createWriterState = ({
  mirrorRoot,
  dryRun,
}: {
  mirrorRoot: string;
  dryRun: boolean;
}): WriterState => ({
  mirrorRoot,
  dryRun,
  copied: 0,
  skipped: 0,
  removed: 0,
  generatedFiles: new Set(),
});

const registerGenerated = (state: WriterState, relPath: string): void => {
  state.generatedFiles.add(toPosix(relPath));
};

const writeManagedText = (
  state: WriterState,
  relPath: string,
  content: string,
): void => {
  const normalized = toPosix(relPath);
  registerGenerated(state, normalized);
  if (state.dryRun) {
    state.copied += 1;
    return;
  }
  const targetPath = path.join(state.mirrorRoot, normalized);
  ensureFileDir(targetPath);
  const previous = readUtf8IfExists(targetPath);
  if (previous === content) {
    state.skipped += 1;
    return;
  }
  fs.writeFileSync(targetPath, content, "utf8");
  state.copied += 1;
};

const removeStaleManagedFiles = ({
  state,
  manualFolders,
}: {
  state: WriterState;
  manualFolders: string[];
}): void => {
  if (state.dryRun || !fs.existsSync(state.mirrorRoot)) return;
  const keep = new Set(state.generatedFiles);
  for (const filePath of listFilesRecursively(state.mirrorRoot)) {
    const relPath = toPosix(path.relative(state.mirrorRoot, filePath));
    if (!relPath || relPath.startsWith("../")) continue;
    if (isVaultProtectedPath(relPath)) continue;
    if (isManualPath(relPath, manualFolders)) continue;
    if (!isManagedGeneratedPath(relPath)) continue;
    if (keep.has(relPath)) continue;
    fs.unlinkSync(filePath);
    state.removed += 1;
  }
  for (const dirPath of listDirsDeepestFirst(state.mirrorRoot)) {
    const relPath = toPosix(path.relative(state.mirrorRoot, dirPath));
    if (!relPath || relPath.startsWith("../")) continue;
    if (isVaultProtectedPath(relPath)) continue;
    if (isManualPath(relPath, manualFolders)) continue;
    if (!isManagedGeneratedPath(relPath)) continue;
    if (fs.readdirSync(dirPath).length === 0) fs.rmdirSync(dirPath);
  }
};

// ── DB queries ────────────────────────────────────────────────────────────────

const queryConversations = (db: DatabaseSync): ConversationRow[] =>
  db
    .prepare(
      `SELECT conversation_id, session_id, title, created_at, updated_at
       FROM conversations
       ORDER BY updated_at DESC`,
    )
    .all() as unknown as ConversationRow[];

const querySummariesByConversation = (
  db: DatabaseSync,
  conversationId: number,
): SummaryRow[] =>
  db
    .prepare(
      `SELECT summary_id, conversation_id, kind, depth, content, token_count,
              earliest_at, latest_at, descendant_count, descendant_token_count, created_at
       FROM summaries
       WHERE conversation_id = ?
       ORDER BY depth DESC, created_at DESC`,
    )
    .all(conversationId) as unknown as SummaryRow[];

const queryAllSummaries = (db: DatabaseSync): SummaryRow[] =>
  db
    .prepare(
      `SELECT summary_id, conversation_id, kind, depth, content, token_count,
              earliest_at, latest_at, descendant_count, descendant_token_count, created_at
       FROM summaries
       ORDER BY created_at DESC`,
    )
    .all() as unknown as SummaryRow[];

const queryTotalSummaryCount = (db: DatabaseSync): number => {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM summaries`)
    .get() as unknown as CountRow;
  return Number(row?.count ?? 0);
};

const queryKindCounts = (
  db: DatabaseSync,
): { leaf: number; condensed: number } => {
  const rows = db
    .prepare(
      `SELECT kind, COUNT(*) AS count FROM summaries GROUP BY kind`,
    )
    .all() as unknown as Array<{ kind: string; count: number }>;
  let leaf = 0;
  let condensed = 0;
  for (const row of rows) {
    if (row.kind === "leaf") leaf = Number(row.count);
    if (row.kind === "condensed") condensed = Number(row.count);
  }
  return { leaf, condensed };
};

const queryLatestSessionAt = (db: DatabaseSync): string | null => {
  const row = db
    .prepare(
      `SELECT MAX(updated_at) AS latest FROM conversations`,
    )
    .get() as unknown as { latest: string | null };
  return row?.latest ?? null;
};

// ── Note renderers ────────────────────────────────────────────────────────────

type ConversationData = {
  row: ConversationRow;
  summaries: SummaryRow[];
  agentId: string | null;
};

type AgentData = {
  agentId: string;
  conversations: ConversationRow[];
  summaries: SummaryRow[];
};

const renderSessionNote = (
  data: ConversationData,
  mode: string,
): string => {
  const { row, summaries } = data;
  const exportDiagnostics = mode === "diagnostic";
  const condensed = summaries.filter((s) => s.kind === "condensed");
  const leaves = summaries.filter((s) => s.kind === "leaf");
  // Curated: only show condensed summaries; diagnostic: all
  const surfaceSummaries = exportDiagnostics ? summaries : condensed;
  const topSummary = condensed.length > 0 ? condensed[0] : surfaceSummaries[0];

  const frontmatter = renderFrontmatter({
    session_id: row.session_id,
    conversation_id: row.conversation_id,
    title: row.title || null,
    condensed_count: condensed.length,
    leaf_count: leaves.length,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });

  const lines: string[] = [];
  const title = row.title || row.session_id;
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`- session_id: ${row.session_id}`);
  if (data.agentId) lines.push(`- agent: ${wikiLink(agentNotePath(data.agentId), data.agentId)}`);
  lines.push(`- created_at: ${row.created_at}`);
  lines.push(`- updated_at: ${row.updated_at}`);
  lines.push(`- condensed_summaries: ${condensed.length}`);
  lines.push(`- leaf_summaries: ${leaves.length}`);
  lines.push("");

  if (topSummary) {
    lines.push("## Latest Summary");
    lines.push("");
    lines.push(topSummary.content.trim());
    lines.push("");
  }

  if (surfaceSummaries.length > 1) {
    lines.push("## All Summaries");
    lines.push("");
    for (const s of surfaceSummaries.slice(0, 20)) {
      const when = s.earliest_at ?? s.created_at;
      const kindLabel = s.kind === "condensed" ? "condensed" : "leaf";
      lines.push(`### [${kindLabel} · depth ${s.depth}] ${when}`);
      lines.push("");
      lines.push(s.content.trim());
      lines.push("");
    }
  }

  return `${frontmatter}${lines.join("\n")}\n`;
};

const renderAgentNote = (data: AgentData): string => {
  const { agentId, conversations } = data;
  const allSummaries = data.summaries;
  const condensed = allSummaries.filter((s) => s.kind === "condensed");
  const topSummary = condensed[0] ?? null;

  const frontmatter = renderFrontmatter({
    agent_id: agentId,
    conversation_count: conversations.length,
    condensed_count: condensed.length,
  });

  const lines: string[] = [];
  lines.push(`# Agent: ${agentId}`);
  lines.push("");
  lines.push(`- conversation_count: ${conversations.length}`);
  lines.push(`- condensed_summaries: ${condensed.length}`);
  lines.push("");

  if (topSummary) {
    lines.push("## Latest Summary");
    lines.push("");
    lines.push(topSummary.content.trim());
    lines.push("");
  }

  lines.push("## Sessions");
  lines.push("");
  for (const conv of conversations.slice(0, 30)) {
    const label = conv.title || conv.session_id;
    lines.push(`- ${wikiLink(sessionNotePath(conv.session_id), label)} (${conv.updated_at.slice(0, 10)})`);
  }
  lines.push("");

  return `${frontmatter}${lines.join("\n")}\n`;
};

const renderHomeNote = (params: {
  generatedAt: string;
  vaultRoot: string;
  subdir: string;
  conversationCount: number;
  agentCount: number;
  summaryCount: number;
  leafCount: number;
  condensedCount: number;
  lastSessionAt: string | null;
  freshness: VaultFreshness;
  mode: string;
  homeNoteName: string;
}): string => {
  const exportDiagnostics =
    params.mode === "diagnostic" || params.freshness.session.stale;
  const lines: string[] = [];
  lines.push("# Engram Surface");
  lines.push("");
  lines.push(`- generated_at: ${params.generatedAt}`);
  lines.push(`- vault_root: ${params.vaultRoot}`);
  lines.push(`- subdir: ${params.subdir}`);
  lines.push(`- conversations: ${params.conversationCount}`);
  lines.push(`- agents: ${params.agentCount}`);
  lines.push(`- total_summaries: ${params.summaryCount}`);
  lines.push(`- condensed: ${params.condensedCount}`);
  lines.push(`- leaf: ${params.leafCount}`);
  lines.push("");
  lines.push("## Model");
  lines.push("");
  lines.push(
    "- Summaries are generated from conversations using the LCM DAG compaction engine.",
  );
  lines.push(
    "- Condensed summaries are higher-level, covering many leaf summaries.",
  );
  lines.push(
    "- The default curated surface shows only condensed summaries per session.",
  );
  lines.push(
    "- Diagnostic mode additionally exports leaf summaries and depth distribution views.",
  );
  lines.push("");
  lines.push("## Health");
  lines.push("");
  lines.push(
    `- last_session_at: ${params.freshness.session.last_session_at || "none"}`,
  );
  lines.push(`- session_stale: ${params.freshness.session.stale}`);
  lines.push(
    `- vault_last_built_at: ${params.freshness.vault.last_built_at || params.generatedAt}`,
  );
  lines.push(`- vault_stale: ${params.freshness.vault.stale}`);
  lines.push(
    `- manual_folder_protection_ok: ${params.freshness.manual_protection.ok}`,
  );
  lines.push("");
  lines.push("## Views");
  lines.push("");
  lines.push(`- ${wikiLink("30 Views/Recent Sessions.md")}`);
  lines.push(`- ${wikiLink("30 Views/Agent Overview.md")}`);
  if (exportDiagnostics) {
    lines.push(`- ${wikiLink("30 Views/Summary Depth.md")}`);
  }
  lines.push("");
  lines.push("## Reports");
  lines.push("");
  lines.push(`- ${wikiLink("40 Reports/vault-build-summary.md")}`);
  lines.push(
    `- ${wikiLink("40 Reports/vault-freshness.json", "vault-freshness")}`,
  );
  lines.push(
    `- ${wikiLink("40 Reports/vault-manifest.json", "vault-manifest")}`,
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
};

const renderVaultIndex = (params: {
  generatedAt: string;
  homeNoteRelPath: string;
  conversationCount: number;
  generatedFilesCount: number;
}): string => {
  const lines: string[] = [];
  lines.push("# Engram Vault Index");
  lines.push("");
  lines.push(`- updated_at: ${params.generatedAt}`);
  lines.push(`- landing_note: ${wikiLink(params.homeNoteRelPath)}`);
  lines.push(`- conversations: ${params.conversationCount}`);
  lines.push(`- generated_files: ${params.generatedFilesCount}`);
  lines.push("");
  lines.push(`Open ${wikiLink(params.homeNoteRelPath)} to start.`);
  lines.push("");
  return `${lines.join("\n")}\n`;
};

const buildViewFiles = (params: {
  conversations: ConversationRow[];
  agentGroups: Map<string, AgentData>;
  summaries: SummaryRow[];
  generatedAt: string;
  mode: string;
}): Array<{ relPath: string; content: string }> => {
  const { conversations, agentGroups, summaries, generatedAt, mode } = params;
  const exportDiagnostics = mode === "diagnostic";
  const files: Array<{ relPath: string; content: string }> = [];

  // Recent Sessions view
  const recentLines = conversations.slice(0, 50).map((conv) => {
    const label = conv.title || conv.session_id;
    return `- ${wikiLink(sessionNotePath(conv.session_id), label)} (${conv.updated_at.slice(0, 10)})`;
  });
  files.push({
    relPath: "30 Views/Recent Sessions.md",
    content: [
      "# Recent Sessions",
      "",
      `- generated_at: ${generatedAt}`,
      `- total: ${conversations.length}`,
      "",
      "## Sessions",
      "",
      ...(recentLines.length > 0 ? recentLines : ["- none"]),
      "",
    ].join("\n") + "\n",
  });

  // Agent Overview view
  const agentLines: string[] = [];
  for (const [agentId, data] of agentGroups.entries()) {
    const condensedCount = data.summaries.filter((s) => s.kind === "condensed").length;
    agentLines.push(
      `- ${wikiLink(agentNotePath(agentId), agentId)} — ${data.conversations.length} sessions, ${condensedCount} condensed`,
    );
  }
  // Non-agent sessions (no agent: prefix)
  const nonAgentCount = conversations.filter(
    (c) => parseAgentId(c.session_id) === null,
  ).length;
  if (nonAgentCount > 0) {
    agentLines.push(`- (shared/unkeyed) — ${nonAgentCount} sessions`);
  }
  files.push({
    relPath: "30 Views/Agent Overview.md",
    content: [
      "# Agent Overview",
      "",
      `- generated_at: ${generatedAt}`,
      `- agents: ${agentGroups.size}`,
      "",
      "## Agents",
      "",
      ...(agentLines.length > 0 ? agentLines : ["- none"]),
      "",
    ].join("\n") + "\n",
  });

  // Diagnostic: Summary Depth distribution
  if (exportDiagnostics) {
    const depthCounts = new Map<number, { leaf: number; condensed: number }>();
    for (const s of summaries) {
      const entry = depthCounts.get(s.depth) ?? { leaf: 0, condensed: 0 };
      if (s.kind === "leaf") entry.leaf += 1;
      else entry.condensed += 1;
      depthCounts.set(s.depth, entry);
    }
    const depthLines: string[] = [];
    for (const [depth, counts] of Array.from(depthCounts.entries()).sort(
      (a, b) => a[0] - b[0],
    )) {
      depthLines.push(
        `- depth ${depth}: ${counts.condensed} condensed, ${counts.leaf} leaf`,
      );
    }
    files.push({
      relPath: "30 Views/Summary Depth.md",
      content: [
        "# Summary Depth Distribution",
        "",
        `- generated_at: ${generatedAt}`,
        `- total_summaries: ${summaries.length}`,
        "",
        "## Depth Counts",
        "",
        ...(depthLines.length > 0 ? depthLines : ["- none"]),
        "",
      ].join("\n") + "\n",
    });
  }

  return files;
};

// ── Renderers for report documents (exported) ─────────────────────────────────

export const renderVaultBuildMarkdown = ({
  timestamp,
  runId,
  summary,
}: {
  timestamp: string;
  runId: string;
  summary: Partial<VaultBuildSummary>;
}): string => {
  const lines: string[] = [];
  lines.push("# Vault Build Report");
  lines.push("");
  lines.push(`- timestamp: ${timestamp}`);
  lines.push(`- run_id: \`${runId}\``);
  lines.push(`- enabled: ${summary?.enabled === true}`);
  lines.push(`- vault_root: ${summary?.vault_root || ""}`);
  lines.push(`- subdir: ${summary?.subdir || ""}`);
  lines.push(`- conversations: ${Number(summary?.conversation_count || 0)}`);
  lines.push(`- agents: ${Number(summary?.agent_count || 0)}`);
  lines.push(`- summaries: ${Number(summary?.summary_count || 0)}`);
  lines.push(`- condensed: ${Number(summary?.condensed_summary_count || 0)}`);
  lines.push(`- leaf: ${Number(summary?.leaf_summary_count || 0)}`);
  lines.push(`- copied_files: ${Number(summary?.copied_files || 0)}`);
  lines.push(`- skipped_unchanged: ${Number(summary?.skipped_unchanged || 0)}`);
  lines.push(`- removed_files: ${Number(summary?.removed_files || 0)}`);
  lines.push("");
  lines.push("## Freshness");
  lines.push("");
  lines.push(
    `- last_session_at: ${summary?.freshness?.session?.last_session_at || "none"}`,
  );
  lines.push(
    `- vault_last_built_at: ${summary?.freshness?.vault?.last_built_at || timestamp}`,
  );
  lines.push(
    `- session_stale: ${summary?.freshness?.session?.stale === true}`,
  );
  lines.push(
    `- vault_stale: ${summary?.freshness?.vault?.stale === true}`,
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
};

export const renderVaultDoctorMarkdown = ({
  health,
}: {
  health: VaultHealthReport;
}): string => {
  const lines: string[] = [];
  lines.push("# Vault Doctor");
  lines.push("");
  lines.push(`- enabled: ${health.enabled}`);
  lines.push(`- vault_root: ${health.vault_root || ""}`);
  lines.push(`- mirror_root: ${health.mirror_root || ""}`);
  lines.push(`- last_session_at: ${health.session.last_session_at || "none"}`);
  lines.push(`- last_vault_built_at: ${health.vault.last_built_at || "none"}`);
  lines.push(`- session_stale: ${health.session.stale}`);
  lines.push(`- vault_stale: ${health.vault.stale}`);
  lines.push(
    `- manual_folder_protection_ok: ${health.manual_protection.ok}`,
  );
  lines.push("");
  if (health.manual_protection.issues.length > 0) {
    lines.push("## Manual Folder Issues");
    lines.push("");
    for (const issue of health.manual_protection.issues)
      lines.push(`- ${issue}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
};

// ── Surface summary artifact ──────────────────────────────────────────────────

const surfaceSummaryPath = (config: LcmConfig): string => {
  const dbDir = path.dirname(String(config.databasePath || ""));
  return path.join(dbDir, "lcm-surface-summary.json");
};

const writeSurfaceSummaryArtifact = ({
  summary,
  config,
  dryRun,
}: {
  summary: VaultBuildSummary;
  config: LcmConfig;
  dryRun: boolean;
}): string => {
  if (dryRun) return "";
  const filePath = surfaceSummaryPath(config);
  ensureFileDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return filePath;
};

// ── openContextDb helper ──────────────────────────────────────────────────────

type OpenedContext =
  | { db: DatabaseSync; close: false }
  | { db: DatabaseSync; close: true; dbPath: string };

const openContextDb = ({
  db,
  config,
}: {
  db?: DatabaseSync;
  config: LcmConfig;
}): OpenedContext => {
  if (db) return { db, close: false };
  const opened = getLcmConnection(config.databasePath);
  return { db: opened, close: true, dbPath: config.databasePath };
};

const closeContextDb = (ctx: OpenedContext): void => {
  if (ctx.close) {
    try {
      ctx.db.close();
    } catch {
      // best-effort
    }
  }
};

// ── ensureManualFolders ───────────────────────────────────────────────────────

const ensureManualFolders = ({
  mirrorRoot,
  manualFolders,
  dryRun,
}: {
  mirrorRoot: string;
  manualFolders: string[];
  dryRun: boolean;
}): void => {
  if (dryRun) return;
  ensureDir(mirrorRoot);
  for (const folder of manualFolders) {
    ensureDir(path.join(mirrorRoot, folder));
  }
};

// ── buildVaultSurface (main entry point) ──────────────────────────────────────

/**
 * Generate or refresh the Obsidian vault surface from the LCM database.
 *
 * @param options.db        Pre-opened DatabaseSync (skips opening/closing)
 * @param options.config    Resolved LcmConfig (must have vault fields set)
 * @param options.dryRun    If true, count files but don't write anything
 * @param options.runId     Optional run identifier for the build report
 */
export const buildVaultSurface = ({
  db,
  config,
  dryRun = false,
  runId = "",
}: {
  db?: DatabaseSync;
  config: LcmConfig;
  dryRun?: boolean;
  runId?: string;
}): VaultBuildSummary => {
  const { vaultRoot, subdir, mirrorRoot } = resolveMirrorRoot(config);
  const manualFolders = resolveManualFolders(config);
  const mode = String(config.obsidianMode || "curated").trim().toLowerCase();
  const exportDiagnostics =
    config.obsidianExportDiagnostics === true || mode === "diagnostic";

  const emptySummary: VaultBuildSummary = {
    enabled: config.vaultEnabled,
    generated_at: new Date().toISOString(),
    run_id: runId || `vault-build-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    vault_root: vaultRoot,
    subdir,
    mirror_root: mirrorRoot,
    conversation_count: 0,
    agent_count: 0,
    summary_count: 0,
    leaf_summary_count: 0,
    condensed_summary_count: 0,
    copied_files: 0,
    skipped_unchanged: 0,
    removed_files: 0,
    freshness: {
      session: { last_session_at: null, stale: true },
      vault: { last_built_at: null, stale: true },
      manual_protection: { ok: true, issues: [] },
    },
    manifest: {
      generated_at: new Date().toISOString(),
      vault_root: vaultRoot,
      mirror_root: mirrorRoot,
      generated_files: [],
      manual_folders: manualFolders,
      conversation_count: 0,
      summary_count: 0,
    },
    surface_summary_path: "",
    manifest_path: "",
    freshness_path: "",
    build_report_path: "",
  };

  if (!config.vaultEnabled || !vaultRoot) {
    return emptySummary;
  }

  const ctx = openContextDb({ db, config });
  try {
    const generatedAt = new Date().toISOString();
    const effectiveRunId =
      runId ||
      `vault-build-${generatedAt.replace(/[:.]/g, "-")}`;

    // ── Collect data ────────────────────────────────────────────────────────
    const conversations = queryConversations(ctx.db);
    const allSummaries = queryAllSummaries(ctx.db);
    const { leaf: leafCount, condensed: condensedCount } = queryKindCounts(ctx.db);
    const lastSessionAt = queryLatestSessionAt(ctx.db);

    // Build per-conversation summary map
    const summariesByConversation = new Map<number, SummaryRow[]>();
    for (const s of allSummaries) {
      const list = summariesByConversation.get(s.conversation_id) ?? [];
      list.push(s);
      summariesByConversation.set(s.conversation_id, list);
    }

    // Build agent groups from session keys
    const agentGroups = new Map<string, AgentData>();
    for (const conv of conversations) {
      const agentId = parseAgentId(conv.session_id);
      if (!agentId) continue;
      const existing = agentGroups.get(agentId) ?? {
        agentId,
        conversations: [],
        summaries: [],
      };
      existing.conversations.push(conv);
      existing.summaries.push(...(summariesByConversation.get(conv.conversation_id) ?? []));
      agentGroups.set(agentId, existing);
    }

    // ── Freshness ───────────────────────────────────────────────────────────
    const lastSessionMs = Date.parse(String(lastSessionAt || "")) || 0;
    const freshness: VaultFreshness = {
      session: {
        last_session_at: lastSessionAt,
        stale:
          lastSessionMs > 0
            ? Date.now() - lastSessionMs > daysToMs(7)
            : true,
      },
      vault: {
        last_built_at: generatedAt,
        stale: false,
      },
      manual_protection: { ok: true, issues: [] },
    };

    // ── Write phase ─────────────────────────────────────────────────────────
    const writer = createWriterState({ mirrorRoot, dryRun });
    ensureManualFolders({ mirrorRoot, manualFolders, dryRun });

    // Home note
    writeManagedText(
      writer,
      homeNotePath(config.vaultHomeNoteName || "Home"),
      renderHomeNote({
        generatedAt,
        vaultRoot,
        subdir,
        conversationCount: conversations.length,
        agentCount: agentGroups.size,
        summaryCount: allSummaries.length,
        leafCount,
        condensedCount,
        lastSessionAt,
        freshness,
        mode,
        homeNoteName: config.vaultHomeNoteName || "Home",
      }),
    );

    // Session notes
    for (const conv of conversations) {
      const convSummaries = summariesByConversation.get(conv.conversation_id) ?? [];
      const agentId = parseAgentId(conv.session_id);
      writeManagedText(
        writer,
        sessionNotePath(conv.session_id),
        renderSessionNote({ row: conv, summaries: convSummaries, agentId }, mode),
      );
    }

    // Agent notes
    for (const [, data] of agentGroups.entries()) {
      writeManagedText(writer, agentNotePath(data.agentId), renderAgentNote(data));
    }

    // Views
    for (const viewFile of buildViewFiles({
      conversations,
      agentGroups,
      summaries: allSummaries,
      generatedAt,
      mode,
    })) {
      writeManagedText(writer, viewFile.relPath, viewFile.content);
    }

    // Manual folder protection check
    const manualIssues: string[] = [];
    for (const folder of manualFolders) {
      const fullPath = path.join(mirrorRoot, folder);
      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
        manualIssues.push(`missing manual folder: ${folder}`);
      }
    }
    freshness.manual_protection = {
      ok: manualIssues.length === 0,
      issues: manualIssues,
    };

    // Manifest
    const manifest: VaultManifest = {
      generated_at: generatedAt,
      vault_root: vaultRoot,
      mirror_root: mirrorRoot,
      generated_files: [],
      manual_folders: manualFolders,
      conversation_count: conversations.length,
      summary_count: allSummaries.length,
    };

    // Reports
    if (config.vaultReportsEnabled !== false) {
      const plannedReportFiles = [
        "40 Reports/vault-build-summary.md",
        "40 Reports/vault-build-summary.json",
        "40 Reports/vault-manifest.json",
        "40 Reports/vault-freshness.json",
      ];
      if (exportDiagnostics) {
        plannedReportFiles.push("30 Views/Summary Depth.md");
      }
      for (const relPath of plannedReportFiles) registerGenerated(writer, relPath);
    }

    // Cleanup stale managed files
    if (config.vaultClean !== false) {
      removeStaleManagedFiles({ state: writer, manualFolders });
    }

    // Vault index
    writeManagedText(
      writer,
      "vault-index.md",
      renderVaultIndex({
        generatedAt,
        homeNoteRelPath: homeNotePath(config.vaultHomeNoteName || "Home"),
        conversationCount: conversations.length,
        generatedFilesCount: writer.generatedFiles.size,
      }),
    );

    // Finalize manifest with generated files
    manifest.generated_files = Array.from(writer.generatedFiles).sort();

    const buildSummary: VaultBuildSummary = {
      enabled: true,
      generated_at: generatedAt,
      run_id: effectiveRunId,
      vault_root: vaultRoot,
      subdir,
      mirror_root: mirrorRoot,
      conversation_count: conversations.length,
      agent_count: agentGroups.size,
      summary_count: allSummaries.length,
      leaf_summary_count: leafCount,
      condensed_summary_count: condensedCount,
      copied_files: writer.copied,
      skipped_unchanged: writer.skipped,
      removed_files: writer.removed,
      freshness,
      manifest,
      surface_summary_path: "",
      manifest_path: config.vaultReportsEnabled !== false
        ? path.join(mirrorRoot, "40 Reports", "vault-manifest.json")
        : "",
      freshness_path: config.vaultReportsEnabled !== false
        ? path.join(mirrorRoot, "40 Reports", "vault-freshness.json")
        : "",
      build_report_path: config.vaultReportsEnabled !== false
        ? path.join(mirrorRoot, "40 Reports", "vault-build-summary.md")
        : "",
    };

    // Write report files
    if (config.vaultReportsEnabled !== false) {
      const buildReportMarkdown = renderVaultBuildMarkdown({
        timestamp: generatedAt,
        runId: effectiveRunId,
        summary: buildSummary,
      });
      writeManagedText(writer, "40 Reports/vault-build-summary.md", buildReportMarkdown);
      writeManagedText(
        writer,
        "40 Reports/vault-build-summary.json",
        `${JSON.stringify(buildSummary, null, 2)}\n`,
      );
      writeManagedText(
        writer,
        "40 Reports/vault-manifest.json",
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      const freshnessData = {
        generated_at: generatedAt,
        session: freshness.session,
        vault: freshness.vault,
        manual_protection: freshness.manual_protection,
      };
      writeManagedText(
        writer,
        "40 Reports/vault-freshness.json",
        `${JSON.stringify(freshnessData, null, 2)}\n`,
      );
    }

    // Write surface summary artifact next to the DB
    const outputSummaryPath = writeSurfaceSummaryArtifact({
      summary: { ...buildSummary, manifest: { ...manifest, generated_files: manifest.generated_files } },
      config,
      dryRun,
    });

    return {
      ...buildSummary,
      surface_summary_path: outputSummaryPath,
      copied_files: writer.copied,
      skipped_unchanged: writer.skipped,
      removed_files: writer.removed,
      manifest: { ...manifest, generated_files: Array.from(writer.generatedFiles).sort() },
    };
  } finally {
    closeContextDb(ctx);
  }
};

// ── inspectVaultHealth ────────────────────────────────────────────────────────

/**
 * Return vault health/freshness without doing a full rebuild.
 * Reads from the surface-summary artifact if available; otherwise queries DB.
 */
export const inspectVaultHealth = ({
  db,
  config,
}: {
  db?: DatabaseSync;
  config: LcmConfig;
}): VaultHealthReport => {
  const { vaultRoot, mirrorRoot } = resolveMirrorRoot(config);
  const manualFolders = resolveManualFolders(config);
  const summaryFilePath = surfaceSummaryPath(config);
  const existing = readJsonIfExists<VaultBuildSummary | null>(
    summaryFilePath,
    null,
  );

  const manualIssues: string[] = [];
  for (const folder of manualFolders) {
    const folderPath = path.join(mirrorRoot, folder);
    if (
      !fs.existsSync(folderPath) ||
      !fs.statSync(folderPath).isDirectory()
    ) {
      manualIssues.push(`missing manual folder: ${folder}`);
    }
  }

  if (existing) {
    const lastSessionMs =
      Date.parse(String(existing.freshness?.session?.last_session_at || "")) || 0;
    const buildLastMs =
      Date.parse(String(existing.freshness?.vault?.last_built_at || existing.generated_at || "")) || 0;
    return {
      enabled: config.vaultEnabled,
      vault_root: vaultRoot,
      mirror_root: mirrorRoot,
      session: {
        last_session_at: existing.freshness?.session?.last_session_at ?? null,
        stale:
          lastSessionMs > 0
            ? Date.now() - lastSessionMs > daysToMs(7)
            : true,
      },
      vault: {
        last_built_at:
          existing.freshness?.vault?.last_built_at ?? existing.generated_at ?? null,
        stale:
          buildLastMs > 0
            ? Date.now() - buildLastMs > daysToMs(STALE_VAULT_DAYS)
            : true,
      },
      manual_protection: { ok: manualIssues.length === 0, issues: manualIssues },
      summary_path: summaryFilePath,
    };
  }

  // Fallback: query DB directly
  const ctx = openContextDb({ db, config });
  try {
    const lastSessionAt = queryLatestSessionAt(ctx.db);
    const lastSessionMs = Date.parse(String(lastSessionAt || "")) || 0;
    const buildReportPath = path.join(
      mirrorRoot,
      "40 Reports",
      "vault-build-summary.md",
    );
    const buildLastMs = fs.existsSync(buildReportPath)
      ? fs.statSync(buildReportPath).mtimeMs
      : 0;
    return {
      enabled: config.vaultEnabled,
      vault_root: vaultRoot,
      mirror_root: mirrorRoot,
      session: {
        last_session_at: lastSessionAt,
        stale:
          lastSessionMs > 0
            ? Date.now() - lastSessionMs > daysToMs(7)
            : true,
      },
      vault: {
        last_built_at:
          buildLastMs > 0 ? new Date(buildLastMs).toISOString() : null,
        stale:
          buildLastMs > 0
            ? Date.now() - buildLastMs > daysToMs(STALE_VAULT_DAYS)
            : true,
      },
      manual_protection: { ok: manualIssues.length === 0, issues: manualIssues },
      summary_path: summaryFilePath,
    };
  } finally {
    closeContextDb(ctx);
  }
};

// ── loadSurfaceSummary ────────────────────────────────────────────────────────

/**
 * Load the last written surface-summary artifact (stored next to the DB).
 */
export const loadSurfaceSummary = ({
  config,
}: {
  config: LcmConfig;
}): { filePath: string; summary: VaultBuildSummary | null } => {
  const filePath = surfaceSummaryPath(config);
  return {
    filePath,
    summary: readJsonIfExists<VaultBuildSummary | null>(filePath, null),
  };
};

// ── syncVaultPull ─────────────────────────────────────────────────────────────

/**
 * Pull a remote vault mirror to a local target using rsync.
 * Mirrors the gigabrain syncVaultPull API.
 */
export const syncVaultPull = ({
  host = "",
  remotePath = "",
  target = "",
  subdir = "Engram",
  manualFolders = ["Inbox", "Manual"],
  preserveManual = true,
  dryRun = false,
}: {
  host?: string;
  remotePath?: string;
  target?: string;
  subdir?: string;
  manualFolders?: string[];
  preserveManual?: boolean;
  dryRun?: boolean;
} = {}): VaultPullResult => {
  const sourceRoot = String(remotePath || "").trim();
  const targetRoot = String(target || "").trim();
  if (!sourceRoot) throw new Error("vault pull requires --remote-path");
  if (!targetRoot) throw new Error("vault pull requires --target");

  ensureDir(targetRoot);

  const normalizedSubdir =
    String(subdir || "Engram").trim() || "Engram";
  const args: string[] = ["-a", "--delete"];
  if (dryRun) args.push("--dry-run", "--itemize-changes");
  if (preserveManual) {
    args.push("--filter", "P .obsidian/***");
    for (const folder of manualFolders) {
      args.push("--filter", `P ${normalizedSubdir}/${folder}/***`);
    }
  }
  const sourceSpec = host
    ? `${String(host).trim()}:${sourceRoot.replace(/\/+$/, "")}/`
    : `${sourceRoot.replace(/\/+$/, "")}/`;
  const targetSpec = `${targetRoot.replace(/\/+$/, "")}/`;
  const run = spawnSync("rsync", [...args, sourceSpec, targetSpec], {
    encoding: "utf8",
  });
  if (Number(run.status ?? 0) !== 0) {
    throw new Error(
      `vault pull failed: ${String(run.stderr || run.stdout || "unknown rsync error").trim()}`,
    );
  }
  const changes = String(run.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !line.startsWith("sending incremental") &&
        !line.startsWith("sent ") &&
        !line.startsWith("total size"),
    );
  return {
    ok: true,
    host: String(host || "").trim() || null,
    remote_path: sourceRoot,
    target: targetRoot,
    dry_run: dryRun,
    preserve_manual: preserveManual,
    manual_folders: manualFolders,
    subdir: normalizedSubdir,
    changed_paths: changes,
    command: ["rsync", ...args, sourceSpec, targetSpec].join(" "),
  };
};
