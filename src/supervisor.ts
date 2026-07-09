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

export type SupervisorCommand = {
  title: string;
  command: string;
  timeoutMs?: number;
};

export type SupervisorConfig = {
  projectDir?: string;
  stateFile?: string;
  host?: string;
  port?: number;
  publicUrl?: string;
  token?: string;
  autoStartServer?: boolean;
  scanIntervalMs?: number;
  staleAfterMs?: number;
  maxFiles?: number;
  maxHistory?: number;
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
};

type SupervisorState = {
  token?: string;
  snapshots: SupervisorSnapshot[];
  tasks: TaskRecord[];
};

const DEFAULT_PROJECT_DIR = process.env.OPENCLAW_SUPERVISOR_PROJECT ?? "D:\\learn\\openclaw-plugins";
const DEFAULT_PORT = 8791;
const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_STALE_AFTER_MS = 4 * 60 * 60_000;
const DEFAULT_MAX_FILES = 8_000;
const DEFAULT_MAX_HISTORY = 100;
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
  return {
    projectDir,
    stateFile,
    host: input.host ?? "127.0.0.1",
    port: parsePositiveInt(input.port, DEFAULT_PORT),
    publicUrl: input.publicUrl ?? "",
    token: input.token ?? "",
    autoStartServer: input.autoStartServer !== false,
    scanIntervalMs: parsePositiveInt(input.scanIntervalMs, DEFAULT_SCAN_INTERVAL_MS),
    staleAfterMs: parsePositiveInt(input.staleAfterMs, DEFAULT_STALE_AFTER_MS),
    maxFiles: parsePositiveInt(input.maxFiles, DEFAULT_MAX_FILES),
    maxHistory: parsePositiveInt(input.maxHistory, DEFAULT_MAX_HISTORY),
    maxTaskLogChars: parsePositiveInt(input.maxTaskLogChars, DEFAULT_MAX_TASK_LOG_CHARS),
    commandTimeoutMs: parsePositiveInt(input.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS),
    watchedPorts: Array.isArray(input.watchedPorts) ? input.watchedPorts.filter((p) => Number.isInteger(p) && p > 0 && p < 65536) : [],
    logFiles: Array.isArray(input.logFiles) ? input.logFiles.filter((p) => typeof p === "string" && p.trim()).slice(0, 8) : [],
    ignoreDirs: Array.isArray(input.ignoreDirs) ? input.ignoreDirs.filter((p) => typeof p === "string" && p.trim()) : [],
    allowedCommands: normalizeAllowedCommands(input.allowedCommands)
  };
}

export class ProjectSupervisor {
  private readonly cfg: ReturnType<typeof normalizeSupervisorConfig>;
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
    return await readJsonFile<SupervisorState>(this.cfg.stateFile, { snapshots: [], tasks: [] });
  }

  async writeState(state: SupervisorState): Promise<void> {
    state.snapshots = state.snapshots.slice(-this.cfg.maxHistory);
    state.tasks = state.tasks.slice(-this.cfg.maxHistory);
    if (this.token) state.token = this.token;
    await writeJsonFile(this.cfg.stateFile, state);
  }

  async scan(): Promise<SupervisorSnapshot> {
    if (!await pathExists(this.cfg.projectDir)) {
      throw new Error(`Project directory does not exist: ${this.cfg.projectDir}`);
    }
    const state = await this.readState();
    const tasks = [...state.tasks, ...this.runningTasks.values()].slice(-this.cfg.maxHistory);
    const [fileScan, git, packageScripts, ports, logTails] = await Promise.all([
      scanFiles(this.cfg.projectDir, { maxFiles: this.cfg.maxFiles, ignoreDirs: this.cfg.ignoreDirs }),
      scanGit(this.cfg.projectDir),
      readPackageScripts(this.cfg.projectDir),
      Promise.all(this.cfg.watchedPorts.map((port) => checkPort(port))),
      readLogTails(this.cfg.projectDir, this.cfg.logFiles)
    ]);
    const risk = buildRisks({ git, fileScan, ports, tasks, staleAfterMs: this.cfg.staleAfterMs });
    const snapshot: SupervisorSnapshot = {
      id: toId(`${this.cfg.projectDir}:${Date.now()}:${Math.random()}`),
      projectDir: this.cfg.projectDir,
      scannedAt: nowIso(),
      health: risk.health,
      summary: risk.summary,
      risks: risk.risks,
      fileScan,
      git,
      packageScripts,
      ports,
      logTails,
      tasks
    };
    state.snapshots.push(snapshot);
    state.tasks = tasks.filter((task, index, list) => list.findIndex((other) => other.id === task.id) === index).slice(-this.cfg.maxHistory);
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
    const risks = snapshot.risks.length > 0 ? snapshot.risks.map((risk) => `- ${risk}`).join("\n") : "- none";
    return [
      `Project Supervisor: ${snapshot.health.toUpperCase()}`,
      snapshot.summary,
      `Project: ${snapshot.projectDir}`,
      `Scanned: ${snapshot.scannedAt}`,
      `Git: ${git}`,
      `Recent files: ${snapshot.fileScan.recent.length}`,
      `Tasks: ${tasks}`,
      "Risks:",
      risks,
      `Panel: ${this.getPanelUrl()}`
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
    if (req.method === "POST" && parsed.pathname === "/api/scan") {
      json(res, 200, { snapshot: await this.scan() });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/run") {
      const body = await readBodyJson(req);
      const command = isRecord(body) && typeof body.command === "string" ? body.command : "";
      json(res, 200, { task: await this.runAllowedCommand(command) });
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
    async function refresh(force) {
      const data = force ? await api("/api/scan", { method: "POST", body: "{}" }) : await api("/api/status");
      const s = data.snapshot;
      document.getElementById("sub").textContent = s.projectDir + " | " + s.scannedAt;
      const h = document.getElementById("health");
      h.textContent = s.health.toUpperCase();
      h.className = "value " + s.health;
      document.getElementById("changes").textContent = s.git.available ? s.git.changedFiles : "n/a";
      document.getElementById("recent").textContent = s.fileScan.recent.length;
      document.getElementById("tasks").textContent = s.tasks.length;
      document.getElementById("summary").textContent = s.summary + "\\nGit: " + (s.git.available ? s.git.status || "clean" : s.git.error);
      document.getElementById("risks").textContent = s.risks.length ? s.risks.map(r => "- " + r).join("\\n") : "- none";
      document.getElementById("files").innerHTML = rows(s.fileScan.recent, [x => x.path, x => x.modifiedAt, x => x.size + " B"]);
      document.getElementById("taskTable").innerHTML = rows(s.tasks.slice(-12).reverse(), [x => x.name, x => x.status, x => x.startedAt, x => (x.log || "").slice(-240)]);
      const select = document.getElementById("command");
      if (data.commands && select.children.length === 0) {
        for (const command of data.commands) {
          const opt = document.createElement("option");
          opt.value = command; opt.textContent = command; select.appendChild(opt);
        }
      }
    }
    async function runCommand() {
      const command = document.getElementById("command").value;
      await api("/api/run", { method: "POST", body: JSON.stringify({ command }) });
      await refresh(false);
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
    projectDir: typeof raw.projectDir === "string" ? raw.projectDir : undefined,
    stateFile: typeof raw.stateFile === "string" ? raw.stateFile : undefined,
    host: typeof raw.host === "string" ? raw.host : undefined,
    publicUrl: typeof raw.publicUrl === "string" ? raw.publicUrl : undefined,
    token: typeof raw.token === "string" ? raw.token : undefined,
    port: typeof raw.port === "number" || typeof raw.port === "string" ? Number(raw.port) : undefined,
    autoStartServer: typeof raw.autoStartServer === "boolean" ? raw.autoStartServer : undefined,
    scanIntervalMs: typeof raw.scanIntervalMs === "number" ? raw.scanIntervalMs : undefined,
    staleAfterMs: typeof raw.staleAfterMs === "number" ? raw.staleAfterMs : undefined,
    maxFiles: typeof raw.maxFiles === "number" ? raw.maxFiles : undefined,
    maxHistory: typeof raw.maxHistory === "number" ? raw.maxHistory : undefined,
    maxTaskLogChars: typeof raw.maxTaskLogChars === "number" ? raw.maxTaskLogChars : undefined,
    commandTimeoutMs: typeof raw.commandTimeoutMs === "number" ? raw.commandTimeoutMs : undefined,
    watchedPorts: Array.isArray(raw.watchedPorts) ? raw.watchedPorts as number[] : undefined,
    logFiles: Array.isArray(raw.logFiles) ? raw.logFiles as string[] : undefined,
    ignoreDirs: Array.isArray(raw.ignoreDirs) ? raw.ignoreDirs as string[] : undefined,
    allowedCommands
  };
}

let singleton: ProjectSupervisor | null = null;

export function getProjectSupervisorForTests(): ProjectSupervisor | null {
  return singleton;
}

export function registerProjectSupervisor(api: any): void {
  const supervisor = new ProjectSupervisor(configFromPluginApi(api), api.logger ?? {});
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
      if (/^(scan|refresh)$/i.test(args)) return { text: await supervisor.renderTextStatus(true) };
      if (/^(url|panel)$/i.test(args)) return { text: `Project Supervisor panel:\n${supervisor.getPanelUrl()}` };
      const runMatch = /^run\s+([a-zA-Z0-9_-]+)$/i.exec(args);
      if (runMatch) {
        const task = await supervisor.runAllowedCommand(runMatch[1]);
        return { text: `Started ${task.name} (${task.id}).\n${await supervisor.renderTextStatus(false)}` };
      }
      return {
        text: [
          "Project Supervisor commands:",
          "/supervise status",
          "/supervise scan",
          "/supervise url",
          "/supervise run build",
          "/supervise run test",
          `Allowed commands: ${Object.keys(supervisor.getConfig().allowedCommands).join(", ")}`
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
  const supervisor = new ProjectSupervisor({
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
