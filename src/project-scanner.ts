import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { FileScanSummary, GitSummary, PortSummary, SupervisorConfig } from "./supervisor-types.js";

const DEFAULT_IGNORES = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", ".next", ".nuxt",
  ".venv", "venv", "__pycache__", ".project-supervisor"
]);

function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function shellFor(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: "powershell.exe", args: ["-NoProfile", "-Command", command] };
  return { file: "/bin/sh", args: ["-lc", command] };
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
    child.stdout.on("data", (chunk) => { stdout = clip(stdout + String(chunk), 16_000); });
    child.stderr.on("data", (chunk) => { stderr = clip(stderr + String(chunk), 16_000); });
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

export async function scanFiles(projectDir: string, cfg: Required<Pick<SupervisorConfig, "maxFiles">> & { ignoreDirs: string[] }): Promise<FileScanSummary> {
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

export async function scanGit(projectDir: string): Promise<GitSummary> {
  const inside = await runCapture("git rev-parse --is-inside-work-tree", projectDir);
  if (!inside.ok) return { available: false, error: (inside.error ?? inside.stderr ?? "git unavailable").trim().slice(0, 180) };

  const [branch, status, lastCommit, upstream, divergence, diffStat] = await Promise.all([
    runCapture("git branch --show-current", projectDir),
    runCapture("git status --short", projectDir),
    runCapture("git log -1 --pretty=format:%h%x20%s", projectDir),
    runCapture("git rev-parse --abbrev-ref --symbolic-full-name @{u}", projectDir),
    runCapture("git rev-list --left-right --count @{u}...HEAD", projectDir),
    runCapture("git diff --stat HEAD", projectDir)
  ]);
  const { statusText, changes } = parseGitStatusOutput(status.stdout);
  const divergenceParts = divergence.ok ? divergence.stdout.trim().split(/\s+/).map((part) => Number(part)) : [];
  const behindBy = Number.isFinite(divergenceParts[0]) ? divergenceParts[0] : undefined;
  const aheadBy = Number.isFinite(divergenceParts[1]) ? divergenceParts[1] : undefined;
  return {
    available: true,
    branch: branch.stdout.trim() || undefined,
    upstream: upstream.ok ? upstream.stdout.trim() || undefined : undefined,
    status: statusText,
    changedFiles: changes.length,
    changes,
    aheadBy,
    behindBy,
    lastCommit: lastCommit.stdout.trim() || undefined,
    diffStat: diffStat.ok ? diffStat.stdout.trim() || undefined : undefined
  };
}

export function parseGitStatusOutput(output: string): { statusText: string; changes: NonNullable<GitSummary["changes"]> } {
  const statusText = output.trimEnd();
  const changes = statusText.split(/\r?\n/).filter(Boolean).map((line) => {
    const code = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    const renamedPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath;
    return { path: renamedPath.replace(/^"|"$/g, ""), status: code, staged: code[0] !== " " && code[0] !== "?", untracked: code === "??" };
  });
  return { statusText, changes };
}

export async function readPackageScripts(projectDir: string): Promise<string[]> {
  const pkg = await readJsonFile<Record<string, unknown>>(path.join(projectDir, "package.json"), {});
  if (!isRecord(pkg.scripts)) return [];
  return Object.keys(pkg.scripts).sort();
}

export async function checkPort(port: number): Promise<PortSummary> {
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

export async function readLogTails(projectDir: string, files: string[]): Promise<Array<{ path: string; text: string; error?: string }>> {
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
