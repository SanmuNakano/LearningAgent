import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ProjectSupervisor, normalizeSupervisorConfig } from "./supervisor.js";

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "project-supervisor-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({
    scripts: {
      build: "node -e \"console.log('build')\"",
      test: "node -e \"console.log('test')\""
    }
  }, null, 2), "utf-8");
  await writeFile(join(dir, "index.js"), "console.log('hello');\n", "utf-8");
  return dir;
}

async function waitForTask(supervisor: ProjectSupervisor, taskId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await supervisor.readState();
    const task = state.tasks.find((entry) => entry.id === taskId);
    if (task && task.status !== "running") return task;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("task did not finish");
}

async function removeProject(dir: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (i === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe("ProjectSupervisor", () => {
  it("normalizes defaults and named commands", () => {
    const cfg = normalizeSupervisorConfig({
      projectDir: "D:\\learn",
      allowedCommands: {
        smoke: "node -e \"console.log('ok')\"",
        "bad name": "echo nope"
      }
    });

    expect(cfg.port).toBe(8791);
    expect(Object.keys(cfg.allowedCommands)).toEqual(["smoke"]);
    expect(cfg.allowedCommands.smoke.command).toContain("node -e");
  });

  it("scans a project and writes state", async () => {
    const projectDir = await makeProject();
    try {
      const supervisor = new ProjectSupervisor({
        projectDir,
        stateFile: join(projectDir, ".project-supervisor", "state.json"),
        autoStartServer: false,
        maxFiles: 100
      });

      const snapshot = await supervisor.scan();
      const stateRaw = await readFile(join(projectDir, ".project-supervisor", "state.json"), "utf-8");

      expect(snapshot.projectDir).toBe(projectDir);
      expect(snapshot.fileScan.totalFiles).toBeGreaterThanOrEqual(2);
      expect(snapshot.packageScripts).toEqual(["build", "test"]);
      expect(JSON.parse(stateRaw).snapshots).toHaveLength(1);
    } finally {
      await removeProject(projectDir);
    }
  });

  it("runs only configured commands and records task output", async () => {
    const projectDir = await makeProject();
    try {
      const supervisor = new ProjectSupervisor({
        projectDir,
        stateFile: join(projectDir, ".project-supervisor", "state.json"),
        autoStartServer: false,
        allowedCommands: {
          smoke: "node -e \"console.log('supervised-ok')\""
        }
      });

      await expect(supervisor.runAllowedCommand("unknown")).rejects.toThrow(/not allowed/);
      const task = await supervisor.runAllowedCommand("smoke");
      const finished = await waitForTask(supervisor, task.id);

      expect(finished.status).toBe("ok");
      expect(finished.log).toContain("supervised-ok");
    } finally {
      await removeProject(projectDir);
    }
  });

  it("reads worker AI heartbeat state and recommends a response", async () => {
    const projectDir = await makeProject();
    try {
      const supervisorDir = join(projectDir, ".project-supervisor");
      await mkdir(supervisorDir, { recursive: true });
      await writeFile(join(supervisorDir, "worker-state.json"), JSON.stringify({
        projectId: "test-project",
        workerId: "codex-main",
        status: "waiting",
        goal: "Improve supervisor",
        currentStep: "Waiting for approval to run tests",
        plan: [
          { step: "Patch supervisor", status: "completed" },
          { step: "Run tests", status: "in_progress" }
        ],
        needsUserApproval: true,
        lastProgressAt: "2026-07-09T10:30:00.000Z"
      }, null, 2), "utf-8");

      const supervisor = new ProjectSupervisor({
        projectDir,
        stateFile: join(supervisorDir, "state.json"),
        autoStartServer: false,
        maxFiles: 100
      });

      const snapshot = await supervisor.scan();

      expect(snapshot.worker.workerId).toBe("codex-main");
      expect(snapshot.worker.status).toBe("waiting");
      expect(snapshot.worker.plan).toHaveLength(2);
      expect(snapshot.health).toBe("watch");
      expect(snapshot.risks).toContain("Worker AI is waiting for user input or approval.");
      expect(snapshot.nextActions.some((action) => action.id === "respond-to-worker")).toBe(true);
    } finally {
      await removeProject(projectDir);
    }
  });

  it("queues, approves, dispatches, and audits worker instructions", async () => {
    const projectDir = await makeProject();
    try {
      const supervisorDir = join(projectDir, ".project-supervisor");
      await mkdir(supervisorDir, { recursive: true });
      await writeFile(join(supervisorDir, "worker-state.json"), JSON.stringify({
        workerId: "codex-main",
        status: "working"
      }), "utf-8");
      const supervisor = new ProjectSupervisor({
        projectId: "test-project",
        projectDir,
        stateFile: join(supervisorDir, "state.json"),
        workerInboxFile: join(supervisorDir, "inbox.jsonl"),
        auditFile: join(supervisorDir, "audit.jsonl"),
        defaultWorkerId: "fallback-worker",
        autoStartServer: false
      });

      const pending = await supervisor.createInstruction({
        instruction: "Run tests and report the result.",
        createdBy: "supervisor",
        source: "mobile"
      });
      expect(pending.status).toBe("pending");
      expect(pending.targetWorker).toBe("codex-main");

      const dispatched = await supervisor.approveInstruction(pending.id);
      expect(dispatched.status).toBe("dispatched");
      expect(dispatched.dispatchedAt).toBeTruthy();

      const inbox = await readFile(join(supervisorDir, "inbox.jsonl"), "utf-8");
      const audit = await readFile(join(supervisorDir, "audit.jsonl"), "utf-8");
      const state = await supervisor.readState();

      expect(inbox).toContain("Run tests and report the result.");
      expect(audit).toContain("instruction_created");
      expect(audit).toContain("instruction_dispatched");
      expect(state.instructions[0].status).toBe("dispatched");
      await expect(supervisor.rejectInstruction(pending.id)).rejects.toThrow(/already dispatched/);
    } finally {
      await removeProject(projectDir);
    }
  });
});
