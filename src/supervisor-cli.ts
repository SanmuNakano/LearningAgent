import { promises as fs } from "node:fs";
import path from "node:path";
import { quotaParsers } from "./quota.js";
import { CodexWorkerAdapter } from "./codex-worker-adapter.js";
import {
  ProjectSupervisorHub,
  type SupervisorConfig,
  type WorkerInstructionStatus,
  type WorkerStatus
} from "./supervisor.js";

function readArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function readBooleanArg(args: string[], name: string, inverseName?: string): boolean | undefined {
  if (inverseName && args.includes(inverseName)) return false;
  if (!args.includes(name)) return undefined;
  const raw = readArg(args, name);
  if (!raw) return true;
  return /^(1|true|yes|y)$/i.test(raw);
}

function readArgs(args: string[], name: string): string[] {
  return args.flatMap((value, index) => value === name && args[index + 1] && !args[index + 1].startsWith("--") ? [args[index + 1]] : []);
}

function parseWorkerStatus(value: unknown): WorkerStatus | undefined {
  return value === "unknown" || value === "working" || value === "waiting" || value === "idle" || value === "stuck" || value === "done"
    ? value
    : undefined;
}

function parseInstructionStatus(value: unknown): WorkerInstructionStatus | undefined {
  return value === "received" || value === "started" || value === "completed" || value === "failed" || value === "ignored"
    ? value
    : undefined;
}

export async function startSupervisorCli(args = process.argv.slice(2)): Promise<void> {
  const projectIndex = args.indexOf("--project");
  const portIndex = args.indexOf("--port");
  const workerIdIndex = args.indexOf("--worker-id");
  const baseConfig: SupervisorConfig = {
    projectDir: projectIndex >= 0 ? args[projectIndex + 1] : undefined,
    port: portIndex >= 0 ? Number(args[portIndex + 1]) : undefined,
    host: "0.0.0.0"
  };

  if (args.includes("--worker-codex")) {
    const supervisor = new ProjectSupervisorHub({ ...baseConfig, autoStartServer: false }, console);
    const sandboxArg = readArg(args, "--codex-sandbox");
    const sandbox = sandboxArg === "read-only" ? "read-only" : "workspace-write";
    const adapter = new CodexWorkerAdapter(supervisor, {
      projectDir: supervisor.getConfig().projectDir,
      workerId: workerIdIndex >= 0 ? args[workerIdIndex + 1] : undefined,
      model: readArg(args, "--codex-model"),
      profile: readArg(args, "--codex-profile"),
      configOverrides: readArgs(args, "--codex-config"),
      sandbox,
      pollIntervalMs: Number(readArg(args, "--poll-ms")) || undefined,
      timeoutMs: Number(readArg(args, "--timeout-ms")) || undefined,
      codexExecutable: readArg(args, "--codex-bin"),
      onError: (error) => console.error(`Codex worker adapter failed: ${error instanceof Error ? error.message : String(error)}`)
    });
    if (args.includes("--once")) {
      const instruction = await adapter.runOnce();
      console.log(JSON.stringify({ processedInstructionId: instruction?.id ?? null }, null, 2));
      return;
    }
    adapter.start();
    console.log(`Codex worker adapter started for ${supervisor.getConfig().projectDir}.`);
    await new Promise<void>((resolve) => {
      const stop = () => { adapter.stop(); resolve(); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }

  const heartbeatIndex = args.indexOf("--worker-heartbeat");
  if (heartbeatIndex >= 0) {
    const rawStatus = args[heartbeatIndex + 1] && !args[heartbeatIndex + 1].startsWith("--") ? args[heartbeatIndex + 1] : undefined;
    const status = rawStatus ? parseWorkerStatus(rawStatus) : undefined;
    if (rawStatus && !status) throw new Error("Usage: --worker-heartbeat [unknown|working|waiting|idle|stuck|done] [--goal <text>] [--step <text>] [--plan-json <json>] [--worker-id <id>]");
    const planJson = readArg(args, "--plan-json");
    const planFile = readArg(args, "--plan-file");
    const plan = planJson
      ? JSON.parse(planJson)
      : planFile
        ? JSON.parse(await fs.readFile(path.resolve(planFile), "utf-8"))
        : undefined;
    const supervisor = new ProjectSupervisorHub({ ...baseConfig, autoStartServer: false }, console);
    const worker = await supervisor.updateWorkerHeartbeat({
      workerId: workerIdIndex >= 0 ? args[workerIdIndex + 1] : undefined,
      status,
      goal: readArg(args, "--goal"),
      currentStep: readArg(args, "--step") ?? readArg(args, "--current-step"),
      plan,
      needsUserApproval: readBooleanArg(args, "--needs-approval", "--no-approval"),
      blocker: args.includes("--clear-blocker") ? null : readArg(args, "--blocker"),
      markProgress: args.includes("--progress")
    });
    console.log(JSON.stringify({ worker }, null, 2));
    return;
  }

  const quotaObserveIndex = args.indexOf("--quota-observe");
  if (quotaObserveIndex >= 0) {
    const accountId = args[quotaObserveIndex + 1] ?? "";
    const textFile = readArg(args, "--text-file");
    const text = textFile ? await fs.readFile(path.resolve(textFile), "utf-8") : readArg(args, "--text") ?? "";
    if (!accountId || !text) throw new Error("Usage: --quota-observe <account-id> (--text <message> | --text-file <path>) [--window-id <id>] [--quota-type <type>]");
    const rawQuotaType = readArg(args, "--quota-type");
    const supervisor = new ProjectSupervisorHub({ ...baseConfig, autoStartServer: false }, console);
    const result = await supervisor.observeQuotaSignal({
      accountId,
      text,
      observedAt: readArg(args, "--observed-at"),
      windowId: readArg(args, "--window-id"),
      quotaType: rawQuotaType ? quotaParsers.quotaType(rawQuotaType) : undefined
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.includes("--worker-inbox")) {
    const supervisor = new ProjectSupervisorHub({ ...baseConfig, autoStartServer: false }, console);
    const instructions = await supervisor.listWorkerInbox({
      workerId: workerIdIndex >= 0 ? args[workerIdIndex + 1] : undefined,
      includeAcknowledged: args.includes("--include-acknowledged")
    });
    console.log(JSON.stringify({ instructions }, null, 2));
    return;
  }

  if (args.includes("--notification-outbox")) {
    const supervisor = new ProjectSupervisorHub({ ...baseConfig, autoStartServer: false }, console);
    console.log(JSON.stringify({ notifications: await supervisor.listNotificationOutbox() }, null, 2));
    return;
  }

  const deliveryIndex = args.indexOf("--mark-notification-delivery");
  if (deliveryIndex >= 0) {
    const id = args[deliveryIndex + 1] ?? "";
    const rawStatus = args[deliveryIndex + 2];
    const status = rawStatus === "delivered" || rawStatus === "failed" ? rawStatus : undefined;
    if (!status) throw new Error("Usage: --mark-notification-delivery <notification-id-or-signal-id> <delivered|failed> [--error <text>]");
    const supervisor = new ProjectSupervisorHub({ ...baseConfig, autoStartServer: false }, console);
    const notification = await supervisor.markNotificationDelivery({ id, status, error: readArg(args, "--error") });
    console.log(JSON.stringify({ notification }, null, 2));
    return;
  }

  const ackIndex = args.indexOf("--worker-ack");
  if (ackIndex >= 0) {
    const instructionId = args[ackIndex + 1] ?? "";
    const status = parseInstructionStatus(args[ackIndex + 2]);
    if (!status) throw new Error("Usage: --worker-ack <instruction-id> <received|started|completed|failed|ignored> [--message <text>] [--worker-id <id>]");
    const messageIndex = args.indexOf("--message");
    const supervisor = new ProjectSupervisorHub({ ...baseConfig, autoStartServer: false }, console);
    const event = await supervisor.acknowledgeWorkerInstruction({
      instructionId,
      status,
      message: messageIndex >= 0 ? args.slice(messageIndex + 1).join(" ") : undefined,
      workerId: workerIdIndex >= 0 ? args[workerIdIndex + 1] : undefined
    });
    console.log(JSON.stringify({ event }, null, 2));
    return;
  }

  if (!args.includes("--serve")) return;
  const supervisor = new ProjectSupervisorHub({ ...baseConfig, host: "0.0.0.0" }, console);
  await supervisor.ensureStarted();
  console.log(`Project Supervisor panel: ${supervisor.getPanelUrl()}`);
}
