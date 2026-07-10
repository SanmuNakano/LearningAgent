import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { NormalizedSupervisorConfig } from "./supervisor-config.js";
import type {
  InstructionStatus,
  SupervisorInstruction,
  SupervisorNotification,
  SupervisorNotificationDeliveryStatus,
  SupervisorNotificationStatus,
  SupervisorState,
  WorkerHeartbeatUpdate,
  WorkerInboxInstruction,
  WorkerInstructionEvent,
  WorkerInstructionStatus,
  WorkerPlanItem,
  WorkerState,
  WorkerStateSource,
  WorkerStatus
} from "./supervisor-types.js";

type ServiceDependencies = {
  readState: () => Promise<SupervisorState>;
  writeState: (state: SupervisorState) => Promise<void>;
  audit: (event: string, payload: unknown) => Promise<void>;
};

function nowIso(): string { return new Date().toISOString(); }
function toId(input: string): string { return createHash("sha256").update(input).digest("hex").slice(0, 16); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }

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
    const output: unknown[] = [];
    for (const line of raw.split(/\r?\n/).filter(Boolean).slice(-maxLines)) {
      try { output.push(JSON.parse(line)); } catch { /* Ignore malformed protocol lines. */ }
    }
    return output;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function parseWorkerStatus(value: unknown): WorkerStatus {
  return value === "unknown" || value === "working" || value === "waiting" || value === "idle" || value === "stuck" || value === "done" ? value : "unknown";
}

function parseWorkerPlan(value: unknown): WorkerPlanItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): WorkerPlanItem[] => {
    if (!isRecord(item) || typeof item.step !== "string" || !item.step.trim()) return [];
    const status = item.status === "in_progress" || item.status === "completed" || item.status === "blocked" ? item.status : "pending";
    return [{ step: item.step.trim(), status }];
  }).slice(0, 20);
}

function parseInstructionEvent(raw: unknown): WorkerInstructionEvent | undefined {
  if (!isRecord(raw)) return undefined;
  const instructionId = optionalString(raw.instructionId) ?? optionalString(raw.id);
  const status = raw.status === "received" || raw.status === "started" || raw.status === "completed" || raw.status === "failed" || raw.status === "ignored" ? raw.status : undefined;
  if (!instructionId || !status) return undefined;
  return {
    instructionId,
    projectId: optionalString(raw.projectId),
    workerId: optionalString(raw.workerId),
    status,
    message: optionalString(raw.message),
    at: optionalString(raw.at) ?? optionalString(raw.updatedAt) ?? nowIso()
  };
}

export class WorkerService {
  constructor(private readonly cfg: NormalizedSupervisorConfig, private readonly dependencies: Pick<ServiceDependencies, "audit">) {}

  private fallback(source: WorkerStateSource, error?: string): WorkerState {
    return { projectId: this.cfg.projectId, workerId: this.cfg.defaultWorkerId, status: "unknown", source, plan: [], needsUserApproval: false, updatedAt: nowIso(), error };
  }

  async getState(): Promise<WorkerState> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.cfg.workerStateFile, "utf-8"));
      if (!isRecord(parsed)) return this.fallback("invalid", "worker state is not an object");
      const lastProgressAt = optionalString(parsed.lastProgressAt);
      const lastActivityAt = optionalString(parsed.lastActivityAt);
      return {
        projectId: optionalString(parsed.projectId) ?? this.cfg.projectId,
        workerId: optionalString(parsed.workerId) ?? this.cfg.defaultWorkerId,
        status: parseWorkerStatus(parsed.status),
        source: "file",
        goal: optionalString(parsed.goal),
        currentStep: optionalString(parsed.currentStep),
        plan: parseWorkerPlan(parsed.plan),
        lastProgressAt,
        lastActivityAt,
        needsUserApproval: parsed.needsUserApproval === true,
        blocker: parsed.blocker === null ? null : optionalString(parsed.blocker),
        updatedAt: optionalString(parsed.updatedAt) ?? lastActivityAt ?? lastProgressAt ?? nowIso()
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.fallback("missing");
      return this.fallback("invalid", error instanceof Error ? error.message : String(error));
    }
  }

  async updateHeartbeat(update: WorkerHeartbeatUpdate): Promise<WorkerState> {
    const existing = await this.getState();
    const now = nowIso();
    const plan = update.plan === undefined ? existing.plan : parseWorkerPlan(update.plan);
    const status = update.status ?? existing.status;
    const goal = update.goal !== undefined ? update.goal.trim() || undefined : existing.goal;
    const currentStep = update.currentStep !== undefined ? update.currentStep.trim() || undefined : existing.currentStep;
    const blocker = update.blocker !== undefined ? (typeof update.blocker === "string" ? update.blocker.trim() || null : update.blocker) : existing.blocker;
    const progressChanged = update.markProgress === true || status !== existing.status || goal !== existing.goal || currentStep !== existing.currentStep || update.plan !== undefined;
    const state = {
      projectId: this.cfg.projectId,
      workerId: update.workerId?.trim() || existing.workerId || this.cfg.defaultWorkerId,
      status, goal, currentStep, plan,
      lastProgressAt: update.lastProgressAt ?? (progressChanged ? now : existing.lastProgressAt),
      lastActivityAt: update.lastActivityAt ?? now,
      needsUserApproval: update.needsUserApproval ?? existing.needsUserApproval,
      blocker,
      updatedAt: now
    };
    await writeJsonFile(this.cfg.workerStateFile, state);
    await this.dependencies.audit("worker_heartbeat_updated", { workerId: state.workerId, status, goal, currentStep, needsUserApproval: state.needsUserApproval, blocker });
    return await this.getState();
  }

  async readOutbox(): Promise<WorkerInstructionEvent[]> {
    return (await readJsonLines(this.cfg.workerOutboxFile, 500)).flatMap((raw) => {
      const event = parseInstructionEvent(raw);
      return event ? [event] : [];
    });
  }

  applyEvents(instructions: SupervisorInstruction[], events: WorkerInstructionEvent[]): SupervisorInstruction[] {
    const latest = new Map<string, WorkerInstructionEvent>();
    for (const event of events) if (!latest.has(event.instructionId) || Date.parse(event.at) >= Date.parse(latest.get(event.instructionId)!.at)) latest.set(event.instructionId, event);
    return instructions.map((instruction) => {
      const event = latest.get(instruction.id);
      return event ? { ...instruction, workerStatus: event.status, workerMessage: event.message, workerUpdatedAt: event.at } : instruction;
    });
  }

  async listInbox(params: { workerId?: string; includeAcknowledged?: boolean } = {}): Promise<WorkerInboxInstruction[]> {
    const [rawInbox, events] = await Promise.all([readJsonLines(this.cfg.workerInboxFile, 500), this.readOutbox()]);
    const inbox = rawInbox.flatMap((raw): WorkerInboxInstruction[] => {
      if (!isRecord(raw)) return [];
      const id = optionalString(raw.id) ?? optionalString(raw.instructionId);
      const projectId = optionalString(raw.projectId);
      const targetWorker = optionalString(raw.targetWorker) ?? optionalString(raw.workerId);
      const instruction = optionalString(raw.instruction);
      const dispatchedAt = optionalString(raw.dispatchedAt);
      return id && projectId && targetWorker && instruction && dispatchedAt ? [{ id, projectId, targetWorker, instruction, createdAt: optionalString(raw.createdAt) ?? dispatchedAt, approvedAt: optionalString(raw.approvedAt), dispatchedAt }] : [];
    });
    const eventById = new Map<string, WorkerInstructionEvent>();
    for (const event of events) {
      const existing = eventById.get(event.instructionId);
      if (!existing || Date.parse(event.at) >= Date.parse(existing.at)) eventById.set(event.instructionId, event);
    }
    return inbox.map((instruction) => {
      const event = eventById.get(instruction.id);
      return event ? { ...instruction, workerStatus: event.status, workerMessage: event.message, workerUpdatedAt: event.at } : instruction;
    }).filter((instruction) => instruction.projectId === this.cfg.projectId)
      .filter((instruction) => !params.workerId?.trim() || instruction.targetWorker === params.workerId.trim())
      .filter((instruction) => params.includeAcknowledged || (instruction.workerStatus !== "completed" && instruction.workerStatus !== "failed" && instruction.workerStatus !== "ignored"));
  }

  async acknowledgeInstruction(params: { instructionId: string; status: WorkerInstructionStatus; message?: string; workerId?: string }): Promise<WorkerInstructionEvent> {
    const instructionId = params.instructionId.trim();
    if (!instructionId) throw new Error("Instruction id is required.");
    const instruction = (await this.listInbox({ includeAcknowledged: true })).find((entry) => entry.id === instructionId);
    if (!instruction) throw new Error(`Instruction "${instructionId}" was not found in the worker inbox.`);
    const event: WorkerInstructionEvent = { instructionId, projectId: instruction.projectId, workerId: params.workerId?.trim() || instruction.targetWorker || this.cfg.defaultWorkerId, status: params.status, message: params.message?.trim() || undefined, at: nowIso() };
    await appendJsonLine(this.cfg.workerOutboxFile, event);
    await this.dependencies.audit("worker_instruction_acknowledged", event);
    return event;
  }
}

export class InstructionService {
  constructor(private readonly cfg: NormalizedSupervisorConfig, private readonly dependencies: ServiceDependencies, private readonly worker: WorkerService) {}

  async list(status?: InstructionStatus): Promise<SupervisorInstruction[]> {
    const state = await this.dependencies.readState();
    const instructions = this.worker.applyEvents(state.instructions.slice(-this.cfg.maxInstructions), await this.worker.readOutbox());
    return status ? instructions.filter((instruction) => instruction.status === status) : instructions;
  }

  async create(params: { instruction: string; createdBy?: "human" | "supervisor"; source?: "mobile" | "http" | "system"; targetWorker?: string; approve?: boolean }): Promise<SupervisorInstruction> {
    const text = params.instruction.trim();
    if (!text) throw new Error("Instruction cannot be empty.");
    const createdAt = nowIso();
    const worker = params.targetWorker ? null : await this.worker.getState().catch(() => null);
    const instruction: SupervisorInstruction = {
      id: toId(`${this.cfg.projectId}:${createdAt}:${Math.random()}`), projectId: this.cfg.projectId,
      targetWorker: params.targetWorker?.trim() || (worker?.source === "file" ? worker.workerId : this.cfg.defaultWorkerId),
      createdBy: params.createdBy ?? "human", status: params.approve ? "approved" : "pending", instruction: text,
      source: params.source ?? "mobile", createdAt, approvedAt: params.approve ? createdAt : undefined
    };
    const state = await this.dependencies.readState();
    state.instructions = [...state.instructions, instruction].slice(-this.cfg.maxInstructions);
    await this.dependencies.writeState(state);
    await this.dependencies.audit("instruction_created", instruction);
    return params.approve ? await this.dispatch(instruction.id) : instruction;
  }

  async approveLatest(): Promise<SupervisorInstruction> { const latest = (await this.list("pending")).at(-1); if (!latest) throw new Error("No pending instruction to approve."); return await this.approve(latest.id); }
  async rejectLatest(reason?: string): Promise<SupervisorInstruction> { const latest = (await this.list("pending")).at(-1); if (!latest) throw new Error("No pending instruction to reject."); return await this.reject(latest.id, reason); }

  async approve(id: string): Promise<SupervisorInstruction> {
    const state = await this.dependencies.readState();
    const instruction = state.instructions.find((entry) => entry.id === id);
    if (!instruction) throw new Error(`Instruction "${id}" was not found.`);
    if (instruction.status === "rejected") throw new Error(`Instruction "${id}" was already rejected.`);
    if (instruction.status === "dispatched") return instruction;
    instruction.status = "approved"; instruction.approvedAt ??= nowIso();
    await this.dependencies.writeState(state); await this.dependencies.audit("instruction_approved", instruction);
    return await this.dispatch(id);
  }

  async reject(id: string, reason?: string): Promise<SupervisorInstruction> {
    const state = await this.dependencies.readState();
    const instruction = state.instructions.find((entry) => entry.id === id);
    if (!instruction) throw new Error(`Instruction "${id}" was not found.`);
    if (instruction.status === "dispatched") throw new Error(`Instruction "${id}" was already dispatched.`);
    instruction.status = "rejected"; instruction.rejectedAt = nowIso(); instruction.rejectReason = reason?.trim() || undefined;
    await this.dependencies.writeState(state); await this.dependencies.audit("instruction_rejected", instruction);
    return instruction;
  }

  async dispatch(id: string): Promise<SupervisorInstruction> {
    const state = await this.dependencies.readState();
    const instruction = state.instructions.find((entry) => entry.id === id);
    if (!instruction) throw new Error(`Instruction "${id}" was not found.`);
    if (instruction.status === "dispatched") return instruction;
    if (instruction.status !== "approved") throw new Error(`Instruction "${id}" is not approved.`);
    instruction.status = "dispatched"; instruction.dispatchedAt = nowIso();
    await appendJsonLine(this.cfg.workerInboxFile, { id: instruction.id, projectId: instruction.projectId, targetWorker: instruction.targetWorker, instruction: instruction.instruction, createdAt: instruction.createdAt, approvedAt: instruction.approvedAt, dispatchedAt: instruction.dispatchedAt });
    await this.dependencies.writeState(state); await this.dependencies.audit("instruction_dispatched", instruction);
    return instruction;
  }
}

export class NotificationService {
  constructor(private readonly projectId: string, private readonly dependencies: ServiceDependencies) {}

  async list(status?: SupervisorNotificationStatus): Promise<SupervisorNotification[]> {
    const notifications = (await this.dependencies.readState()).notifications.filter((entry) => entry.projectId === this.projectId);
    return status ? notifications.filter((entry) => entry.status === status) : notifications;
  }

  async listOutbox(): Promise<SupervisorNotification[]> {
    return (await this.list("open")).filter((entry) => (entry.deliveryStatus ?? "pending") !== "delivered").slice(-20).reverse();
  }

  async markDelivery(params: { id: string; status: Extract<SupervisorNotificationDeliveryStatus, "delivered" | "failed">; error?: string }): Promise<SupervisorNotification> {
    const id = params.id.trim(); if (!id) throw new Error("Notification id is required.");
    const state = await this.dependencies.readState();
    const notification = state.notifications.find((entry) => entry.id === id || entry.signalId === id);
    if (!notification) throw new Error(`Notification "${id}" was not found.`);
    if (notification.projectId !== this.projectId) throw new Error(`Notification "${id}" does not belong to this project.`);
    const now = nowIso(); notification.deliveryStatus = params.status; notification.lastDeliveryAt = now;
    notification.deliveryAttempts = (notification.deliveryAttempts ?? 0) + 1; notification.deliveryError = params.status === "failed" ? params.error?.trim() || "delivery failed" : undefined; notification.updatedAt = now;
    await this.dependencies.writeState(state); await this.dependencies.audit("notification_delivery_marked", { id: notification.id, signalId: notification.signalId, status: notification.deliveryStatus, error: notification.deliveryError });
    return notification;
  }

  async acknowledge(id: string, by = "human"): Promise<SupervisorNotification> {
    const state = await this.dependencies.readState(); const notification = state.notifications.find((entry) => entry.id === id || entry.signalId === id);
    if (!notification) throw new Error(`Notification "${id}" was not found.`);
    notification.status = "acknowledged"; notification.acknowledgedAt = nowIso(); notification.acknowledgedBy = by; notification.updatedAt = notification.acknowledgedAt;
    await this.dependencies.writeState(state); await this.dependencies.audit("notification_acknowledged", notification); return notification;
  }

  async acknowledgeOpen(by = "human"): Promise<SupervisorNotification[]> {
    const state = await this.dependencies.readState(); const now = nowIso();
    const notifications = state.notifications.filter((entry) => entry.projectId === this.projectId && entry.status === "open");
    for (const notification of notifications) { notification.status = "acknowledged"; notification.acknowledgedAt = now; notification.acknowledgedBy = by; notification.updatedAt = now; }
    await this.dependencies.writeState(state); await this.dependencies.audit("notifications_acknowledged", { count: notifications.length, acknowledgedBy: by, at: now }); return notifications;
  }
}
