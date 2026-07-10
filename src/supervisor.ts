import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CodexQuotaService,
  type CodexAccount,
  type QuotaRegistry,
  type QuotaLogCursor,
  type QuotaLogSource,
  type QuotaWindow,
  type RegisterQuotaLogSourceInput,
  type RegisterAccountInput,
  type SetQuotaInput
} from "./quota.js";
import { parseCodexQuotaSignal, type CodexQuotaObservation } from "./codex-quota-adapter.js";
import { isQuotaSignalCandidate, pollQuotaLogSource } from "./quota-log-watcher.js";
import {
  redactUrlToken,
  stripUrlToken,
  writeHttpError
} from "./supervisor-http.js";
import { handleSupervisorHttp } from "./supervisor-controller.js";
import { InstructionService, NotificationService, WorkerService } from "./supervisor-services.js";
import { normalizeSupervisorConfig, type NormalizedSupervisorConfig } from "./supervisor-config.js";
export { normalizeSupervisorConfig } from "./supervisor-config.js";
import { checkPort, readLogTails, readPackageScripts, scanFiles, scanGit } from "./project-scanner.js";
import {
  buildNextActions,
  buildRisks,
  buildSupervisionSignals,
  buildWorkerRisks,
  combineHealth,
  updateNotificationsFromSignals
} from "./supervision-evaluator.js";

type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

import type {
  FileScanSummary,
  GitSummary,
  InstructionStatus,
  PortSummary,
  ProjectRegistry,
  ProjectRegistryEntry,
  SupervisionSignal,
  SupervisorCommand,
  SupervisorConfig,
  SupervisorHealth,
  SupervisorInstruction,
  SupervisorNextAction,
  SupervisorNotification,
  SupervisorNotificationDeliveryStatus,
  SupervisorNotificationStatus,
  SupervisorOverview,
  SupervisorSnapshot,
  SupervisorState,
  TaskRecord,
  TaskStatus,
  WorkerHeartbeatUpdate,
  WorkerInboxInstruction,
  WorkerInstructionEvent,
  WorkerInstructionStatus,
  WorkerPlanItem,
  WorkerState,
  WorkerStateSource,
  WorkerStatus
} from "./supervisor-types.js";
export type {
  FileScanSummary,
  GitSummary,
  InstructionStatus,
  PortSummary,
  ProjectRegistry,
  ProjectRegistryEntry,
  SupervisionSignal,
  SupervisorCommand,
  SupervisorConfig,
  SupervisorHealth,
  SupervisorInstruction,
  SupervisorNextAction,
  SupervisorNotification,
  SupervisorNotificationDeliveryStatus,
  SupervisorNotificationStatus,
  SupervisorOverview,
  SupervisorSnapshot,
  SupervisorState,
  TaskRecord,
  TaskStatus,
  WorkerHeartbeatUpdate,
  WorkerInboxInstruction,
  WorkerInstructionEvent,
  WorkerInstructionStatus,
  WorkerPlanItem,
  WorkerState,
  WorkerStateSource,
  WorkerStatus
} from "./supervisor-types.js";
function nowIso(): string {
  return new Date().toISOString();
}

function toId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellFor(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: "powershell.exe", args: ["-NoProfile", "-Command", command] };
  return { file: "/bin/sh", args: ["-lc", command] };
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf-8");
}

async function appendJsonLine(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(value)}\n`, "utf-8");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeProjectRegistry(raw: unknown): ProjectRegistry {
  if (!isRecord(raw)) return { projects: [] };
  const projects: ProjectRegistryEntry[] = [];
  if (Array.isArray(raw.projects)) {
    for (const item of raw.projects) {
      if (!isRecord(item)) continue;
      const id = optionalString(item.id);
      const projectDir = optionalString(item.projectDir);
      if (!id || !projectDir) continue;
      projects.push({
        id,
        name: optionalString(item.name),
        projectDir,
        stateFile: optionalString(item.stateFile),
        workerStateFile: optionalString(item.workerStateFile),
        workerInboxFile: optionalString(item.workerInboxFile),
        workerOutboxFile: optionalString(item.workerOutboxFile),
        auditFile: optionalString(item.auditFile),
        addedAt: optionalString(item.addedAt) ?? nowIso(),
        lastSeenAt: optionalString(item.lastSeenAt)
      });
    }
  }
  return {
    activeProjectId: optionalString(raw.activeProjectId),
    projects
  };
}

async function readProjectRegistry(file: string): Promise<ProjectRegistry> {
  const raw = await readJsonFile<unknown>(file, {});
  return normalizeProjectRegistry(raw);
}

async function writeProjectRegistry(file: string, registry: ProjectRegistry): Promise<void> {
  await writeJsonFile(file, {
    activeProjectId: registry.activeProjectId,
    projects: registry.projects.sort((a, b) => a.id.localeCompare(b.id))
  });
}

function normalizeState(raw: unknown): SupervisorState {
  if (!isRecord(raw)) return { snapshots: [], tasks: [], instructions: [], notifications: [] };
  return {
    token: typeof raw.token === "string" ? raw.token : undefined,
    snapshots: Array.isArray(raw.snapshots) ? raw.snapshots as SupervisorSnapshot[] : [],
    tasks: Array.isArray(raw.tasks) ? raw.tasks as TaskRecord[] : [],
    instructions: Array.isArray(raw.instructions) ? raw.instructions as SupervisorInstruction[] : [],
    notifications: Array.isArray(raw.notifications) ? raw.notifications as SupervisorNotification[] : []
  };
}

function projectEntryFromConfig(cfg: NormalizedSupervisorConfig, existing?: ProjectRegistryEntry, seenAt = nowIso()): ProjectRegistryEntry {
  return {
    id: cfg.projectId,
    name: existing?.name ?? cfg.projectId,
    projectDir: cfg.projectDir,
    stateFile: cfg.stateFile,
    workerStateFile: cfg.workerStateFile,
    workerInboxFile: cfg.workerInboxFile,
    workerOutboxFile: cfg.workerOutboxFile,
    auditFile: cfg.auditFile,
    addedAt: existing?.addedAt ?? seenAt,
    lastSeenAt: seenAt
  };
}

function configForRegistryEntry(
  base: NormalizedSupervisorConfig,
  entry: ProjectRegistryEntry,
  overrides: SupervisorConfig = {}
): SupervisorConfig {
  return {
    projectId: entry.id,
    projectDir: entry.projectDir,
    stateFile: entry.stateFile,
    workerStateFile: entry.workerStateFile,
    workerInboxFile: entry.workerInboxFile,
    workerOutboxFile: entry.workerOutboxFile,
    auditFile: entry.auditFile,
    projectRegistryFile: base.projectRegistryFile,
    accountRegistryFile: base.accountRegistryFile,
    defaultWorkerId: base.defaultWorkerId,
    host: base.host,
    port: base.port,
    publicUrl: base.publicUrl,
    token: base.token,
    autoStartServer: false,
    scanIntervalMs: base.scanIntervalMs,
    staleAfterMs: base.staleAfterMs,
    maxFiles: base.maxFiles,
    maxHistory: base.maxHistory,
    maxInstructions: base.maxInstructions,
    maxNotifications: base.maxNotifications,
    maxTaskLogChars: base.maxTaskLogChars,
    commandTimeoutMs: base.commandTimeoutMs,
    notificationCooldownMs: base.notificationCooldownMs,
    watchedPorts: [...base.watchedPorts],
    logFiles: [...base.logFiles],
    ignoreDirs: [...base.ignoreDirs],
    allowedCommands: base.allowedCommands,
    ...overrides
  };
}

export class ProjectSupervisor {
  private readonly cfg: NormalizedSupervisorConfig;
  private readonly logger: Logger;
  private server: ReturnType<typeof createServer> | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private runningTasks = new Map<string, TaskRecord>();
  private token = "";
  private readonly workerService: WorkerService;
  private readonly instructionService: InstructionService;
  private readonly notificationService: NotificationService;

  constructor(config: SupervisorConfig = {}, logger: Logger = {}) {
    this.cfg = normalizeSupervisorConfig(config);
    this.logger = logger;
    this.token = this.cfg.token;
    const dependencies = {
      readState: () => this.readState(),
      writeState: (state: SupervisorState) => this.writeState(state),
      audit: (event: string, payload: unknown) => this.audit(event, payload)
    };
    this.workerService = new WorkerService(this.cfg, dependencies);
    this.instructionService = new InstructionService(this.cfg, dependencies, this.workerService);
    this.notificationService = new NotificationService(this.cfg.projectId, dependencies);
  }

  getConfig(): ReturnType<typeof normalizeSupervisorConfig> {
    return this.cfg;
  }

  async ensureStarted(): Promise<void> {
    await this.ensureToken();
    if (this.cfg.autoStartServer) await this.startServer();
    if (!this.scanTimer) {
      await this.scan();
      this.scanTimer = setInterval(() => {
        this.scan().catch((error) => this.logger.warn?.(`project-supervisor scan failed: ${String(error)}`));
      }, this.cfg.scanIntervalMs);
    }
  }

  async stop(): Promise<void> {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async ensureToken(): Promise<string> {
    if (this.token) return this.token;
    const state = await this.readState();
    if (state.token) {
      this.token = state.token;
      return this.token;
    }
    this.token = randomBytes(18).toString("base64url");
    state.token = this.token;
    await this.writeState(state);
    return this.token;
  }

  async readState(): Promise<SupervisorState> {
    const raw = await readJsonFile<unknown>(this.cfg.stateFile, {});
    return normalizeState(raw);
  }

  async writeState(state: SupervisorState): Promise<void> {
    state.snapshots = state.snapshots.slice(-this.cfg.maxHistory);
    state.tasks = state.tasks.slice(-this.cfg.maxHistory);
    state.instructions = state.instructions.slice(-this.cfg.maxInstructions);
    state.notifications = state.notifications.slice(-this.cfg.maxNotifications);
    if (this.token) state.token = this.token;
    await writeJsonFile(this.cfg.stateFile, state);
  }

  async readProjectRegistry(): Promise<ProjectRegistry> {
    return await readProjectRegistry(this.cfg.projectRegistryFile);
  }

  async registerCurrentProject(): Promise<ProjectRegistryEntry> {
    return await this.registerProject(this.cfg.projectDir, this.cfg.projectId);
  }

  async registerProject(projectDir: string, projectId?: string): Promise<ProjectRegistryEntry> {
    const normalized = normalizeSupervisorConfig(configForRegistryEntry(this.cfg, {
      id: projectId?.trim() || path.basename(projectDir).toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "project",
      projectDir,
      addedAt: nowIso()
    }));
    if (!await pathExists(normalized.projectDir)) {
      throw new Error(`Project directory does not exist: ${normalized.projectDir}`);
    }
    const registry = await this.readProjectRegistry();
    const now = nowIso();
    const existing = registry.projects.find((project) => project.id === normalized.projectId);
    const entry = projectEntryFromConfig(normalized, existing, now);
    const existingIndex = registry.projects.findIndex((project) => project.id === entry.id);
    if (existingIndex >= 0) {
      const existing = registry.projects[existingIndex];
      registry.projects[existingIndex] = {
        ...existing,
        projectDir: entry.projectDir,
        stateFile: entry.stateFile,
        workerStateFile: entry.workerStateFile,
        workerInboxFile: entry.workerInboxFile,
        workerOutboxFile: entry.workerOutboxFile,
        auditFile: entry.auditFile,
        lastSeenAt: now
      };
    } else {
      registry.projects.push(entry);
    }
    registry.activeProjectId = entry.id;
    await writeProjectRegistry(this.cfg.projectRegistryFile, registry);
    await this.audit("project_registered", entry);
    return existingIndex >= 0 ? registry.projects[existingIndex] : entry;
  }

  async scan(): Promise<SupervisorSnapshot> {
    if (!await pathExists(this.cfg.projectDir)) {
      throw new Error(`Project directory does not exist: ${this.cfg.projectDir}`);
    }
    const state = await this.readState();
    const tasks = [...state.tasks, ...this.runningTasks.values()].slice(-this.cfg.maxHistory);
    const [outboxEvents, registry] = await Promise.all([
      this.workerService.readOutbox(),
      this.readProjectRegistry()
    ]);
    const instructions = this.workerService.applyEvents(state.instructions.slice(-this.cfg.maxInstructions), outboxEvents);
    const [fileScan, git, packageScripts, ports, logTails, worker] = await Promise.all([
      scanFiles(this.cfg.projectDir, { maxFiles: this.cfg.maxFiles, ignoreDirs: this.cfg.ignoreDirs }),
      scanGit(this.cfg.projectDir),
      readPackageScripts(this.cfg.projectDir),
      Promise.all(this.cfg.watchedPorts.map((port) => checkPort(port))),
      readLogTails(this.cfg.projectDir, this.cfg.logFiles),
      this.workerService.getState()
    ]);
    const projectRisk = buildRisks({ git, fileScan, ports, tasks, staleAfterMs: this.cfg.staleAfterMs });
    const workerRisks = buildWorkerRisks(worker, instructions);
    const signals = buildSupervisionSignals({ git, tasks, worker, instructions, staleAfterMs: this.cfg.staleAfterMs });
    const baseHealth = combineHealth(projectRisk.health, worker, instructions);
    const health = signals.some((signal) => signal.severity === "critical")
      ? "blocked"
      : baseHealth === "ok" && signals.some((signal) => signal.severity === "watch")
        ? "watch"
        : baseHealth;
    const signalRisks = signals
      .filter((signal) => signal.severity !== "info")
      .map((signal) => `${signal.title}: ${signal.detail}`);
    const risks = [...projectRisk.risks, ...workerRisks, ...signalRisks];
    const nextActions = buildNextActions({ projectHealth: projectRisk.health, git, tasks, worker, instructions });
    const changed = git.available ? `${git.changedFiles ?? 0} git change(s)` : "git unavailable";
    const summary = `${health.toUpperCase()}: ${changed}, ${fileScan.recent.length} recently touched file(s), ${tasks.filter((task) => task.status === "running").length} running task(s), ${tasks.filter((task) => task.status === "failed" || task.status === "timeout").length} failed task(s), worker ${worker.status}.`;
    const snapshot: SupervisorSnapshot = {
      id: toId(`${this.cfg.projectDir}:${Date.now()}:${Math.random()}`),
      projectDir: this.cfg.projectDir,
      scannedAt: nowIso(),
      health,
      summary,
      risks,
      fileScan,
      git,
      packageScripts,
      ports,
      logTails,
      tasks,
      worker,
      instructions: instructions.slice(-20),
      nextActions,
      signals,
      projects: registry
    };
    state.snapshots.push(snapshot);
    state.tasks = tasks.filter((task, index, list) => list.findIndex((other) => other.id === task.id) === index).slice(-this.cfg.maxHistory);
    state.instructions = instructions;
    state.notifications = updateNotificationsFromSignals({
      projectId: this.cfg.projectId,
      snapshotId: snapshot.id,
      existing: state.notifications,
      signals,
      cooldownMs: this.cfg.notificationCooldownMs,
      maxNotifications: this.cfg.maxNotifications,
      now: snapshot.scannedAt
    });
    await this.writeState(state);
    return snapshot;
  }

  async latest(): Promise<SupervisorSnapshot> {
    const state = await this.readState();
    const latest = state.snapshots.at(-1);
    if (!latest || Date.now() - Date.parse(latest.scannedAt) > this.cfg.scanIntervalMs * 2) {
      return await this.scan();
    }
    return latest;
  }

  async getWorkerState(): Promise<WorkerState> {
    return await this.workerService.getState();
  }

  async updateWorkerHeartbeat(update: WorkerHeartbeatUpdate): Promise<WorkerState> {
    return await this.workerService.updateHeartbeat(update);
  }

  async listInstructions(status?: InstructionStatus): Promise<SupervisorInstruction[]> {
    return await this.instructionService.list(status);
  }

  async listNotifications(status?: SupervisorNotificationStatus): Promise<SupervisorNotification[]> {
    return await this.notificationService.list(status);
  }

  async listNotificationOutbox(): Promise<SupervisorNotification[]> {
    return await this.notificationService.listOutbox();
  }

  async markNotificationDelivery(params: {
    id: string;
    status: Extract<SupervisorNotificationDeliveryStatus, "delivered" | "failed">;
    error?: string;
  }): Promise<SupervisorNotification> {
    return await this.notificationService.markDelivery(params);
  }

  async acknowledgeNotification(id: string, acknowledgedBy = "human"): Promise<SupervisorNotification> {
    return await this.notificationService.acknowledge(id, acknowledgedBy);
  }

  async acknowledgeOpenNotifications(acknowledgedBy = "human"): Promise<SupervisorNotification[]> {
    return await this.notificationService.acknowledgeOpen(acknowledgedBy);
  }

  async listWorkerInbox(params: { workerId?: string; includeAcknowledged?: boolean } = {}): Promise<WorkerInboxInstruction[]> {
    return await this.workerService.listInbox(params);
  }

  async acknowledgeWorkerInstruction(params: {
    instructionId: string;
    status: WorkerInstructionStatus;
    message?: string;
    workerId?: string;
  }): Promise<WorkerInstructionEvent> {
    return await this.workerService.acknowledgeInstruction(params);
  }

  async getOverview(): Promise<SupervisorOverview> {
    const snapshot = await this.latest();
    const [registry, instructions, notifications] = await Promise.all([
      this.readProjectRegistry(),
      this.listInstructions(),
      this.listNotifications("open")
    ]);
    const activeProject = registry.projects.find((project) => project.id === this.cfg.projectId)
      ?? projectEntryFromConfig(this.cfg, undefined, snapshot.scannedAt);
    return {
      activeProject,
      snapshot,
      registry,
      commands: Object.keys(this.cfg.allowedCommands),
      pendingInstructions: instructions.filter((instruction) => instruction.status === "pending"),
      recentInstructions: instructions.slice(-8).reverse(),
      nextActions: snapshot.nextActions,
      signals: snapshot.signals ?? [],
      notifications: notifications.slice(-10).reverse(),
      accounts: [],
      quotaWindows: [],
      quotaLogSources: [],
      quotaLogCursors: [],
      panelUrl: stripUrlToken(this.getPanelUrl())
    };
  }

  async createInstruction(params: {
    instruction: string;
    createdBy?: "human" | "supervisor";
    source?: "mobile" | "http" | "system";
    targetWorker?: string;
    approve?: boolean;
  }): Promise<SupervisorInstruction> {
    return await this.instructionService.create(params);
  }

  async approveLatestPendingInstruction(): Promise<SupervisorInstruction> {
    return await this.instructionService.approveLatest();
  }

  async approveInstruction(id: string): Promise<SupervisorInstruction> {
    return await this.instructionService.approve(id);
  }

  async rejectLatestPendingInstruction(reason?: string): Promise<SupervisorInstruction> {
    return await this.instructionService.rejectLatest(reason);
  }

  async rejectInstruction(id: string, reason?: string): Promise<SupervisorInstruction> {
    return await this.instructionService.reject(id, reason);
  }

  async dispatchInstruction(id: string): Promise<SupervisorInstruction> {
    return await this.instructionService.dispatch(id);
  }

  async runAllowedCommand(name: string): Promise<TaskRecord> {
    const spec = this.cfg.allowedCommands[name];
    if (!spec) throw new Error(`Command "${name}" is not allowed.`);
    const task: TaskRecord = {
      id: toId(`${name}:${Date.now()}:${Math.random()}`),
      name,
      command: spec.command,
      startedAt: nowIso(),
      status: "running",
      log: ""
    };
    this.runningTasks.set(task.id, task);
    void this.executeTask(task, spec.timeoutMs ?? this.cfg.commandTimeoutMs);
    return task;
  }

  private async audit(event: string, payload: unknown): Promise<void> {
    await appendJsonLine(this.cfg.auditFile, {
      event,
      at: nowIso(),
      payload
    });
  }

  private async executeTask(task: TaskRecord, timeoutMs: number): Promise<void> {
    const started = Date.now();
    const shell = shellFor(task.command);
    const child = spawn(shell.file, shell.args, { cwd: this.cfg.projectDir, windowsHide: true });
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      task.status = "timeout";
      task.log = clip(`${task.log}\n[project-supervisor] timed out after ${timeoutMs}ms\n`, this.cfg.maxTaskLogChars);
      child.kill();
    }, timeoutMs);

    const append = (chunk: unknown) => {
      task.log = clip(task.log + String(chunk), this.cfg.maxTaskLogChars);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      task.status = "failed";
      append(`\n[project-supervisor] ${error.message}\n`);
    });
    child.on("close", async (code) => {
      finished = true;
      clearTimeout(timer);
      if (task.status === "running") task.status = code === 0 ? "ok" : "failed";
      task.exitCode = code;
      task.finishedAt = nowIso();
      task.durationMs = Date.now() - started;
      this.runningTasks.delete(task.id);
      const state = await this.readState();
      state.tasks = [...state.tasks.filter((existing) => existing.id !== task.id), task].slice(-this.cfg.maxHistory);
      await this.writeState(state);
      await this.scan().catch((error) => this.logger.warn?.(`project-supervisor post-task scan failed: ${String(error)}`));
    });
  }

  async renderTextStatus(forceScan = false): Promise<string> {
    const snapshot = forceScan ? await this.scan() : await this.latest();
    const notifications = await this.listNotifications("open");
    const git = snapshot.git.available
      ? `branch ${snapshot.git.branch ?? "(unknown)"}, ${snapshot.git.changedFiles ?? 0} changed, ahead ${snapshot.git.aheadBy ?? 0}, behind ${snapshot.git.behindBy ?? 0}`
      : `git unavailable (${snapshot.git.error ?? "no details"})`;
    const tasks = snapshot.tasks.slice(-3).map((task) => `${task.name}:${task.status}`).join(", ") || "no tracked tasks";
    const pending = snapshot.instructions.filter((instruction) => instruction.status === "pending");
    const worker = `${snapshot.worker.workerId}:${snapshot.worker.status}${snapshot.worker.currentStep ? ` (${snapshot.worker.currentStep})` : ""}`;
    const risks = snapshot.risks.length > 0 ? snapshot.risks.map((risk) => `- ${risk}`).join("\n") : "- none";
    const signals = (snapshot.signals ?? []).length > 0
      ? (snapshot.signals ?? []).map((signal) => `- [${signal.severity}] ${signal.title}: ${signal.detail}${signal.command ? ` (${signal.command})` : ""}`).join("\n")
      : "- none";
    const nextActions = snapshot.nextActions.length > 0
      ? snapshot.nextActions.map((action) => `- [${action.priority}] ${action.title}: ${action.detail}${action.command ? ` (${action.command})` : ""}`).join("\n")
      : "- none";
    return [
      `Project Supervisor: ${snapshot.health.toUpperCase()}`,
      snapshot.summary,
      `Project: ${snapshot.projectDir}`,
      `Scanned: ${snapshot.scannedAt}`,
      `Git: ${git}`,
      `Worker: ${worker}`,
      `Pending instructions: ${pending.length}`,
      `Open alerts: ${notifications.length}`,
      `Recent files: ${snapshot.fileScan.recent.length}`,
      `Tasks: ${tasks}`,
      "Risks:",
      risks,
      "Signals:",
      signals,
      "Next actions:",
      nextActions,
      `Panel: ${this.getPanelUrl()}`
    ].join("\n");
  }

  async renderWorkerText(): Promise<string> {
    const worker = await this.getWorkerState();
    const plan = worker.plan.length > 0
      ? worker.plan.map((item) => `- ${item.status}: ${item.step}`).join("\n")
      : "- no plan reported";
    return [
      `Worker AI: ${worker.workerId}`,
      `Status: ${worker.status}`,
      `Source: ${worker.source}`,
      `Goal: ${worker.goal ?? "(not reported)"}`,
      `Current step: ${worker.currentStep ?? "(not reported)"}`,
      `Needs approval: ${worker.needsUserApproval ? "yes" : "no"}`,
      `Blocker: ${worker.blocker ?? "(none)"}`,
      `Last progress: ${worker.lastProgressAt ?? "(not reported)"}`,
      `Last activity: ${worker.lastActivityAt ?? "(not reported)"}`,
      "Plan:",
      plan,
      worker.error ? `Error: ${worker.error}` : null
    ].filter((line) => line !== null).join("\n");
  }

  async renderInstructionsText(status?: InstructionStatus): Promise<string> {
    const instructions = (await this.listInstructions(status)).slice(-8).reverse();
    if (instructions.length === 0) return status ? `No ${status} supervisor instructions.` : "No supervisor instructions.";
    return instructions.map((instruction) => [
      `${instruction.id} [${instruction.status}${instruction.workerStatus ? `/${instruction.workerStatus}` : ""}] -> ${instruction.targetWorker}`,
      instruction.instruction,
      instruction.workerMessage ? `worker: ${instruction.workerMessage}` : null,
      `created: ${instruction.createdAt}${instruction.dispatchedAt ? `, dispatched: ${instruction.dispatchedAt}` : ""}`
    ].filter((line) => line !== null).join("\n")).join("\n\n");
  }

  async renderProjectsText(): Promise<string> {
    const registry = await this.readProjectRegistry();
    if (registry.projects.length === 0) return "No projects registered yet. Use /supervise register to add the current project.";
    return [
      `Active project: ${registry.activeProjectId ?? "(none)"}`,
      ...registry.projects.map((project) => [
        `${project.id}${project.id === registry.activeProjectId ? " (active)" : ""}`,
        `  dir: ${project.projectDir}`,
        `  worker: ${project.workerStateFile ?? "(default)"}`,
        `  last seen: ${project.lastSeenAt ?? "(never)"}`
      ].join("\n"))
    ].join("\n");
  }

  getPanelUrl(): string {
    const token = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
    if (this.cfg.publicUrl) return `${this.cfg.publicUrl}${token}`;
    return `http://${this.cfg.host}:${this.cfg.port}/${token}`;
  }

  async startServer(): Promise<void> {
    if (this.server) return;
    const token = await this.ensureToken();
    this.server = createServer((req, res) => {
      this.handleHttp(req, res, token).catch((error) => {
        writeHttpError(res, error);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.cfg.port, this.cfg.host, () => resolve());
    });
    this.logger.info?.(`project-supervisor panel: ${redactUrlToken(this.getPanelUrl())}`);
  }

  async handleHttp(req: IncomingMessage, res: ServerResponse, token = this.token): Promise<boolean> {
    return await handleSupervisorHttp({
      kind: "project",
      supervisor: this,
      ensureToken: () => this.ensureToken()
    }, req, res, token);
  }

}

export class ProjectSupervisorHub {
  private readonly root: ProjectSupervisor;
  private readonly quotaService: CodexQuotaService;
  private readonly logger: Logger;
  private readonly supervisors = new Map<string, ProjectSupervisor>();
  private server: ReturnType<typeof createServer> | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private token = "";

  constructor(config: SupervisorConfig = {}, logger: Logger = {}) {
    this.root = new ProjectSupervisor(config, logger);
    this.quotaService = new CodexQuotaService(this.root.getConfig().accountRegistryFile, this.root.getConfig().maxNotifications);
    this.logger = logger;
  }

  getRootSupervisor(): ProjectSupervisor {
    return this.root;
  }

  getConfig(): NormalizedSupervisorConfig {
    return this.root.getConfig();
  }

  async ensureStarted(): Promise<void> {
    this.token = await this.root.ensureToken();
    if (this.root.getConfig().autoStartServer) await this.startServer();
    if (!this.scanTimer) {
      await this.scan();
      this.scanTimer = setInterval(() => {
        this.scan().catch((error) => this.logger.warn?.(`project-supervisor hub scan failed: ${String(error)}`));
      }, this.root.getConfig().scanIntervalMs);
    }
  }

  async stop(): Promise<void> {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await Promise.all([...this.supervisors.values()].map((supervisor) => supervisor.stop()));
    await this.root.stop();
  }

  getPanelUrl(): string {
    return this.root.getPanelUrl();
  }

  async readProjectRegistry(): Promise<ProjectRegistry> {
    return await this.root.readProjectRegistry();
  }

  async registerCurrentProject(): Promise<ProjectRegistryEntry> {
    this.supervisors.delete(this.root.getConfig().projectId);
    return await this.root.registerCurrentProject();
  }

  async registerProject(projectDir: string, projectId?: string): Promise<ProjectRegistryEntry> {
    const project = await this.root.registerProject(projectDir, projectId);
    this.supervisors.delete(project.id);
    return project;
  }

  async activateProject(id: string): Promise<ProjectRegistryEntry> {
    const projectId = id.trim();
    if (!projectId) throw new Error("Project id is required.");
    const registry = await this.readProjectRegistry();
    const project = registry.projects.find((entry) => entry.id === projectId);
    if (!project) throw new Error(`Project "${projectId}" is not registered.`);
    project.lastSeenAt = nowIso();
    registry.activeProjectId = project.id;
    await writeProjectRegistry(this.root.getConfig().projectRegistryFile, registry);
    await appendJsonLine(this.root.getConfig().auditFile, {
      event: "project_activated",
      at: nowIso(),
      payload: project
    });
    return project;
  }

  async getActiveProjectEntry(): Promise<ProjectRegistryEntry | undefined> {
    const registry = await this.readProjectRegistry();
    if (!registry.activeProjectId) return undefined;
    return registry.projects.find((project) => project.id === registry.activeProjectId);
  }

  async getActiveSupervisor(): Promise<ProjectSupervisor> {
    const entry = await this.getActiveProjectEntry();
    const rootCfg = this.root.getConfig();
    if (!entry) return this.root;
    if (entry.id === rootCfg.projectId && path.resolve(entry.projectDir) === rootCfg.projectDir) return this.root;
    const existing = this.supervisors.get(entry.id);
    if (existing) return existing;
    const token = this.token || await this.root.ensureToken();
    const supervisor = new ProjectSupervisor(configForRegistryEntry(rootCfg, entry, { token }), this.logger);
    this.supervisors.set(entry.id, supervisor);
    return supervisor;
  }

  async scan(): Promise<SupervisorSnapshot> {
    await this.scanQuotaLogs();
    await this.quotaService.reconcile();
    return await (await this.getActiveSupervisor()).scan();
  }

  async latest(): Promise<SupervisorSnapshot> {
    return await (await this.getActiveSupervisor()).latest();
  }

  async getWorkerState(): Promise<WorkerState> {
    return await (await this.getActiveSupervisor()).getWorkerState();
  }

  async updateWorkerHeartbeat(update: WorkerHeartbeatUpdate): Promise<WorkerState> {
    return await (await this.getActiveSupervisor()).updateWorkerHeartbeat(update);
  }

  async listInstructions(status?: InstructionStatus): Promise<SupervisorInstruction[]> {
    return await (await this.getActiveSupervisor()).listInstructions(status);
  }

  async listNotifications(status?: SupervisorNotificationStatus): Promise<SupervisorNotification[]> {
    const [projectNotifications, quotaNotifications] = await Promise.all([
      (await this.getActiveSupervisor()).listNotifications(status),
      this.quotaService.listNotifications(status)
    ]);
    return [...projectNotifications, ...quotaNotifications]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async listNotificationOutbox(): Promise<SupervisorNotification[]> {
    const [projectNotifications, quotaNotifications] = await Promise.all([
      (await this.getActiveSupervisor()).listNotificationOutbox(),
      this.quotaService.listNotificationOutbox()
    ]);
    return [...projectNotifications, ...quotaNotifications]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 20);
  }

  async markNotificationDelivery(params: {
    id: string;
    status: Extract<SupervisorNotificationDeliveryStatus, "delivered" | "failed">;
    error?: string;
  }): Promise<SupervisorNotification> {
    const quotaNotification = await this.quotaService.markNotificationDelivery(params.id, params.status, params.error);
    if (quotaNotification) return quotaNotification;
    return await (await this.getActiveSupervisor()).markNotificationDelivery(params);
  }

  async acknowledgeNotification(id: string, acknowledgedBy = "human"): Promise<SupervisorNotification> {
    const quotaNotification = await this.quotaService.acknowledgeNotification(id, acknowledgedBy);
    if (quotaNotification) return quotaNotification;
    return await (await this.getActiveSupervisor()).acknowledgeNotification(id, acknowledgedBy);
  }

  async acknowledgeOpenNotifications(acknowledgedBy = "human"): Promise<SupervisorNotification[]> {
    const [projectNotifications, quotaNotifications] = await Promise.all([
      (await this.getActiveSupervisor()).acknowledgeOpenNotifications(acknowledgedBy),
      this.quotaService.acknowledgeOpenNotifications(acknowledgedBy)
    ]);
    return [...projectNotifications, ...quotaNotifications];
  }

  async getQuotaRegistry(): Promise<QuotaRegistry> {
    await this.quotaService.reconcile();
    return await this.quotaService.read();
  }

  async registerAccount(input: RegisterAccountInput): Promise<CodexAccount> {
    return await this.quotaService.registerAccount(input);
  }

  async removeAccount(id: string): Promise<void> {
    await this.quotaService.removeAccount(id);
  }

  async setQuota(input: SetQuotaInput): Promise<QuotaWindow> {
    const window = await this.quotaService.setQuota(input);
    await this.quotaService.reconcile();
    return (await this.quotaService.read()).windows.find((entry) => entry.accountId === window.accountId && entry.id === window.id) ?? window;
  }

  async renderAccountsText(): Promise<string> {
    await this.quotaService.reconcile();
    return await this.quotaService.renderText();
  }

  async registerQuotaLogSource(input: RegisterQuotaLogSourceInput): Promise<QuotaLogSource> {
    return await this.quotaService.registerLogSource(input);
  }

  async removeQuotaLogSource(id: string): Promise<void> {
    await this.quotaService.removeLogSource(id);
  }

  async scanQuotaLogs(): Promise<Array<{
    sourceId: string;
    linesRead: number;
    candidates: number;
    matched: number;
    rotated: boolean;
    skippedBytes: number;
    error?: string;
  }>> {
    const registry = await this.quotaService.read();
    const cursorBySource = new Map(registry.logCursors.map((cursor) => [cursor.sourceId, cursor]));
    const sources = registry.logSources.filter((source) => source.enabled);
    const polls = await Promise.all(sources.map((source) => pollQuotaLogSource(source, cursorBySource.get(source.id))));
    const summaries: Array<{ sourceId: string; linesRead: number; candidates: number; matched: number; rotated: boolean; skippedBytes: number; error?: string }> = [];
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      const poll = polls[index];
      const candidates = poll.lines.filter(isQuotaSignalCandidate);
      let matched = 0;
      for (const line of candidates) {
        const result = await this.observeQuotaSignal({
          accountId: source.accountId,
          text: line,
          windowId: source.windowId,
          quotaType: source.quotaType
        });
        if (result.observation.matched) matched++;
      }
      await this.quotaService.updateLogCursor(poll.cursor);
      summaries.push({
        sourceId: source.id,
        linesRead: poll.lines.length,
        candidates: candidates.length,
        matched,
        rotated: poll.rotated,
        skippedBytes: poll.skippedBytes,
        error: poll.cursor.lastError
      });
    }
    return summaries;
  }

  async observeQuotaSignal(input: {
    accountId: string;
    text: string;
    observedAt?: string;
    windowId?: string;
    quotaType?: SetQuotaInput["quotaType"];
  }): Promise<{ observation: CodexQuotaObservation; window?: QuotaWindow }> {
    const accountId = input.accountId.trim();
    const observation = parseCodexQuotaSignal({
      text: input.text,
      observedAt: input.observedAt,
      windowId: input.windowId,
      quotaType: input.quotaType
    });
    await this.quotaService.recordObservation({
      accountId,
      windowId: observation.windowId,
      matched: observation.matched,
      status: observation.status,
      quotaType: observation.quotaType,
      resetAt: observation.resetAt,
      observedAt: observation.observedAt,
      evidenceHash: observation.evidenceHash,
      parserVersion: observation.parserVersion,
      reason: observation.reason
    });
    if (!observation.matched || !observation.status || !observation.windowId || !observation.quotaType) return { observation };
    const window = await this.setQuota({
      accountId,
      id: observation.windowId,
      label: observation.windowId,
      quotaType: observation.quotaType,
      status: observation.status,
      resetAt: observation.status === "available" ? null : observation.resetAt,
      observedAt: observation.observedAt,
      source: observation.source,
      confidence: observation.confidence
    });
    return { observation, window };
  }

  async listWorkerInbox(params: { workerId?: string; includeAcknowledged?: boolean } = {}): Promise<WorkerInboxInstruction[]> {
    return await (await this.getActiveSupervisor()).listWorkerInbox(params);
  }

  async acknowledgeWorkerInstruction(params: {
    instructionId: string;
    status: WorkerInstructionStatus;
    message?: string;
    workerId?: string;
  }): Promise<WorkerInstructionEvent> {
    return await (await this.getActiveSupervisor()).acknowledgeWorkerInstruction(params);
  }

  async getOverview(): Promise<SupervisorOverview> {
    const active = await this.getActiveSupervisor();
    const snapshot = await active.latest();
    await this.quotaService.reconcile();
    const [registry, instructions, notifications, quotaRegistry] = await Promise.all([
      this.readProjectRegistry(),
      active.listInstructions(),
      this.listNotifications("open"),
      this.getQuotaRegistry()
    ]);
    const activeProject = registry.projects.find((project) => project.id === active.getConfig().projectId)
      ?? projectEntryFromConfig(active.getConfig(), undefined, snapshot.scannedAt);
    return {
      activeProject,
      snapshot,
      registry,
      commands: Object.keys(active.getConfig().allowedCommands),
      pendingInstructions: instructions.filter((instruction) => instruction.status === "pending"),
      recentInstructions: instructions.slice(-8).reverse(),
      nextActions: snapshot.nextActions,
      signals: snapshot.signals ?? [],
      notifications: notifications.slice(-10).reverse(),
      accounts: quotaRegistry.accounts,
      quotaWindows: quotaRegistry.windows,
      quotaLogSources: quotaRegistry.logSources,
      quotaLogCursors: quotaRegistry.logCursors,
      panelUrl: stripUrlToken(this.getPanelUrl())
    };
  }

  async createInstruction(params: Parameters<ProjectSupervisor["createInstruction"]>[0]): Promise<SupervisorInstruction> {
    return await (await this.getActiveSupervisor()).createInstruction(params);
  }

  async approveLatestPendingInstruction(): Promise<SupervisorInstruction> {
    return await (await this.getActiveSupervisor()).approveLatestPendingInstruction();
  }

  async approveInstruction(id: string): Promise<SupervisorInstruction> {
    return await (await this.getActiveSupervisor()).approveInstruction(id);
  }

  async rejectLatestPendingInstruction(reason?: string): Promise<SupervisorInstruction> {
    return await (await this.getActiveSupervisor()).rejectLatestPendingInstruction(reason);
  }

  async rejectInstruction(id: string, reason?: string): Promise<SupervisorInstruction> {
    return await (await this.getActiveSupervisor()).rejectInstruction(id, reason);
  }

  async runAllowedCommand(name: string): Promise<TaskRecord> {
    return await (await this.getActiveSupervisor()).runAllowedCommand(name);
  }

  async renderTextStatus(forceScan = false): Promise<string> {
    return await (await this.getActiveSupervisor()).renderTextStatus(forceScan);
  }

  async renderWorkerText(): Promise<string> {
    return await (await this.getActiveSupervisor()).renderWorkerText();
  }

  async renderInstructionsText(status?: InstructionStatus): Promise<string> {
    return await (await this.getActiveSupervisor()).renderInstructionsText(status);
  }

  async renderProjectsText(): Promise<string> {
    return await this.root.renderProjectsText();
  }

  async startServer(): Promise<void> {
    if (this.server) return;
    const token = await this.root.ensureToken();
    this.token = token;
    this.server = createServer((req, res) => {
      this.handleHttp(req, res, token).catch((error) => {
        writeHttpError(res, error);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.root.getConfig().port, this.root.getConfig().host, () => resolve());
    });
    this.logger.info?.(`project-supervisor panel: ${redactUrlToken(this.getPanelUrl())}`);
  }

  async handleHttp(req: IncomingMessage, res: ServerResponse, token = this.token): Promise<boolean> {
    return await handleSupervisorHttp({
      kind: "hub",
      supervisor: this,
      ensureToken: () => this.root.ensureToken(),
      rememberToken: (value) => { this.token = value; }
    }, req, res, token);
  }

}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  import("./supervisor-cli.js")
    .then(({ startSupervisorCli }) => startSupervisorCli())
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
