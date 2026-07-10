import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SupervisorState, WorkerControlState } from "./supervisor-types.js";

export interface SupervisorStateStorage {
  read(): Promise<SupervisorState>;
  write(state: SupervisorState): Promise<void>;
}

export function emptySupervisorState(): SupervisorState {
  return { snapshots: [], tasks: [], instructions: [], notifications: [], control: { mode: "active" } };
}

function normalizeControlState(value: unknown): WorkerControlState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { mode: "active" };
  const control = value as Record<string, unknown>;
  const mode = control.mode === "pause_requested" || control.mode === "paused" || control.mode === "resume_requested" ? control.mode : "active";
  return {
    mode,
    instructionId: typeof control.instructionId === "string" ? control.instructionId : undefined,
    requestedAt: typeof control.requestedAt === "string" ? control.requestedAt : undefined,
    changedAt: typeof control.changedAt === "string" ? control.changedAt : undefined,
    requestedBy: typeof control.requestedBy === "string" ? control.requestedBy : undefined
  };
}

export function normalizeSupervisorState(raw: unknown): SupervisorState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptySupervisorState();
  const value = raw as Record<string, unknown>;
  return {
    token: typeof value.token === "string" ? value.token : undefined,
    snapshots: Array.isArray(value.snapshots) ? value.snapshots as SupervisorState["snapshots"] : [],
    tasks: Array.isArray(value.tasks) ? value.tasks as SupervisorState["tasks"] : [],
    instructions: Array.isArray(value.instructions) ? value.instructions as SupervisorState["instructions"] : [],
    notifications: Array.isArray(value.notifications) ? value.notifications as SupervisorState["notifications"] : [],
    control: normalizeControlState(value.control)
  };
}

export class JsonSupervisorStateStorage implements SupervisorStateStorage {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async read(): Promise<SupervisorState> {
    try {
      return normalizeSupervisorState(JSON.parse(await fs.readFile(this.file, "utf-8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySupervisorState();
      if (error instanceof SyntaxError) return emptySupervisorState();
      throw error;
    }
  }

  async write(state: SupervisorState): Promise<void> {
    const snapshot = structuredClone(state);
    const operation = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tempFile = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        await fs.writeFile(tempFile, JSON.stringify(snapshot, null, 2), "utf-8");
        await fs.rename(tempFile, this.file);
      } catch (error) {
        await fs.rm(tempFile, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }
}
