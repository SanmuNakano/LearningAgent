import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  WorkerHeartbeatUpdate,
  WorkerInboxInstruction,
  WorkerInstructionEvent,
  WorkerInstructionStatus,
  WorkerState
} from "./supervisor-types.js";

export type CodexWorkerSource = {
  listWorkerInbox(params: { workerId: string; includeAcknowledged?: boolean }): Promise<WorkerInboxInstruction[]>;
  acknowledgeWorkerInstruction(params: { instructionId: string; status: WorkerInstructionStatus; message?: string; workerId?: string }): Promise<WorkerInstructionEvent>;
  updateWorkerHeartbeat(update: WorkerHeartbeatUpdate): Promise<WorkerState>;
};

export type CodexRunRequest = {
  instruction: WorkerInboxInstruction;
  projectDir: string;
  model?: string;
  profile?: string;
  configOverrides?: string[];
  sandbox: "read-only" | "workspace-write";
  timeoutMs: number;
};

export type CodexRunResult = {
  exitCode: number | null;
  finalMessage: string;
  output: string;
  timedOut: boolean;
};

export type CodexWorkerAdapterOptions = {
  projectDir: string;
  workerId?: string;
  model?: string;
  profile?: string;
  configOverrides?: string[];
  sandbox?: "read-only" | "workspace-write";
  pollIntervalMs?: number;
  timeoutMs?: number;
  idleHeartbeatIntervalMs?: number;
  codexExecutable?: string;
  runCodex?: (request: CodexRunRequest) => Promise<CodexRunResult>;
  onPoll?: (at: string) => void;
  onError?: (error: unknown) => void;
};

function clip(value: string, max = 2_000): string {
  const normalized = value.trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`;
}

async function resolveCodexLaunch(executable?: string): Promise<{ file: string; prefix: string[] }> {
  const requested = executable?.trim();
  if (requested?.toLowerCase().endsWith(".js")) return { file: process.execPath, prefix: [path.resolve(requested)] };
  if (process.platform === "win32" && (!requested || /(^|[\\/])codex(?:\.cmd)?$/i.test(requested))) {
    const appData = process.env.APPDATA;
    if (appData) {
      const codexJs = path.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
      try {
        await fs.access(codexJs);
        return { file: process.execPath, prefix: [codexJs] };
      } catch {}
    }
  }
  return { file: requested || "codex", prefix: [] };
}

function buildPrompt(instruction: WorkerInboxInstruction): string {
  return [
    "You are the project worker invoked by an approved Project Supervisor instruction.",
    "Work only inside the provided project directory. Follow repository instructions and verify your changes.",
    "Do not push, publish, or bypass safety controls unless the instruction explicitly requests it.",
    "Return a concise completion summary including verification and any blocker.",
    "",
    `Approved instruction (${instruction.id}):`,
    instruction.instruction
  ].join("\n");
}

function summarizeCodexFailure(result: CodexRunResult): string {
  const lines = result.output.split(/\r?\n/).map((line) => {
    const errorIndex = line.indexOf("ERROR");
    const match = errorIndex >= 0 ? { index: errorIndex } : /(?:\bfailed?\b|\bunauthorized\b|\bforbidden\b|\btimed?\s*out\b)/i.exec(line);
    return match ? line.slice(match.index).trim() : "";
  }).filter(Boolean);
  const summary = lines.slice(-3).join(" ")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/(bearer|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S+/gi, "$1=[redacted]");
  return clip(summary || `Codex exited with code ${result.exitCode}.`, 1_000);
}

export async function runCodexExec(request: CodexRunRequest, executable?: string): Promise<CodexRunResult> {
  const launch = await resolveCodexLaunch(executable);
  const outputFile = path.join(request.projectDir, ".project-supervisor", `codex-result-${request.instruction.id}.txt`);
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  const args = [
    ...launch.prefix,
    "exec",
    "--cd", request.projectDir,
    "--sandbox", request.sandbox,
    "--ephemeral",
    "--color", "never",
    "--output-last-message", outputFile,
    ...(request.model ? ["--model", request.model] : []),
    ...(request.profile ? ["--profile", request.profile] : []),
    ...(request.configOverrides ?? []).flatMap((override) => ["--config", override]),
    buildPrompt(request.instruction)
  ];
  return await new Promise<CodexRunResult>((resolve, reject) => {
    const child = spawn(launch.file, args, { cwd: request.projectDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const append = (chunk: unknown) => { output = clip(output + String(chunk), 20_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, request.timeoutMs);
    child.once("close", async (exitCode) => {
      clearTimeout(timer);
      let finalMessage = "";
      try { finalMessage = await fs.readFile(outputFile, "utf-8"); } catch {}
      await fs.rm(outputFile, { force: true }).catch(() => undefined);
      resolve({ exitCode, finalMessage: clip(finalMessage || output), output: clip(output, 20_000), timedOut });
    });
  });
}

export class CodexWorkerAdapter {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly sandbox: "read-only" | "workspace-write";
  private readonly runner: (request: CodexRunRequest) => Promise<CodexRunResult>;
  private readonly idleHeartbeatIntervalMs: number;
  private lastIdleHeartbeatAt = 0;

  constructor(private readonly source: CodexWorkerSource, private readonly options: CodexWorkerAdapterOptions) {
    this.workerId = options.workerId?.trim() || "codex-main";
    this.pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? 5_000);
    this.timeoutMs = Math.max(60_000, options.timeoutMs ?? 30 * 60_000);
    this.idleHeartbeatIntervalMs = Math.max(10_000, options.idleHeartbeatIntervalMs ?? 60_000);
    this.sandbox = options.sandbox ?? "workspace-write";
    this.runner = options.runCodex ?? ((request) => runCodexExec(request, options.codexExecutable));
  }

  start(): void {
    if (this.timer) return;
    const trigger = () => void this.runOnce().catch(this.options.onError ?? (() => undefined));
    trigger();
    this.timer = setInterval(trigger, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<WorkerInboxInstruction | undefined> {
    if (this.running) return undefined;
    this.running = true;
    this.options.onPoll?.(new Date().toISOString());
    try {
      const instruction = (await this.source.listWorkerInbox({ workerId: this.workerId }))[0];
      if (!instruction) {
        if (Date.now() - this.lastIdleHeartbeatAt >= this.idleHeartbeatIntervalMs) {
          await this.source.updateWorkerHeartbeat({ workerId: this.workerId, status: "waiting", currentStep: "Waiting for an approved supervisor instruction." });
          this.lastIdleHeartbeatAt = Date.now();
        }
        return undefined;
      }
      if (instruction.workerStatus === "received" || instruction.workerStatus === "started") {
        const message = "Adapter restarted after this instruction began; refusing automatic replay to prevent duplicate edits.";
        await this.acknowledge(instruction, "failed", message);
        await this.source.updateWorkerHeartbeat({ workerId: this.workerId, status: "stuck", currentStep: "Manual review required before retrying an interrupted instruction.", blocker: message, markProgress: true });
        return instruction;
      }
      await this.acknowledge(instruction, "received", "Codex worker adapter received the approved instruction.");
      await this.acknowledge(instruction, "started", instruction.kind === "pause" ? "Preparing a safe pause." : "Starting Codex execution.");
      if (instruction.kind === "pause") {
        await this.source.updateWorkerHeartbeat({ workerId: this.workerId, status: "waiting", currentStep: "Paused by Project Supervisor.", blocker: null, markProgress: true });
        await this.acknowledge(instruction, "completed", "Worker is paused and no Codex process is running.");
        return instruction;
      }
      await this.source.updateWorkerHeartbeat({ workerId: this.workerId, status: "working", goal: instruction.instruction, currentStep: "Executing approved instruction with Codex CLI.", blocker: null, markProgress: true });
      let result: CodexRunResult;
      try {
        result = await this.runner({ instruction, projectDir: this.options.projectDir, model: this.options.model, profile: this.options.profile, configOverrides: this.options.configOverrides, sandbox: this.sandbox, timeoutMs: this.timeoutMs });
      } catch (error) {
        this.options.onError?.(error);
        const message = `Codex process could not start (${error instanceof Error ? error.name : "unknown error"}).`;
        await this.acknowledge(instruction, "failed", message);
        await this.source.updateWorkerHeartbeat({ workerId: this.workerId, status: "stuck", currentStep: "Codex process failed to start.", blocker: message, markProgress: true });
        return instruction;
      }
      if (result.exitCode === 0 && !result.timedOut) {
        const message = clip(result.finalMessage || "Codex completed the instruction.");
        await this.acknowledge(instruction, "completed", message);
        await this.source.updateWorkerHeartbeat({ workerId: this.workerId, status: "done", currentStep: message, blocker: null, markProgress: true });
      } else {
        const message = result.timedOut ? `Codex execution timed out after ${this.timeoutMs}ms.` : summarizeCodexFailure(result);
        await this.acknowledge(instruction, "failed", message);
        await this.source.updateWorkerHeartbeat({ workerId: this.workerId, status: "stuck", currentStep: "Codex execution failed.", blocker: message, markProgress: true });
      }
      return instruction;
    } finally {
      this.running = false;
    }
  }

  private async acknowledge(instruction: WorkerInboxInstruction, status: WorkerInstructionStatus, message: string): Promise<void> {
    await this.source.acknowledgeWorkerInstruction({ instructionId: instruction.id, status, message, workerId: this.workerId });
  }
}
