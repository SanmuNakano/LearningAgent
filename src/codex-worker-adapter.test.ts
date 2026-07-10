import { describe, expect, it } from "vitest";
import { CodexWorkerAdapter, type CodexWorkerSource } from "./codex-worker-adapter.js";
import type { WorkerHeartbeatUpdate, WorkerInboxInstruction, WorkerInstructionEvent, WorkerState } from "./supervisor-types.js";

function instruction(overrides: Partial<WorkerInboxInstruction> = {}): WorkerInboxInstruction {
  return {
    id: "instruction-1",
    projectId: "project-a",
    targetWorker: "codex-main",
    instruction: "Run tests and summarize.",
    kind: "work",
    createdAt: "2026-07-10T10:00:00.000Z",
    dispatchedAt: "2026-07-10T10:00:01.000Z",
    ...overrides
  };
}

function sourceFor(item: WorkerInboxInstruction) {
  const acknowledgements: Array<{ status: string; message?: string }> = [];
  const heartbeats: WorkerHeartbeatUpdate[] = [];
  const source: CodexWorkerSource = {
    async listWorkerInbox() { return [item]; },
    async acknowledgeWorkerInstruction(params) {
      acknowledgements.push({ status: params.status, message: params.message });
      return { instructionId: params.instructionId, workerId: params.workerId, status: params.status, message: params.message, at: new Date().toISOString() } satisfies WorkerInstructionEvent;
    },
    async updateWorkerHeartbeat(update) {
      heartbeats.push(update);
      return { projectId: "project-a", workerId: "codex-main", status: update.status ?? "unknown", source: "file", plan: [], needsUserApproval: false, updatedAt: new Date().toISOString() } satisfies WorkerState;
    }
  };
  return { source, acknowledgements, heartbeats };
}

describe("Codex worker adapter", () => {
  it("executes one approved instruction and reports completion", async () => {
    const fixture = sourceFor(instruction());
    let runCalls = 0;
    let receivedProfile: string | undefined;
    const adapter = new CodexWorkerAdapter(fixture.source, {
      projectDir: "D:\\project-a",
      profile: "worker-mirror",
      configOverrides: ["model_provider=mirror"],
      runCodex: async (request) => { runCalls++; receivedProfile = request.profile; expect(request.configOverrides).toEqual(["model_provider=mirror"]); return { exitCode: 0, finalMessage: "Tests passed.", output: "", timedOut: false }; }
    });

    await adapter.runOnce();

    expect(runCalls).toBe(1);
    expect(receivedProfile).toBe("worker-mirror");
    expect(fixture.acknowledgements.map((entry) => entry.status)).toEqual(["received", "started", "completed"]);
    expect(fixture.heartbeats.map((entry) => entry.status)).toEqual(["working", "done"]);
    expect(fixture.heartbeats.at(-1)?.currentStep).toBe("Tests passed.");
  });

  it("completes pause instructions without launching Codex", async () => {
    const fixture = sourceFor(instruction({ kind: "pause", instruction: "Pause safely." }));
    const adapter = new CodexWorkerAdapter(fixture.source, {
      projectDir: "D:\\project-a",
      runCodex: async () => { throw new Error("runner must not be called"); }
    });

    await adapter.runOnce();

    expect(fixture.acknowledgements.map((entry) => entry.status)).toEqual(["received", "started", "completed"]);
    expect(fixture.heartbeats.at(-1)?.status).toBe("waiting");
  });

  it("refuses to replay an instruction left started after adapter restart", async () => {
    const fixture = sourceFor(instruction({ workerStatus: "started" }));
    let runCalls = 0;
    const adapter = new CodexWorkerAdapter(fixture.source, {
      projectDir: "D:\\project-a",
      runCodex: async () => { runCalls++; return { exitCode: 0, finalMessage: "", output: "", timedOut: false }; }
    });

    await adapter.runOnce();

    expect(runCalls).toBe(0);
    expect(fixture.acknowledgements[0].status).toBe("failed");
    expect(fixture.heartbeats.at(-1)?.status).toBe("stuck");
  });

  it("records a failed acknowledgement when the Codex process cannot start", async () => {
    const fixture = sourceFor(instruction());
    const adapter = new CodexWorkerAdapter(fixture.source, {
      projectDir: "D:\\project-a",
      runCodex: async () => { throw new Error("spawn failed"); }
    });

    await adapter.runOnce();

    expect(fixture.acknowledgements.map((entry) => entry.status)).toEqual(["received", "started", "failed"]);
    expect(fixture.acknowledgements.at(-1)?.message).not.toContain("spawn failed");
    expect(fixture.heartbeats.at(-1)?.status).toBe("stuck");
  });

  it("stores a sanitized error summary instead of the full failed Codex transcript", async () => {
    const fixture = sourceFor(instruction({ instruction: "private instruction text" }));
    const adapter = new CodexWorkerAdapter(fixture.source, {
      projectDir: "D:\\project-a",
      runCodex: async () => ({
        exitCode: 1,
        finalMessage: "private instruction text",
        output: "user private instruction textERROR: 401 Unauthorized at https://secret.example.test/path?token=hidden",
        timedOut: false
      })
    });

    await adapter.runOnce();

    expect(fixture.acknowledgements.at(-1)?.message).toContain("401 Unauthorized");
    expect(fixture.acknowledgements.at(-1)?.message).toContain("[url]");
    expect(fixture.acknowledgements.at(-1)?.message).not.toContain("private instruction text");
    expect(fixture.acknowledgements.at(-1)?.message).not.toContain("hidden");
  });
});
