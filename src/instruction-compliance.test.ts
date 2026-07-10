import { describe, expect, it } from "vitest";
import { buildSupervisionSignals } from "./supervision-evaluator.js";
import type { SupervisorInstruction, WorkerState } from "./supervisor-types.js";

const nowMs = Date.parse("2026-07-10T12:00:00.000Z");
const worker: WorkerState = {
  projectId: "project",
  workerId: "worker",
  status: "idle",
  source: "file",
  plan: [],
  needsUserApproval: false,
  updatedAt: "2026-07-10T12:00:00.000Z"
};

function instruction(overrides: Partial<SupervisorInstruction>): SupervisorInstruction {
  return {
    id: "instruction-1",
    projectId: "project",
    targetWorker: "worker",
    createdBy: "human",
    status: "dispatched",
    instruction: "Run checks.",
    source: "mobile",
    createdAt: "2026-07-10T10:00:00.000Z",
    dispatchedAt: "2026-07-10T10:00:00.000Z",
    ...overrides
  };
}

function signals(instructions: SupervisorInstruction[]) {
  return buildSupervisionSignals({
    git: { available: false },
    tasks: [],
    worker,
    instructions,
    staleAfterMs: 4 * 60 * 60_000,
    instructionAckTimeoutMs: 15 * 60_000,
    instructionProgressTimeoutMs: 2 * 60 * 60_000,
    nowMs
  });
}

describe("worker instruction compliance signals", () => {
  it("warns when a dispatched instruction is not acknowledged", () => {
    const result = signals([instruction({ dispatchedAt: "2026-07-10T11:30:00.000Z" })]);
    expect(result.find((entry) => entry.id === "worker-instruction-unacknowledged")?.severity).toBe("watch");
  });

  it("blocks when acknowledged instruction execution stops reporting progress", () => {
    const result = signals([instruction({ workerStatus: "started", workerUpdatedAt: "2026-07-10T09:00:00.000Z" })]);
    expect(result.find((entry) => entry.id === "worker-instruction-stalled")?.severity).toBe("critical");
  });

  it("distinguishes failed and ignored approved instructions", () => {
    const result = signals([
      instruction({ id: "failed", workerStatus: "failed" }),
      instruction({ id: "ignored", workerStatus: "ignored" })
    ]);
    expect(result.some((entry) => entry.id === "worker-instruction-failed" && entry.severity === "critical")).toBe(true);
    expect(result.some((entry) => entry.id === "worker-instruction-ignored" && entry.severity === "watch")).toBe(true);
  });
});
