import path from "node:path";
import type { SupervisorCommand, SupervisorConfig } from "./supervisor-types.js";

const DEFAULT_PROJECT_DIR = process.env.OPENCLAW_SUPERVISOR_PROJECT ?? "D:\\learn\\openclaw-plugins";
const DEFAULT_PORT = 8791;
const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_STALE_AFTER_MS = 4 * 60 * 60_000;
const DEFAULT_MAX_FILES = 8_000;
const DEFAULT_MAX_HISTORY = 100;
const DEFAULT_MAX_INSTRUCTIONS = 200;
const DEFAULT_MAX_NOTIFICATIONS = 200;
const DEFAULT_MAX_TASK_LOG_CHARS = 80_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_NOTIFICATION_COOLDOWN_MS = 30 * 60_000;
const DEFAULT_COMMANDS: Record<string, string> = {
  build: "npm run build",
  test: "npm test",
  check: "npm run check"
};

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return fallback;
}

function normalizeAllowedCommands(value: SupervisorConfig["allowedCommands"]): Record<string, SupervisorCommand> {
  const source = value && Object.keys(value).length > 0 ? value : DEFAULT_COMMANDS;
  const out: Record<string, SupervisorCommand> = {};
  for (const [name, raw] of Object.entries(source)) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) continue;
    if (typeof raw === "string") out[name] = { title: name, command: raw };
    else if (raw && typeof raw.command === "string") out[name] = { title: raw.title || name, command: raw.command, timeoutMs: raw.timeoutMs };
  }
  return out;
}

export function normalizeSupervisorConfig(input: SupervisorConfig = {}): Required<Omit<SupervisorConfig, "allowedCommands">> & { allowedCommands: Record<string, SupervisorCommand> } {
  const projectDir = path.resolve(input.projectDir ?? DEFAULT_PROJECT_DIR);
  const stateFile = path.resolve(input.stateFile ?? path.join(projectDir, ".project-supervisor", "state.json"));
  const stateDir = path.dirname(stateFile);
  const supervisorHome = path.resolve(process.env.OPENCLAW_SUPERVISOR_HOME ?? path.join(path.dirname(projectDir), ".project-supervisor"));
  const projectId = input.projectId?.trim() || path.basename(projectDir).toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "project";
  return {
    projectId,
    projectDir,
    stateFile,
    workerStateFile: path.resolve(input.workerStateFile ?? path.join(stateDir, "worker-state.json")),
    workerInboxFile: path.resolve(input.workerInboxFile ?? path.join(stateDir, "inbox.jsonl")),
    workerOutboxFile: path.resolve(input.workerOutboxFile ?? path.join(stateDir, "outbox.jsonl")),
    auditFile: path.resolve(input.auditFile ?? path.join(stateDir, "audit.jsonl")),
    projectRegistryFile: path.resolve(input.projectRegistryFile ?? path.join(supervisorHome, "projects.json")),
    accountRegistryFile: path.resolve(input.accountRegistryFile ?? path.join(supervisorHome, "accounts.json")),
    defaultWorkerId: input.defaultWorkerId?.trim() || "worker-ai",
    host: input.host ?? "127.0.0.1",
    port: parsePositiveInt(input.port, DEFAULT_PORT),
    publicUrl: input.publicUrl ?? "",
    token: input.token ?? "",
    autoStartServer: input.autoStartServer !== false,
    scanIntervalMs: parsePositiveInt(input.scanIntervalMs, DEFAULT_SCAN_INTERVAL_MS),
    staleAfterMs: parsePositiveInt(input.staleAfterMs, DEFAULT_STALE_AFTER_MS),
    maxFiles: parsePositiveInt(input.maxFiles, DEFAULT_MAX_FILES),
    maxHistory: parsePositiveInt(input.maxHistory, DEFAULT_MAX_HISTORY),
    maxInstructions: parsePositiveInt(input.maxInstructions, DEFAULT_MAX_INSTRUCTIONS),
    maxNotifications: parsePositiveInt(input.maxNotifications, DEFAULT_MAX_NOTIFICATIONS),
    maxTaskLogChars: parsePositiveInt(input.maxTaskLogChars, DEFAULT_MAX_TASK_LOG_CHARS),
    commandTimeoutMs: parsePositiveInt(input.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS),
    notificationCooldownMs: parsePositiveInt(input.notificationCooldownMs, DEFAULT_NOTIFICATION_COOLDOWN_MS),
    watchedPorts: Array.isArray(input.watchedPorts) ? input.watchedPorts.filter((p) => Number.isInteger(p) && p > 0 && p < 65536) : [],
    logFiles: Array.isArray(input.logFiles) ? input.logFiles.filter((p) => typeof p === "string" && p.trim()).slice(0, 8) : [],
    ignoreDirs: Array.isArray(input.ignoreDirs) ? input.ignoreDirs.filter((p) => typeof p === "string" && p.trim()) : [],
    allowedCommands: normalizeAllowedCommands(input.allowedCommands)
  };
}

export type NormalizedSupervisorConfig = ReturnType<typeof normalizeSupervisorConfig>;
