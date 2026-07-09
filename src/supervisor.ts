import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type SupervisorHealth = "ok" | "watch" | "blocked";
export type TaskStatus = "running" | "ok" | "failed" | "timeout";
export type WorkerStatus = "unknown" | "working" | "waiting" | "idle" | "stuck" | "done";
export type WorkerStateSource = "file" | "missing" | "invalid";
export type InstructionStatus = "pending" | "approved" | "rejected" | "dispatched";
export type WorkerInstructionStatus = "received" | "started" | "completed" | "failed" | "ignored";

export type SupervisorCommand = {
  title: string;
  command: string;
  timeoutMs?: number;
};

export type SupervisorConfig = {
  projectId?: string;
  projectDir?: string;
  stateFile?: string;
  workerStateFile?: string;
  workerInboxFile?: string;
  workerOutboxFile?: string;
  auditFile?: string;
  projectRegistryFile?: string;
  defaultWorkerId?: string;
  host?: string;
  port?: number;
  publicUrl?: string;
  token?: string;
  autoStartServer?: boolean;
  scanIntervalMs?: number;
  staleAfterMs?: number;
  maxFiles?: number;
  maxHistory?: number;
  maxInstructions?: number;
  maxTaskLogChars?: number;
  commandTimeoutMs?: number;
  watchedPorts?: number[];
  logFiles?: string[];
  ignoreDirs?: string[];
  allowedCommands?: Record<string, string | SupervisorCommand>;
};

export type FileScanSummary = {
  totalFiles: number;
  skipped: number;
  newest: Array<{ path: string; modifiedAt: string; size: number }>;
  recent: Array<{ path: string; modifiedAt: string; size: number }>;
  byExtension: Record<string, number>;
};

export type GitSummary = {
  available: boolean;
  branch?: string;
  status?: string;
  changedFiles?: number;
  lastCommit?: string;
  error?: string;
};

export type PortSummary = {
  port: number;
  open: boolean;
};

export type TaskRecord = {
  id: string;
  name: string;
  command: string;
  startedAt: string;
  finishedAt?: string;
  status: TaskStatus;
  exitCode?: number | null;
  durationMs?: number;
  log: string;
};

export type WorkerPlanItem = {
  step: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
};

export type WorkerState = {
  projectId: string;
  workerId: string;
  status: WorkerStatus;
  source: WorkerStateSource;
  goal?: string;
  currentStep?: string;
  plan: WorkerPlanItem[];
  lastProgressAt?: string;
  lastActivityAt?: string;
  needsUserApproval: boolean;
  blocker?: string | null;
  updatedAt: string;
  error?: string;
};

export type SupervisorInstruction = {
  id: string;
  projectId: string;
  targetWorker: string;
  createdBy: "human" | "supervisor";
  status: InstructionStatus;
  instruction: string;
  source: "mobile" | "http" | "system";
  createdAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  dispatchedAt?: string;
  rejectReason?: string;
  workerStatus?: WorkerInstructionStatus;
  workerMessage?: string;
  workerUpdatedAt?: string;
};

export type WorkerInstructionEvent = {
  instructionId: string;
  projectId?: string;
  workerId?: string;
  status: WorkerInstructionStatus;
  message?: string;
  at: string;
};

export type ProjectRegistryEntry = {
  id: string;
  name?: string;
  projectDir: string;
  stateFile?: string;
  workerStateFile?: string;
  workerInboxFile?: string;
  workerOutboxFile?: string;
  auditFile?: string;
  addedAt: string;
  lastSeenAt?: string;
};

export type ProjectRegistry = {
  activeProjectId?: string;
  projects: ProjectRegistryEntry[];
};

export type SupervisorNextAction = {
  id: string;
  priority: "low" | "medium" | "high";
  title: string;
  detail: string;
  command?: string;
};

export type SupervisorSnapshot = {
  id: string;
  projectDir: string;
  scannedAt: string;
  health: SupervisorHealth;
  summary: string;
  risks: string[];
  fileScan: FileScanSummary;
  git: GitSummary;
  packageScripts: string[];
  ports: PortSummary[];
  logTails: Array<{ path: string; text: string; error?: string }>;
  tasks: TaskRecord[];
  worker: WorkerState;
  instructions: SupervisorInstruction[];
  nextActions: SupervisorNextAction[];
  projects: ProjectRegistry;
};

type SupervisorState = {
  token?: string;
  snapshots: SupervisorSnapshot[];
  tasks: TaskRecord[];
  instructions: SupervisorInstruction[];
};

const DEFAULT_PROJECT_DIR = process.env.OPENCLAW_SUPERVISOR_PROJECT ?? "D:\\learn\\openclaw-plugins";
const DEFAULT_PORT = 8791;
const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_STALE_AFTER_MS = 4 * 60 * 60_000;
const DEFAULT_MAX_FILES = 8_000;
const DEFAULT_MAX_HISTORY = 100;
const DEFAULT_MAX_INSTRUCTIONS = 200;
const DEFAULT_MAX_TASK_LOG_CHARS = 80_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000;

const DEFAULT_IGNORES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".project-supervisor"
]);

const DEFAULT_COMMANDS: Record<string, string> = {
  build: "npm run build",
  test: "npm test",
  check: "npm run check"
};

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

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return fallback;
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

async function readJsonLines(file: string, maxLines: number): Promise<unknown[]> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-maxLines);
    const out: unknown[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // Ignore malformed worker events; the heartbeat will surface broader invalid state.
      }
    }
    return out;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return [];
    throw error;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function runCapture(command: string, cwd: string, timeoutMs = 8_000): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null; error?: string }> {
  return await new Promise((resolve) => {
    const shell = shellFor(command);
    const child = spawn(shell.file, shell.args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      resolve({ ok: false, stdout, stderr, code: null, error: "timeout" });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = clip(stdout + String(chunk), 16_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = clip(stderr + String(chunk), 16_000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, code: null, error: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

function parseWorkerStatus(value: unknown): WorkerStatus {
  if (value === "working" || value === "waiting" || value === "idle" || value === "stuck" || value === "done") {
    return value;
  }
  return "unknown";
}

function parseWorkerPlan(value: unknown): WorkerPlanItem[] {
  if (!Array.isArray(value)) return [];
  const out: WorkerPlanItem[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.step !== "string" || !item.step.trim()) continue;
    const status = item.status === "in_progress" || item.status === "completed" || item.status === "blocked"
      ? item.status
      : "pending";
    out.push({ step: item.step.trim(), status });
  }
  return out.slice(0, 20);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return optionalString(value);
}

function parseWorkerInstructionStatus(value: unknown): WorkerInstructionStatus | null {
  if (value === "received" || value === "started" || value === "completed" || value === "failed" || value === "ignored") {
    return value;
  }
  return null;
}

function fallbackWorkerState(params: {
  projectId: string;
  workerId: string;
  source: WorkerStateSource;
  error?: string;
}): WorkerState {
  return {
    projectId: params.projectId,
    workerId: params.workerId,
    status: "unknown",
    source: params.source,
    plan: [],
    needsUserApproval: false,
    updatedAt: nowIso(),
    error: params.error
  };
}

async function readWorkerOutbox(file: string): Promise<WorkerInstructionEvent[]> {
  const rawEvents = await readJsonLines(file, 500);
  const events: WorkerInstructionEvent[] = [];
  for (const raw of rawEvents) {
    if (!isRecord(raw)) continue;
    const instructionId = optionalString(raw.instructionId) ?? optionalString(raw.id);
    const status = parseWorkerInstructionStatus(raw.status);
    if (!instructionId || !status) continue;
    events.push({
      instructionId,
      projectId: optionalString(raw.projectId),
      workerId: optionalString(raw.workerId),
      status,
      message: optionalString(raw.message),
      at: optionalString(raw.at) ?? optionalString(raw.updatedAt) ?? nowIso()
    });
  }
  return events;
}

function applyWorkerEventsToInstructions(instructions: SupervisorInstruction[], events: WorkerInstructionEvent[]): SupervisorInstruction[] {
  const latestByInstruction = new Map<string, WorkerInstructionEvent>();
  for (const event of events) {
    const existing = latestByInstruction.get(event.instructionId);
    if (!existing || Date.parse(event.at) >= Date.parse(existing.at)) {
      latestByInstruction.set(event.instructionId, event);
    }
  }
  return instructions.map((instruction) => {
    const event = latestByInstruction.get(instruction.id);
    if (!event) return instruction;
    return {
      ...instruction,
      workerStatus: event.status,
      workerMessage: event.message,
      workerUpdatedAt: event.at
    };
  });
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

async function readWorkerState(cfg: ReturnType<typeof normalizeSupervisorConfig>): Promise<WorkerState> {
  try {
    const raw = await fs.readFile(cfg.workerStateFile, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return fallbackWorkerState({ projectId: cfg.projectId, workerId: cfg.defaultWorkerId, source: "invalid", error: "worker state is not an object" });
    }
    const workerId = optionalString(parsed.workerId) ?? cfg.defaultWorkerId;
    const projectId = optionalString(parsed.projectId) ?? cfg.projectId;
    const lastProgressAt = optionalString(parsed.lastProgressAt);
    const lastActivityAt = optionalString(parsed.lastActivityAt);
    const updatedAt = optionalString(parsed.updatedAt) ?? lastActivityAt ?? lastProgressAt ?? nowIso();
    return {
      projectId,
      workerId,
      status: parseWorkerStatus(parsed.status),
      source: "file",
      goal: optionalString(parsed.goal),
      currentStep: optionalString(parsed.currentStep),
      plan: parseWorkerPlan(parsed.plan),
      lastProgressAt,
      lastActivityAt,
      needsUserApproval: parsed.needsUserApproval === true,
      blocker: optionalNullableString(parsed.blocker),
      updatedAt
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return fallbackWorkerState({ projectId: cfg.projectId, workerId: cfg.defaultWorkerId, source: "missing" });
    }
    return fallbackWorkerState({
      projectId: cfg.projectId,
      workerId: cfg.defaultWorkerId,
      source: "invalid",
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function normalizeState(raw: unknown): SupervisorState {
  if (!isRecord(raw)) return { snapshots: [], tasks: [], instructions: [] };
  return {
    token: typeof raw.token === "string" ? raw.token : undefined,
    snapshots: Array.isArray(raw.snapshots) ? raw.snapshots as SupervisorSnapshot[] : [],
    tasks: Array.isArray(raw.tasks) ? raw.tasks as TaskRecord[] : [],
    instructions: Array.isArray(raw.instructions) ? raw.instructions as SupervisorInstruction[] : []
  };
}

async function scanFiles(projectDir: string, cfg: Required<Pick<SupervisorConfig, "maxFiles">> & { ignoreDirs: string[] }): Promise<FileScanSummary> {
  const byExtension: Record<string, number> = {};
  const newest: Array<{ path: string; modifiedAt: string; size: number; mtime: number }> = [];
  const recent: Array<{ path: string; modifiedAt: string; size: number; mtime: number }> = [];
  const stack = [projectDir];
  const ignores = new Set([...DEFAULT_IGNORES, ...cfg.ignoreDirs]);
  const recentCutoff = Date.now() - 60 * 60_000;
  let totalFiles = 0;
  let skipped = 0;

  while (stack.length > 0 && totalFiles < cfg.maxFiles) {
    const current = stack.pop();
    if (!current) continue;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      skipped++;
      continue;
    }

    for (const entry of entries) {
      if (ignores.has(entry.name)) {
        skipped++;
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      totalFiles++;
      let stat: import("node:fs").Stats;
      try {
        stat = await fs.stat(full);
      } catch {
        skipped++;
        continue;
      }
      const rel = path.relative(projectDir, full);
      const ext = path.extname(entry.name).toLowerCase() || "(none)";
      byExtension[ext] = (byExtension[ext] ?? 0) + 1;
      const item = { path: rel, modifiedAt: stat.mtime.toISOString(), size: stat.size, mtime: stat.mtimeMs };
      newest.push(item);
      newest.sort((a, b) => b.mtime - a.mtime);
      if (newest.length > 12) newest.pop();
      if (stat.mtimeMs >= recentCutoff) {
        recent.push(item);
        recent.sort((a, b) => b.mtime - a.mtime);
        if (recent.length > 20) recent.pop();
      }
      if (totalFiles >= cfg.maxFiles) break;
    }
  }

  return {
    totalFiles,
    skipped,
    newest: newest.map(({ mtime, ...rest }) => rest),
    recent: recent.map(({ mtime, ...rest }) => rest),
    byExtension
  };
}

async function scanGit(projectDir: string): Promise<GitSummary> {
  const inside = await runCapture("git rev-parse --is-inside-work-tree", projectDir);
  if (!inside.ok) return { available: false, error: (inside.error ?? inside.stderr ?? "git unavailable").trim().slice(0, 180) };

  const [branch, status, lastCommit] = await Promise.all([
    runCapture("git branch --show-current", projectDir),
    runCapture("git status --short", projectDir),
    runCapture("git log -1 --pretty=format:%h%x20%s", projectDir)
  ]);
  const statusText = status.stdout.trim();
  return {
    available: true,
    branch: branch.stdout.trim() || undefined,
    status: statusText,
    changedFiles: statusText ? statusText.split(/\r?\n/).filter(Boolean).length : 0,
    lastCommit: lastCommit.stdout.trim() || undefined
  };
}

async function readPackageScripts(projectDir: string): Promise<string[]> {
  const pkg = await readJsonFile<Record<string, unknown>>(path.join(projectDir, "package.json"), {});
  if (!isRecord(pkg.scripts)) return [];
  return Object.keys(pkg.scripts).sort();
}

async function checkPort(port: number): Promise<PortSummary> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port, timeout: 600 });
    let done = false;
    const finish = (open: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ port, open });
    };
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
  });
}

async function readLogTails(projectDir: string, files: string[]): Promise<Array<{ path: string; text: string; error?: string }>> {
  const result: Array<{ path: string; text: string; error?: string }> = [];
  for (const entry of files.slice(0, 8)) {
    const file = path.isAbsolute(entry) ? entry : path.join(projectDir, entry);
    try {
      const raw = await fs.readFile(file, "utf-8");
      result.push({ path: entry, text: clip(raw, 8_000) });
    } catch (error) {
      result.push({ path: entry, text: "", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

function buildRisks(params: {
  git: GitSummary;
  fileScan: FileScanSummary;
  ports: PortSummary[];
  tasks: TaskRecord[];
  staleAfterMs: number;
}): { health: SupervisorHealth; risks: string[]; summary: string } {
  const risks: string[] = [];
  const failed = params.tasks.filter((task) => task.status === "failed" || task.status === "timeout");
  const running = params.tasks.filter((task) => task.status === "running");
  const lastActivity = params.fileScan.newest[0] ? Date.parse(params.fileScan.newest[0].modifiedAt) : 0;
  const stale = lastActivity > 0 && Date.now() - lastActivity > params.staleAfterMs;
  const closedPorts = params.ports.filter((port) => !port.open);

  if (failed.length > 0) risks.push(`${failed.length} command task(s) failed or timed out.`);
  if (running.length > 0) risks.push(`${running.length} command task(s) still running.`);
  if (params.git.available && (params.git.changedFiles ?? 0) > 20) risks.push(`${params.git.changedFiles} git file changes are pending review.`);
  if (params.git.available === false) risks.push("Git status is unavailable in this shell.");
  if (stale) risks.push("No file activity within the configured stale window.");
  if (closedPorts.length > 0) risks.push(`${closedPorts.length} watched port(s) are closed.`);

  const health: SupervisorHealth = failed.length > 0 || stale ? "blocked" : risks.length > 0 ? "watch" : "ok";
  const changed = params.git.available ? `${params.git.changedFiles ?? 0} git change(s)` : "git unavailable";
  const recent = params.fileScan.recent.length;
  const summary = `${health.toUpperCase()}: ${changed}, ${recent} recently touched file(s), ${running.length} running task(s), ${failed.length} failed task(s).`;
  return { health, risks, summary };
}

function buildWorkerRisks(worker: WorkerState, instructions: SupervisorInstruction[]): string[] {
  const risks: string[] = [];
  const pending = instructions.filter((instruction) => instruction.status === "pending");
  const failedInstructions = instructions.filter((instruction) => instruction.workerStatus === "failed");

  if (worker.source === "missing") risks.push("Worker AI heartbeat is not connected yet.");
  if (worker.source === "invalid") risks.push(`Worker AI heartbeat is invalid${worker.error ? `: ${worker.error}` : "."}`);
  if (worker.status === "stuck") risks.push("Worker AI reports it is stuck.");
  if (worker.status === "waiting" || worker.needsUserApproval) risks.push("Worker AI is waiting for user input or approval.");
  if (worker.blocker) risks.push(`Worker blocker: ${worker.blocker}`);
  if (pending.length > 0) risks.push(`${pending.length} supervisor instruction(s) pending approval.`);
  if (failedInstructions.length > 0) risks.push(`${failedInstructions.length} dispatched instruction(s) failed in the worker AI.`);

  return risks;
}

function combineHealth(projectHealth: SupervisorHealth, worker: WorkerState, instructions: SupervisorInstruction[]): SupervisorHealth {
  if (projectHealth === "blocked" || worker.status === "stuck") return "blocked";
  if (worker.source === "invalid") return "blocked";
  if (instructions.some((instruction) => instruction.workerStatus === "failed")) return "blocked";
  if (projectHealth === "watch") return "watch";
  if (worker.source === "missing" || worker.status === "waiting" || worker.needsUserApproval) return "watch";
  if (instructions.some((instruction) => instruction.status === "pending")) return "watch";
  return "ok";
}

function buildNextActions(params: {
  projectHealth: SupervisorHealth;
  git: GitSummary;
  tasks: TaskRecord[];
  worker: WorkerState;
  instructions: SupervisorInstruction[];
}): SupervisorNextAction[] {
  const actions: SupervisorNextAction[] = [];
  const failed = params.tasks.filter((task) => task.status === "failed" || task.status === "timeout");
  const running = params.tasks.filter((task) => task.status === "running");
  const pending = params.instructions.filter((instruction) => instruction.status === "pending");
  const failedInstructions = params.instructions.filter((instruction) => instruction.workerStatus === "failed");

  if (failed.length > 0) {
    actions.push({
      id: "inspect-failed-task",
      priority: "high",
      title: "Inspect failed supervised task",
      detail: `${failed.length} command task(s) failed or timed out. Review the latest task log before continuing.`,
      command: "/supervise status"
    });
  }

  if (failedInstructions.length > 0) {
    actions.push({
      id: "review-failed-instruction",
      priority: "high",
      title: "Review failed worker instruction",
      detail: failedInstructions[failedInstructions.length - 1].workerMessage ?? "The worker AI reported an instruction failure.",
      command: "/supervise pending"
    });
  }

  if (params.worker.status === "stuck") {
    actions.push({
      id: "unstick-worker",
      priority: "high",
      title: "Give the worker AI a focused next instruction",
      detail: params.worker.blocker ?? "The worker AI reports it is stuck and needs a narrower instruction.",
      command: "/supervise tell <instruction>"
    });
  }

  if (params.worker.status === "waiting" || params.worker.needsUserApproval) {
    actions.push({
      id: "respond-to-worker",
      priority: "high",
      title: "Respond to the worker AI",
      detail: params.worker.currentStep ?? params.worker.blocker ?? "The worker AI is waiting for user approval or input.",
      command: "/supervise tell <instruction>"
    });
  }

  if (pending.length > 0) {
    actions.push({
      id: "review-pending-instructions",
      priority: "medium",
      title: "Review pending supervisor instructions",
      detail: `${pending.length} instruction(s) are waiting for approval or rejection.`,
      command: `/supervise approve ${pending[0].id}`
    });
  }

  if (params.worker.source === "missing") {
    actions.push({
      id: "connect-worker-heartbeat",
      priority: "medium",
      title: "Connect worker AI heartbeat",
      detail: "Create or update .project-supervisor/worker-state.json so the supervisor can see what the worker AI is doing."
    });
  }

  if (params.git.available && (params.git.changedFiles ?? 0) > 0) {
    actions.push({
      id: "review-git-changes",
      priority: "medium",
      title: "Review local Git changes",
      detail: `${params.git.changedFiles} changed file(s) are present. Run checks before committing or pushing.`,
      command: "/supervise run test"
    });
  }

  if (running.length > 0) {
    actions.push({
      id: "wait-running-task",
      priority: "low",
      title: "Wait for running task",
      detail: `${running.length} supervised command task(s) are still running.`
    });
  }

  if (actions.length === 0 && params.projectHealth === "ok" && params.worker.status === "working") {
    actions.push({
      id: "continue-current-plan",
      priority: "low",
      title: "Let the worker continue",
      detail: params.worker.currentStep ?? "Project and worker state look healthy."
    });
  }

  if (actions.length === 0) {
    actions.push({
      id: "run-status-check",
      priority: "low",
      title: "Keep monitoring",
      detail: "No urgent action is required. Use /supervise scan after the next meaningful change."
    });
  }

  return actions.slice(0, 8);
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
    maxTaskLogChars: parsePositiveInt(input.maxTaskLogChars, DEFAULT_MAX_TASK_LOG_CHARS),
    commandTimeoutMs: parsePositiveInt(input.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS),
    watchedPorts: Array.isArray(input.watchedPorts) ? input.watchedPorts.filter((p) => Number.isInteger(p) && p > 0 && p < 65536) : [],
    logFiles: Array.isArray(input.logFiles) ? input.logFiles.filter((p) => typeof p === "string" && p.trim()).slice(0, 8) : [],
    ignoreDirs: Array.isArray(input.ignoreDirs) ? input.ignoreDirs.filter((p) => typeof p === "string" && p.trim()) : [],
    allowedCommands: normalizeAllowedCommands(input.allowedCommands)
  };
}

type NormalizedSupervisorConfig = ReturnType<typeof normalizeSupervisorConfig>;

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
    maxTaskLogChars: base.maxTaskLogChars,
    commandTimeoutMs: base.commandTimeoutMs,
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

  constructor(config: SupervisorConfig = {}, logger: Logger = {}) {
    this.cfg = normalizeSupervisorConfig(config);
    this.logger = logger;
    this.token = this.cfg.token;
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
      readWorkerOutbox(this.cfg.workerOutboxFile),
      this.readProjectRegistry()
    ]);
    const instructions = applyWorkerEventsToInstructions(state.instructions.slice(-this.cfg.maxInstructions), outboxEvents);
    const [fileScan, git, packageScripts, ports, logTails, worker] = await Promise.all([
      scanFiles(this.cfg.projectDir, { maxFiles: this.cfg.maxFiles, ignoreDirs: this.cfg.ignoreDirs }),
      scanGit(this.cfg.projectDir),
      readPackageScripts(this.cfg.projectDir),
      Promise.all(this.cfg.watchedPorts.map((port) => checkPort(port))),
      readLogTails(this.cfg.projectDir, this.cfg.logFiles),
      readWorkerState(this.cfg)
    ]);
    const projectRisk = buildRisks({ git, fileScan, ports, tasks, staleAfterMs: this.cfg.staleAfterMs });
    const workerRisks = buildWorkerRisks(worker, instructions);
    const health = combineHealth(projectRisk.health, worker, instructions);
    const risks = [...projectRisk.risks, ...workerRisks];
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
      projects: registry
    };
    state.snapshots.push(snapshot);
    state.tasks = tasks.filter((task, index, list) => list.findIndex((other) => other.id === task.id) === index).slice(-this.cfg.maxHistory);
    state.instructions = instructions;
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
    return await readWorkerState(this.cfg);
  }

  async listInstructions(status?: InstructionStatus): Promise<SupervisorInstruction[]> {
    const state = await this.readState();
    const events = await readWorkerOutbox(this.cfg.workerOutboxFile);
    const instructions = applyWorkerEventsToInstructions(state.instructions.slice(-this.cfg.maxInstructions), events);
    return status ? instructions.filter((instruction) => instruction.status === status) : instructions;
  }

  async createInstruction(params: {
    instruction: string;
    createdBy?: "human" | "supervisor";
    source?: "mobile" | "http" | "system";
    targetWorker?: string;
    approve?: boolean;
  }): Promise<SupervisorInstruction> {
    const text = params.instruction.trim();
    if (!text) throw new Error("Instruction cannot be empty.");
    const createdAt = nowIso();
    const worker = params.targetWorker ? null : await this.getWorkerState().catch(() => null);
    const instruction: SupervisorInstruction = {
      id: toId(`${this.cfg.projectId}:${createdAt}:${Math.random()}`),
      projectId: this.cfg.projectId,
      targetWorker: params.targetWorker?.trim() || (worker?.source === "file" ? worker.workerId : this.cfg.defaultWorkerId),
      createdBy: params.createdBy ?? "human",
      status: params.approve ? "approved" : "pending",
      instruction: text,
      source: params.source ?? "mobile",
      createdAt,
      approvedAt: params.approve ? createdAt : undefined
    };
    const state = await this.readState();
    state.instructions = [...state.instructions, instruction].slice(-this.cfg.maxInstructions);
    await this.writeState(state);
    await this.audit("instruction_created", instruction);
    if (params.approve) return await this.dispatchInstruction(instruction.id);
    return instruction;
  }

  async approveInstruction(id: string): Promise<SupervisorInstruction> {
    const state = await this.readState();
    const instruction = state.instructions.find((entry) => entry.id === id);
    if (!instruction) throw new Error(`Instruction "${id}" was not found.`);
    if (instruction.status === "rejected") throw new Error(`Instruction "${id}" was already rejected.`);
    if (instruction.status === "dispatched") return instruction;
    instruction.status = "approved";
    instruction.approvedAt = instruction.approvedAt ?? nowIso();
    await this.writeState(state);
    await this.audit("instruction_approved", instruction);
    return await this.dispatchInstruction(id);
  }

  async rejectInstruction(id: string, reason?: string): Promise<SupervisorInstruction> {
    const state = await this.readState();
    const instruction = state.instructions.find((entry) => entry.id === id);
    if (!instruction) throw new Error(`Instruction "${id}" was not found.`);
    if (instruction.status === "dispatched") throw new Error(`Instruction "${id}" was already dispatched.`);
    instruction.status = "rejected";
    instruction.rejectedAt = nowIso();
    instruction.rejectReason = reason?.trim() || undefined;
    await this.writeState(state);
    await this.audit("instruction_rejected", instruction);
    return instruction;
  }

  async dispatchInstruction(id: string): Promise<SupervisorInstruction> {
    const state = await this.readState();
    const instruction = state.instructions.find((entry) => entry.id === id);
    if (!instruction) throw new Error(`Instruction "${id}" was not found.`);
    if (instruction.status === "dispatched") return instruction;
    if (instruction.status !== "approved") throw new Error(`Instruction "${id}" is not approved.`);
    const dispatchedAt = nowIso();
    instruction.status = "dispatched";
    instruction.dispatchedAt = dispatchedAt;
    await appendJsonLine(this.cfg.workerInboxFile, {
      id: instruction.id,
      projectId: instruction.projectId,
      targetWorker: instruction.targetWorker,
      instruction: instruction.instruction,
      createdAt: instruction.createdAt,
      approvedAt: instruction.approvedAt,
      dispatchedAt
    });
    await this.writeState(state);
    await this.audit("instruction_dispatched", instruction);
    return instruction;
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
    const git = snapshot.git.available
      ? `branch ${snapshot.git.branch ?? "(unknown)"}, ${snapshot.git.changedFiles ?? 0} changed`
      : `git unavailable (${snapshot.git.error ?? "no details"})`;
    const tasks = snapshot.tasks.slice(-3).map((task) => `${task.name}:${task.status}`).join(", ") || "no tracked tasks";
    const pending = snapshot.instructions.filter((instruction) => instruction.status === "pending");
    const worker = `${snapshot.worker.workerId}:${snapshot.worker.status}${snapshot.worker.currentStep ? ` (${snapshot.worker.currentStep})` : ""}`;
    const risks = snapshot.risks.length > 0 ? snapshot.risks.map((risk) => `- ${risk}`).join("\n") : "- none";
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
      `Recent files: ${snapshot.fileScan.recent.length}`,
      `Tasks: ${tasks}`,
      "Risks:",
      risks,
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
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: String(error) }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.cfg.port, this.cfg.host, () => resolve());
    });
    this.logger.info?.(`project-supervisor panel: ${this.getPanelUrl()}`);
  }

  async handleHttp(req: IncomingMessage, res: ServerResponse, token = this.token): Promise<boolean> {
    const parsed = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (parsed.pathname.startsWith("/plugins/project-supervisor")) {
      parsed.pathname = parsed.pathname.replace(/^\/plugins\/project-supervisor/, "") || "/";
    }
    if (!this.isAuthorized(req, parsed, token)) {
      json(res, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method === "GET" && parsed.pathname === "/") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(renderDashboardHtml(token));
      return true;
    }
    if (req.method === "GET" && parsed.pathname === "/api/status") {
      json(res, 200, { snapshot: await this.latest(), commands: Object.keys(this.cfg.allowedCommands), panelUrl: this.getPanelUrl() });
      return true;
    }
    if (req.method === "GET" && parsed.pathname === "/api/worker") {
      json(res, 200, { worker: await this.getWorkerState() });
      return true;
    }
    if (req.method === "GET" && parsed.pathname === "/api/instructions") {
      const status = parsed.searchParams.get("status");
      const parsedStatus: InstructionStatus | undefined =
        status === "pending" || status === "approved" || status === "rejected" || status === "dispatched" ? status : undefined;
      json(res, 200, { instructions: await this.listInstructions(parsedStatus) });
      return true;
    }
    if (req.method === "GET" && parsed.pathname === "/api/projects") {
      json(res, 200, { registry: await this.readProjectRegistry() });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/scan") {
      json(res, 200, { snapshot: await this.scan() });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/register-project") {
      json(res, 200, { project: await this.registerCurrentProject(), registry: await this.readProjectRegistry() });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/run") {
      const body = await readBodyJson(req);
      const command = isRecord(body) && typeof body.command === "string" ? body.command : "";
      json(res, 200, { task: await this.runAllowedCommand(command) });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/propose") {
      const body = await readBodyJson(req);
      const instruction = isRecord(body) && typeof body.instruction === "string" ? body.instruction : "";
      json(res, 200, { instruction: await this.createInstruction({ instruction, createdBy: "supervisor", source: "http" }) });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/tell") {
      const body = await readBodyJson(req);
      const instruction = isRecord(body) && typeof body.instruction === "string" ? body.instruction : "";
      json(res, 200, { instruction: await this.createInstruction({ instruction, createdBy: "human", source: "http", approve: true }) });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/approve") {
      const body = await readBodyJson(req);
      const id = isRecord(body) && typeof body.id === "string" ? body.id : "";
      json(res, 200, { instruction: await this.approveInstruction(id) });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/reject") {
      const body = await readBodyJson(req);
      const id = isRecord(body) && typeof body.id === "string" ? body.id : "";
      const reason = isRecord(body) && typeof body.reason === "string" ? body.reason : undefined;
      json(res, 200, { instruction: await this.rejectInstruction(id, reason) });
      return true;
    }
    json(res, 404, { error: "not found" });
    return true;
  }

  private isAuthorized(req: IncomingMessage, parsed: URL, token: string): boolean {
    if (!token) return true;
    const queryToken = parsed.searchParams.get("token");
    if (queryToken === token) return true;
    const auth = req.headers.authorization;
    return auth === `Bearer ${token}`;
  }
}

export class ProjectSupervisorHub {
  private readonly root: ProjectSupervisor;
  private readonly logger: Logger;
  private readonly supervisors = new Map<string, ProjectSupervisor>();
  private server: ReturnType<typeof createServer> | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private token = "";

  constructor(config: SupervisorConfig = {}, logger: Logger = {}) {
    this.root = new ProjectSupervisor(config, logger);
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
    return await (await this.getActiveSupervisor()).scan();
  }

  async latest(): Promise<SupervisorSnapshot> {
    return await (await this.getActiveSupervisor()).latest();
  }

  async getWorkerState(): Promise<WorkerState> {
    return await (await this.getActiveSupervisor()).getWorkerState();
  }

  async listInstructions(status?: InstructionStatus): Promise<SupervisorInstruction[]> {
    return await (await this.getActiveSupervisor()).listInstructions(status);
  }

  async createInstruction(params: Parameters<ProjectSupervisor["createInstruction"]>[0]): Promise<SupervisorInstruction> {
    return await (await this.getActiveSupervisor()).createInstruction(params);
  }

  async approveInstruction(id: string): Promise<SupervisorInstruction> {
    return await (await this.getActiveSupervisor()).approveInstruction(id);
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
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: String(error) }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.root.getConfig().port, this.root.getConfig().host, () => resolve());
    });
    this.logger.info?.(`project-supervisor panel: ${this.getPanelUrl()}`);
  }

  async handleHttp(req: IncomingMessage, res: ServerResponse, token = this.token): Promise<boolean> {
    const parsed = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (parsed.pathname.startsWith("/plugins/project-supervisor")) {
      parsed.pathname = parsed.pathname.replace(/^\/plugins\/project-supervisor/, "") || "/";
    }
    if (!this.isAuthorized(req, parsed, token)) {
      json(res, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method === "GET" && parsed.pathname === "/") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(renderDashboardHtml(token));
      return true;
    }
    if (req.method === "GET" && parsed.pathname === "/api/status") {
      const active = await this.getActiveSupervisor();
      json(res, 200, {
        snapshot: await active.latest(),
        commands: Object.keys(active.getConfig().allowedCommands),
        panelUrl: this.getPanelUrl(),
        registry: await this.readProjectRegistry()
      });
      return true;
    }
    if (req.method === "GET" && parsed.pathname === "/api/worker") {
      json(res, 200, { worker: await this.getWorkerState() });
      return true;
    }
    if (req.method === "GET" && parsed.pathname === "/api/instructions") {
      const status = parsed.searchParams.get("status");
      const parsedStatus: InstructionStatus | undefined =
        status === "pending" || status === "approved" || status === "rejected" || status === "dispatched" ? status : undefined;
      json(res, 200, { instructions: await this.listInstructions(parsedStatus) });
      return true;
    }
    if (req.method === "GET" && parsed.pathname === "/api/projects") {
      json(res, 200, { registry: await this.readProjectRegistry() });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/scan") {
      json(res, 200, { snapshot: await this.scan(), registry: await this.readProjectRegistry() });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/register-project") {
      const body = await readBodyJson(req);
      const projectDir = isRecord(body) && typeof body.projectDir === "string" ? body.projectDir : "";
      const projectId = isRecord(body) && typeof body.projectId === "string" ? body.projectId : undefined;
      const project = projectDir ? await this.registerProject(projectDir, projectId) : await this.registerCurrentProject();
      json(res, 200, { project, registry: await this.readProjectRegistry() });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/activate-project") {
      const body = await readBodyJson(req);
      const id = isRecord(body) && typeof body.id === "string"
        ? body.id
        : isRecord(body) && typeof body.projectId === "string"
          ? body.projectId
          : "";
      const project = await this.activateProject(id);
      json(res, 200, { project, registry: await this.readProjectRegistry() });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/run") {
      const body = await readBodyJson(req);
      const command = isRecord(body) && typeof body.command === "string" ? body.command : "";
      json(res, 200, { task: await this.runAllowedCommand(command) });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/propose") {
      const body = await readBodyJson(req);
      const instruction = isRecord(body) && typeof body.instruction === "string" ? body.instruction : "";
      json(res, 200, { instruction: await this.createInstruction({ instruction, createdBy: "supervisor", source: "http" }) });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/tell") {
      const body = await readBodyJson(req);
      const instruction = isRecord(body) && typeof body.instruction === "string" ? body.instruction : "";
      json(res, 200, { instruction: await this.createInstruction({ instruction, createdBy: "human", source: "http", approve: true }) });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/approve") {
      const body = await readBodyJson(req);
      const id = isRecord(body) && typeof body.id === "string" ? body.id : "";
      json(res, 200, { instruction: await this.approveInstruction(id) });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/reject") {
      const body = await readBodyJson(req);
      const id = isRecord(body) && typeof body.id === "string" ? body.id : "";
      const reason = isRecord(body) && typeof body.reason === "string" ? body.reason : undefined;
      json(res, 200, { instruction: await this.rejectInstruction(id, reason) });
      return true;
    }
    json(res, 404, { error: "not found" });
    return true;
  }

  private isAuthorized(req: IncomingMessage, parsed: URL, token: string): boolean {
    if (!token) return true;
    const queryToken = parsed.searchParams.get("token");
    if (queryToken === token) return true;
    const auth = req.headers.authorization;
    return auth === `Bearer ${token}`;
  }
}

async function readBodyJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function json(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function renderDashboardHtml(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Project Supervisor</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, system-ui, -apple-system, Segoe UI, sans-serif; }
    body { margin: 0; background: #f7f4ed; color: #1f2933; }
    main { max-width: 1080px; margin: 0 auto; padding: 20px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
    h1 { font-size: 26px; margin: 0; letter-spacing: 0; }
    button, select { min-height: 38px; border-radius: 6px; border: 1px solid #9aa5b1; background: #ffffff; color: #1f2933; padding: 0 12px; font: inherit; }
    button { cursor: pointer; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .panel { border: 1px solid #d3cec4; border-radius: 8px; background: #fffdf8; padding: 14px; margin-bottom: 12px; }
    .metric { font-size: 12px; color: #52606d; }
    .value { font-size: 24px; font-weight: 700; margin-top: 4px; }
    .ok { color: #207227; } .watch { color: #9a5b00; } .blocked { color: #b42318; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; font-size: 13px; line-height: 1.45; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    td, th { text-align: left; border-bottom: 1px solid #e4ded4; padding: 8px 4px; vertical-align: top; }
    @media (max-width: 760px) { main { padding: 12px; } header { align-items: flex-start; flex-direction: column; } .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Project Supervisor</h1>
        <div id="sub" class="metric">Loading...</div>
      </div>
      <div class="toolbar">
        <button onclick="refresh(true)">Refresh</button>
        <select id="project"></select>
        <button onclick="activateProject()">Use</button>
        <select id="command"></select>
        <button onclick="runCommand()">Run</button>
      </div>
    </header>
    <section class="grid">
      <div class="panel"><div class="metric">Health</div><div id="health" class="value">-</div></div>
      <div class="panel"><div class="metric">Git Changes</div><div id="changes" class="value">-</div></div>
      <div class="panel"><div class="metric">Recent Files</div><div id="recent" class="value">-</div></div>
      <div class="panel"><div class="metric">Tasks</div><div id="tasks" class="value">-</div></div>
    </section>
    <section class="panel"><h2>Summary</h2><pre id="summary"></pre></section>
    <section class="panel"><h2>Risks</h2><pre id="risks"></pre></section>
    <section class="panel"><h2>Worker AI</h2><pre id="worker"></pre></section>
    <section class="panel"><h2>Next Actions</h2><pre id="nextActions"></pre></section>
    <section class="panel"><h2>Pending Instructions</h2><table id="instructions"></table></section>
    <section class="panel"><h2>Recent Files</h2><table id="files"></table></section>
    <section class="panel"><h2>Tasks</h2><table id="taskTable"></table></section>
  </main>
  <script>
    const token = new URLSearchParams(location.search).get("token") || ${JSON.stringify(token)};
    async function api(path, options = {}) {
      const url = path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
      const res = await fetch(url, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    }
    function rows(items, cols) {
      return "<tbody>" + items.map(item => "<tr>" + cols.map(col => "<td>" + String(col(item) ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])) + "</td>").join("") + "</tr>").join("") + "</tbody>";
    }
    function updateProjects(registry) {
      const select = document.getElementById("project");
      if (!registry || !Array.isArray(registry.projects)) {
        select.innerHTML = "";
        return;
      }
      const current = select.value || registry.activeProjectId || "";
      select.innerHTML = "";
      for (const project of registry.projects) {
        const opt = document.createElement("option");
        opt.value = project.id;
        opt.textContent = project.id + (project.id === registry.activeProjectId ? " *" : "");
        select.appendChild(opt);
      }
      select.value = registry.projects.some(p => p.id === current) ? current : (registry.activeProjectId || "");
    }
    async function refresh(force) {
      const data = force ? await api("/api/scan", { method: "POST", body: "{}" }) : await api("/api/status");
      const s = data.snapshot;
      updateProjects(data.registry || s.projects);
      document.getElementById("sub").textContent = s.projectDir + " | " + s.scannedAt;
      const h = document.getElementById("health");
      h.textContent = s.health.toUpperCase();
      h.className = "value " + s.health;
      document.getElementById("changes").textContent = s.git.available ? s.git.changedFiles : "n/a";
      document.getElementById("recent").textContent = s.fileScan.recent.length;
      document.getElementById("tasks").textContent = s.tasks.length;
      document.getElementById("summary").textContent = s.summary + "\\nGit: " + (s.git.available ? s.git.status || "clean" : s.git.error);
      document.getElementById("risks").textContent = s.risks.length ? s.risks.map(r => "- " + r).join("\\n") : "- none";
      document.getElementById("worker").textContent = [
        "Worker: " + s.worker.workerId,
        "Status: " + s.worker.status,
        "Source: " + s.worker.source,
        "Goal: " + (s.worker.goal || "(not reported)"),
        "Step: " + (s.worker.currentStep || "(not reported)"),
        "Needs approval: " + (s.worker.needsUserApproval ? "yes" : "no"),
        "Blocker: " + (s.worker.blocker || "(none)")
      ].join("\\n");
      document.getElementById("nextActions").textContent = s.nextActions.length ? s.nextActions.map(a => "- [" + a.priority + "] " + a.title + ": " + a.detail + (a.command ? " (" + a.command + ")" : "")).join("\\n") : "- none";
      document.getElementById("instructions").innerHTML = rows(s.instructions.filter(x => x.status === "pending").slice(-12).reverse(), [x => x.id, x => x.targetWorker, x => x.instruction, x => x.createdAt]);
      document.getElementById("files").innerHTML = rows(s.fileScan.recent, [x => x.path, x => x.modifiedAt, x => x.size + " B"]);
      document.getElementById("taskTable").innerHTML = rows(s.tasks.slice(-12).reverse(), [x => x.name, x => x.status, x => x.startedAt, x => (x.log || "").slice(-240)]);
      const select = document.getElementById("command");
      if (data.commands) {
        const current = select.value;
        select.innerHTML = "";
        for (const command of data.commands) {
          const opt = document.createElement("option");
          opt.value = command; opt.textContent = command; select.appendChild(opt);
        }
        if (data.commands.includes(current)) select.value = current;
      }
    }
    async function runCommand() {
      const command = document.getElementById("command").value;
      await api("/api/run", { method: "POST", body: JSON.stringify({ command }) });
      await refresh(false);
    }
    async function activateProject() {
      const id = document.getElementById("project").value;
      if (!id) return;
      await api("/api/activate-project", { method: "POST", body: JSON.stringify({ id }) });
      await refresh(true);
    }
    refresh(false).catch(err => document.getElementById("summary").textContent = err.message);
    setInterval(() => refresh(false).catch(() => {}), 5000);
  </script>
</body>
</html>`;
}

function configFromPluginApi(api: any): SupervisorConfig {
  const pluginConfig = isRecord(api?.pluginConfig)
    ? api.pluginConfig
    : isRecord(api?.config?.plugins?.entries?.["qq-study-router"]?.config)
      ? api.config.plugins.entries["qq-study-router"].config
      : isRecord(api?.config?.plugins?.["qq-study-router"])
        ? api.config.plugins["qq-study-router"]
        : {};
  const raw = isRecord(pluginConfig.projectSupervisor) ? pluginConfig.projectSupervisor : pluginConfig;
  const allowedCommands = isRecord(raw.allowedCommands) ? raw.allowedCommands as Record<string, string | SupervisorCommand> : undefined;
  return {
    projectId: typeof raw.projectId === "string" ? raw.projectId : undefined,
    projectDir: typeof raw.projectDir === "string" ? raw.projectDir : undefined,
    stateFile: typeof raw.stateFile === "string" ? raw.stateFile : undefined,
    workerStateFile: typeof raw.workerStateFile === "string" ? raw.workerStateFile : undefined,
    workerInboxFile: typeof raw.workerInboxFile === "string" ? raw.workerInboxFile : undefined,
    workerOutboxFile: typeof raw.workerOutboxFile === "string" ? raw.workerOutboxFile : undefined,
    auditFile: typeof raw.auditFile === "string" ? raw.auditFile : undefined,
    projectRegistryFile: typeof raw.projectRegistryFile === "string" ? raw.projectRegistryFile : undefined,
    defaultWorkerId: typeof raw.defaultWorkerId === "string" ? raw.defaultWorkerId : undefined,
    host: typeof raw.host === "string" ? raw.host : undefined,
    publicUrl: typeof raw.publicUrl === "string" ? raw.publicUrl : undefined,
    token: typeof raw.token === "string" ? raw.token : undefined,
    port: typeof raw.port === "number" || typeof raw.port === "string" ? Number(raw.port) : undefined,
    autoStartServer: typeof raw.autoStartServer === "boolean" ? raw.autoStartServer : undefined,
    scanIntervalMs: typeof raw.scanIntervalMs === "number" ? raw.scanIntervalMs : undefined,
    staleAfterMs: typeof raw.staleAfterMs === "number" ? raw.staleAfterMs : undefined,
    maxFiles: typeof raw.maxFiles === "number" ? raw.maxFiles : undefined,
    maxHistory: typeof raw.maxHistory === "number" ? raw.maxHistory : undefined,
    maxInstructions: typeof raw.maxInstructions === "number" ? raw.maxInstructions : undefined,
    maxTaskLogChars: typeof raw.maxTaskLogChars === "number" ? raw.maxTaskLogChars : undefined,
    commandTimeoutMs: typeof raw.commandTimeoutMs === "number" ? raw.commandTimeoutMs : undefined,
    watchedPorts: Array.isArray(raw.watchedPorts) ? raw.watchedPorts as number[] : undefined,
    logFiles: Array.isArray(raw.logFiles) ? raw.logFiles as string[] : undefined,
    ignoreDirs: Array.isArray(raw.ignoreDirs) ? raw.ignoreDirs as string[] : undefined,
    allowedCommands
  };
}

let singleton: ProjectSupervisorHub | null = null;

export function getProjectSupervisorForTests(): ProjectSupervisorHub | null {
  return singleton;
}

export function registerProjectSupervisor(api: any): void {
  const supervisor = new ProjectSupervisorHub(configFromPluginApi(api), api.logger ?? {});
  singleton = supervisor;

  api.registerService?.({
    id: "project-supervisor-service",
    start: async () => {
      await supervisor.ensureStarted();
    },
    stop: async () => {
      await supervisor.stop();
    }
  });

  api.lifecycle?.registerRuntimeLifecycle?.({
    id: "project-supervisor-cleanup",
    cleanup: async () => {
      await supervisor.stop();
    }
  });

  api.registerHttpRoute?.({
    path: "/plugins/project-supervisor",
    auth: "gateway",
    match: "prefix",
    replaceExisting: true,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      return await supervisor.handleHttp(req, res);
    }
  });

  api.registerCommand?.({
    name: "supervise",
    nativeNames: { default: "supervise" },
    description: "Show or control the local Project Supervisor.",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      await supervisor.ensureStarted();
      const args = String(ctx.args ?? "").trim();
      if (!args || /^status$/i.test(args)) return { text: await supervisor.renderTextStatus(false) };
      if (/^ai$/i.test(args)) return { text: await supervisor.renderWorkerText() };
      if (/^(pending|instructions)$/i.test(args)) return { text: await supervisor.renderInstructionsText() };
      if (/^projects$/i.test(args)) return { text: await supervisor.renderProjectsText() };
      const registerMatch = /^(register|register-project)(?:\s+([\s\S]+))?$/i.exec(args);
      if (registerMatch) {
        const projectDir = registerMatch[2]?.trim();
        const project = projectDir ? await supervisor.registerProject(projectDir) : await supervisor.registerCurrentProject();
        return { text: `Registered project ${project.id}:\n${project.projectDir}` };
      }
      const activateMatch = /^(activate|use)\s+([a-zA-Z0-9_-]+)$/i.exec(args);
      if (activateMatch) {
        const project = await supervisor.activateProject(activateMatch[2]);
        return { text: `Active project is now ${project.id}:\n${project.projectDir}` };
      }
      if (/^(scan|refresh)$/i.test(args)) return { text: await supervisor.renderTextStatus(true) };
      if (/^(url|panel)$/i.test(args)) return { text: `Project Supervisor panel:\n${supervisor.getPanelUrl()}` };
      const proposeMatch = /^propose(?:\s+([\s\S]+))?$/i.exec(args);
      if (proposeMatch) {
        const instructionText = proposeMatch[1]?.trim();
        if (!instructionText) {
          const snapshot = await supervisor.latest();
          return {
            text: [
              "Recommended next actions:",
              ...snapshot.nextActions.map((action) => `- [${action.priority}] ${action.title}: ${action.detail}${action.command ? ` (${action.command})` : ""}`)
            ].join("\n")
          };
        }
        const instruction = await supervisor.createInstruction({ instruction: instructionText, createdBy: "supervisor", source: "mobile" });
        return { text: `Created pending instruction ${instruction.id}.\nApprove with /supervise approve ${instruction.id}` };
      }
      const tellMatch = /^tell\s+([\s\S]+)$/i.exec(args);
      if (tellMatch) {
        const instruction = await supervisor.createInstruction({ instruction: tellMatch[1], createdBy: "human", source: "mobile", approve: true });
        return { text: `Dispatched instruction ${instruction.id} to ${instruction.targetWorker}.` };
      }
      const approveMatch = /^approve\s+([a-f0-9]{8,32})$/i.exec(args);
      if (approveMatch) {
        const instruction = await supervisor.approveInstruction(approveMatch[1]);
        return { text: `Approved and dispatched ${instruction.id} to ${instruction.targetWorker}.` };
      }
      const rejectMatch = /^reject\s+([a-f0-9]{8,32})(?:\s+([\s\S]+))?$/i.exec(args);
      if (rejectMatch) {
        const instruction = await supervisor.rejectInstruction(rejectMatch[1], rejectMatch[2]);
        return { text: `Rejected ${instruction.id}.` };
      }
      const runMatch = /^run\s+([a-zA-Z0-9_-]+)$/i.exec(args);
      if (runMatch) {
        const task = await supervisor.runAllowedCommand(runMatch[1]);
        return { text: `Started ${task.name} (${task.id}).\n${await supervisor.renderTextStatus(false)}` };
      }
      return {
        text: [
          "Project Supervisor commands:",
          "/supervise status",
          "/supervise ai",
          "/supervise projects",
          "/supervise register",
          "/supervise register <project-dir>",
          "/supervise activate <project-id>",
          "/supervise scan",
          "/supervise propose",
          "/supervise propose <instruction>",
          "/supervise approve <instruction-id>",
          "/supervise reject <instruction-id>",
          "/supervise tell <instruction>",
          "/supervise url",
          "/supervise run build",
          "/supervise run test",
          `Allowed commands: ${Object.keys((await supervisor.getActiveSupervisor()).getConfig().allowedCommands).join(", ")}`
        ].join("\n")
      };
    }
  });
}

async function startCli(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes("--serve")) return;
  const projectIndex = args.indexOf("--project");
  const portIndex = args.indexOf("--port");
  const supervisor = new ProjectSupervisorHub({
    projectDir: projectIndex >= 0 ? args[projectIndex + 1] : undefined,
    port: portIndex >= 0 ? Number(args[portIndex + 1]) : undefined,
    host: "0.0.0.0"
  }, console);
  await supervisor.ensureStarted();
  console.log(`Project Supervisor panel: ${supervisor.getPanelUrl()}`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  startCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
