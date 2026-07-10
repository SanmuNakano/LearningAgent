import path from "node:path";
import type { SupervisorCommand, SupervisorConfig, WorkerRuntimeConfig } from "./supervisor-types.js";

const DEFAULT_PROJECT_DIR = process.env.OPENCLAW_SUPERVISOR_PROJECT ?? "D:\\learn\\openclaw-plugins";
const DEFAULT_PORT = 8791;
const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_STALE_AFTER_MS = 4 * 60 * 60_000;
const DEFAULT_INSTRUCTION_ACK_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_INSTRUCTION_PROGRESS_TIMEOUT_MS = 2 * 60 * 60_000;
const DEFAULT_MAX_FILES = 8_000;
const DEFAULT_MAX_HISTORY = 100;
const DEFAULT_MAX_INSTRUCTIONS = 200;
const DEFAULT_MAX_NOTIFICATIONS = 200;
const DEFAULT_AUDIT_RETENTION_DAYS = 90;
const DEFAULT_MAX_AUDIT_ENTRIES = 10_000;
const DEFAULT_MAX_TASK_LOG_CHARS = 80_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_NOTIFICATION_COOLDOWN_MS = 30 * 60_000;
const DEFAULT_NOTIFICATION_DELIVERY_INTERVAL_MS = 60_000;
const DEFAULT_NOTIFICATION_DELIVERY_TIMEOUT_MS = 10_000;
const DEFAULT_WORKER_POLL_INTERVAL_MS = 5_000;
const DEFAULT_WORKER_TIMEOUT_MS = 30 * 60_000;
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

export function normalizeWorkerRuntimeConfig(input: WorkerRuntimeConfig = {}): Required<Omit<WorkerRuntimeConfig, "model" | "profile" | "provider">> & Pick<WorkerRuntimeConfig, "model" | "profile" | "provider"> {
  const workerId = input.workerId?.trim() || "codex-main";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(workerId)) throw new Error("workerRuntime.workerId must contain only letters, numbers, underscores, or hyphens.");
  if (input.sandbox && input.sandbox !== "read-only" && input.sandbox !== "workspace-write") throw new Error("workerRuntime.sandbox is invalid.");
  let provider = input.provider;
  if (provider) {
    const id = provider.id?.trim();
    const baseUrl = provider.baseUrl?.trim();
    const envKey = provider.envKey?.trim();
    if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error("workerRuntime.provider.id is invalid.");
    if (!baseUrl || !/^https?:\/\/[^\s"']+$/i.test(baseUrl)) throw new Error("workerRuntime.provider.baseUrl must be an HTTP(S) URL.");
    if (!envKey || !/^[A-Z_][A-Z0-9_]{1,127}$/.test(envKey)) throw new Error("workerRuntime.provider.envKey must name an environment variable, not contain a secret.");
    if (provider.wireApi && provider.wireApi !== "responses" && provider.wireApi !== "chat") throw new Error("workerRuntime.provider.wireApi is invalid.");
    provider = { id, baseUrl, envKey, wireApi: provider.wireApi };
  }
  return {
    enabled: input.enabled === true,
    workerId,
    model: input.model?.trim() || undefined,
    profile: input.profile?.trim() || undefined,
    sandbox: input.sandbox ?? "workspace-write",
    pollIntervalMs: parsePositiveInt(input.pollIntervalMs, DEFAULT_WORKER_POLL_INTERVAL_MS),
    timeoutMs: parsePositiveInt(input.timeoutMs, DEFAULT_WORKER_TIMEOUT_MS),
    provider
  };
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
    instructionAckTimeoutMs: parsePositiveInt(input.instructionAckTimeoutMs, DEFAULT_INSTRUCTION_ACK_TIMEOUT_MS),
    instructionProgressTimeoutMs: parsePositiveInt(input.instructionProgressTimeoutMs, DEFAULT_INSTRUCTION_PROGRESS_TIMEOUT_MS),
    maxFiles: parsePositiveInt(input.maxFiles, DEFAULT_MAX_FILES),
    maxHistory: parsePositiveInt(input.maxHistory, DEFAULT_MAX_HISTORY),
    maxInstructions: parsePositiveInt(input.maxInstructions, DEFAULT_MAX_INSTRUCTIONS),
    maxNotifications: parsePositiveInt(input.maxNotifications, DEFAULT_MAX_NOTIFICATIONS),
    auditRetentionDays: parsePositiveInt(input.auditRetentionDays, DEFAULT_AUDIT_RETENTION_DAYS),
    maxAuditEntries: parsePositiveInt(input.maxAuditEntries, DEFAULT_MAX_AUDIT_ENTRIES),
    maxTaskLogChars: parsePositiveInt(input.maxTaskLogChars, DEFAULT_MAX_TASK_LOG_CHARS),
    commandTimeoutMs: parsePositiveInt(input.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS),
    notificationCooldownMs: parsePositiveInt(input.notificationCooldownMs, DEFAULT_NOTIFICATION_COOLDOWN_MS),
    notificationWebhookUrl: input.notificationWebhookUrl?.trim() ?? "",
    notificationWebhookBearerToken: input.notificationWebhookBearerToken ?? "",
    notificationDeliveryIntervalMs: parsePositiveInt(input.notificationDeliveryIntervalMs, DEFAULT_NOTIFICATION_DELIVERY_INTERVAL_MS),
    notificationDeliveryTimeoutMs: parsePositiveInt(input.notificationDeliveryTimeoutMs, DEFAULT_NOTIFICATION_DELIVERY_TIMEOUT_MS),
    watchedPorts: Array.isArray(input.watchedPorts) ? input.watchedPorts.filter((p) => Number.isInteger(p) && p > 0 && p < 65536) : [],
    logFiles: Array.isArray(input.logFiles) ? input.logFiles.filter((p) => typeof p === "string" && p.trim()).slice(0, 8) : [],
    ignoreDirs: Array.isArray(input.ignoreDirs) ? input.ignoreDirs.filter((p) => typeof p === "string" && p.trim()) : [],
    allowedCommands: normalizeAllowedCommands(input.allowedCommands),
    workerRuntime: normalizeWorkerRuntimeConfig(input.workerRuntime)
  };
}

export type NormalizedSupervisorConfig = ReturnType<typeof normalizeSupervisorConfig>;
