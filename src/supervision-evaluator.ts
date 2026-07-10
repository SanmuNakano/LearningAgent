import { createHash } from "node:crypto";
import type {
  FileScanSummary, GitSummary, PortSummary, SupervisionSignal, SupervisorHealth,
  SupervisorInstruction, SupervisorNextAction, SupervisorNotification, TaskRecord, WorkerState
} from "./supervisor-types.js";

function nowIso(): string { return new Date().toISOString(); }
function toId(input: string): string { return createHash("sha256").update(input).digest("hex").slice(0, 16); }

export function buildRisks(params: {
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

export function buildWorkerRisks(worker: WorkerState, instructions: SupervisorInstruction[]): string[] {
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

export function buildSupervisionSignals(params: {
  git: GitSummary;
  tasks: TaskRecord[];
  worker: WorkerState;
  instructions: SupervisorInstruction[];
  staleAfterMs: number;
  nowMs?: number;
}): SupervisionSignal[] {
  const signals: SupervisionSignal[] = [];
  const nowMs = params.nowMs ?? Date.now();
  const pending = params.instructions.filter((instruction) => instruction.status === "pending");
  const failedInstructions = params.instructions.filter((instruction) => instruction.workerStatus === "failed");
  const runningTasks = params.tasks.filter((task) => task.status === "running");
  const finishedTasks = params.tasks.filter((task) => task.status !== "running");
  const latestFinished = finishedTasks.at(-1);

  if (params.worker.source === "missing") {
    signals.push({
      id: "worker-heartbeat-missing",
      severity: "watch",
      title: "Worker heartbeat missing",
      detail: "The worker AI has not reported heartbeat state for this project.",
      command: "/supervise ai"
    });
  }

  if (params.worker.source === "file" && (params.worker.status === "working" || params.worker.status === "idle")) {
    const progressAt = params.worker.lastProgressAt ?? params.worker.lastActivityAt ?? params.worker.updatedAt;
    const progressMs = progressAt ? Date.parse(progressAt) : 0;
    if (progressMs > 0 && nowMs - progressMs > params.staleAfterMs) {
      signals.push({
        id: "worker-no-progress",
        severity: nowMs - progressMs > params.staleAfterMs * 2 ? "critical" : "watch",
        title: "Worker progress is stale",
        detail: `No worker progress has been reported since ${progressAt}.`,
        command: "/supervise review"
      });
    }
  }

  if (latestFinished && (latestFinished.status === "failed" || latestFinished.status === "timeout")) {
    const previousSame = finishedTasks.slice(0, -1).reverse().find((task) => task.name === latestFinished.name);
    if (previousSame && (previousSame.status === "failed" || previousSame.status === "timeout")) {
      signals.push({
        id: "repeated-command-failure",
        severity: "critical",
        title: "Command is failing repeatedly",
        detail: `${latestFinished.name} failed or timed out in consecutive supervised runs.`,
        command: "/supervise review"
      });
    }
  }

  if (failedInstructions.length >= 2) {
    signals.push({
      id: "repeated-worker-instruction-failure",
      severity: "critical",
      title: "Worker instruction failures repeated",
      detail: `${failedInstructions.length} dispatched instruction(s) have failed in the worker AI.`,
      command: "/supervise pending"
    });
  }

  if (pending.length > 0) {
    signals.push({
      id: "pending-human-decision",
      severity: "watch",
      title: "Human decision pending",
      detail: `${pending.length} instruction(s) are waiting for approval or rejection.`,
      command: `/supervise approve ${pending[pending.length - 1].id}`
    });
  }

  if (params.worker.status === "done" && params.git.available && (params.git.changedFiles ?? 0) > 0) {
    signals.push({
      id: "worker-done-review-ready",
      severity: "watch",
      title: "Worker finished with local changes",
      detail: `${params.git.changedFiles} changed file(s) are ready for review.`,
      command: "/supervise run check"
    });
  } else if (params.git.available && (params.git.changedFiles ?? 0) > 0 && runningTasks.length === 0) {
    signals.push({
      id: "local-changes-ready",
      severity: "info",
      title: "Local changes need review",
      detail: `${params.git.changedFiles} changed file(s) are present with no supervised command running.`,
      command: "/supervise review"
    });
  }

  if (params.git.available && (params.git.aheadBy ?? 0) > 0) {
    signals.push({
      id: "git-ahead-unpushed",
      severity: "watch",
      title: "Local commits are not pushed",
      detail: `${params.git.aheadBy} commit(s) are ahead of ${params.git.upstream ?? "upstream"}.`,
      command: "/supervise review"
    });
  }

  if (params.git.available && (params.git.behindBy ?? 0) > 0) {
    signals.push({
      id: "git-behind-upstream",
      severity: "watch",
      title: "Branch is behind upstream",
      detail: `${params.git.behindBy} upstream commit(s) are not in the local branch.`,
      command: "/supervise review"
    });
  }

  return signals.slice(0, 10);
}

export function updateNotificationsFromSignals(params: {
  projectId: string;
  snapshotId: string;
  existing: SupervisorNotification[];
  signals: SupervisionSignal[];
  cooldownMs: number;
  maxNotifications: number;
  now?: string;
}): SupervisorNotification[] {
  const now = params.now ?? nowIso();
  const nowMs = Date.parse(now);
  const activeSignals = params.signals.filter((signal): signal is SupervisionSignal & { severity: "watch" | "critical" } => {
    return signal.severity === "watch" || signal.severity === "critical";
  });
  const activeKeys = new Set(activeSignals.map((signal) => `${params.projectId}:${signal.id}`));
  const out = params.existing.map((notification) => ({ ...notification }));
  const byKey = new Map<string, SupervisorNotification>();

  for (const notification of out) {
    byKey.set(`${notification.projectId}:${notification.signalId}`, notification);
  }

  for (const signal of activeSignals) {
    const key = `${params.projectId}:${signal.id}`;
    const existing = byKey.get(key);
    if (!existing) {
      out.push({
        id: toId(key),
        projectId: params.projectId,
        signalId: signal.id,
        severity: signal.severity,
        title: signal.title,
        detail: signal.detail,
        command: signal.command,
        status: "open",
        deliveryStatus: "pending",
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        occurrenceCount: 1,
        sourceSnapshotId: params.snapshotId
      });
      continue;
    }

    const contentChanged = existing.severity !== signal.severity
      || existing.title !== signal.title
      || existing.detail !== signal.detail
      || existing.command !== signal.command;
    const wasOpen = existing.status === "open";
    const cooldownExpired = nowMs - Date.parse(existing.updatedAt) >= params.cooldownMs;
    const shouldOpen = existing.status === "open" || cooldownExpired;
    existing.severity = signal.severity;
    existing.title = signal.title;
    existing.detail = signal.detail;
    existing.command = signal.command;
    existing.lastSeenAt = now;
    existing.sourceSnapshotId = params.snapshotId;
    existing.occurrenceCount = (existing.occurrenceCount || 0) + 1;
    if (shouldOpen) {
      existing.status = "open";
      if (!wasOpen || contentChanged) {
        existing.deliveryStatus = "pending";
        existing.deliveryError = undefined;
      }
      existing.updatedAt = now;
      existing.resolvedAt = undefined;
      if (cooldownExpired) {
        existing.acknowledgedAt = undefined;
        existing.acknowledgedBy = undefined;
      }
    }
  }

  for (const notification of out) {
    const key = `${notification.projectId}:${notification.signalId}`;
    if (notification.projectId === params.projectId && notification.status === "open" && !activeKeys.has(key)) {
      notification.status = "resolved";
      notification.deliveryStatus = notification.deliveryStatus ?? "pending";
      notification.resolvedAt = now;
      notification.updatedAt = now;
    }
  }

  return out
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-params.maxNotifications);
}

export function combineHealth(projectHealth: SupervisorHealth, worker: WorkerState, instructions: SupervisorInstruction[]): SupervisorHealth {
  if (projectHealth === "blocked" || worker.status === "stuck") return "blocked";
  if (worker.source === "invalid") return "blocked";
  if (instructions.some((instruction) => instruction.workerStatus === "failed")) return "blocked";
  if (projectHealth === "watch") return "watch";
  if (worker.source === "missing" || worker.status === "waiting" || worker.needsUserApproval) return "watch";
  if (instructions.some((instruction) => instruction.status === "pending")) return "watch";
  return "ok";
}

export function buildNextActions(params: {
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

