import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ProjectSupervisor, ProjectSupervisorHub, normalizeSupervisorConfig } from "./supervisor.js";

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

function makeResponse() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(value: unknown) {
      this.body = typeof value === "string" ? value : String(value ?? "");
    }
  };
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

  it("emits a critical signal when worker progress is stale", async () => {
    const projectDir = await makeProject();
    try {
      const supervisorDir = join(projectDir, ".project-supervisor");
      await mkdir(supervisorDir, { recursive: true });
      await writeFile(join(supervisorDir, "worker-state.json"), JSON.stringify({
        workerId: "codex-main",
        status: "working",
        currentStep: "Still editing the same file",
        lastProgressAt: "2000-01-01T00:00:00.000Z",
        updatedAt: "2000-01-01T00:00:00.000Z"
      }), "utf-8");
      const supervisor = new ProjectSupervisor({
        projectId: "test-project",
        projectDir,
        stateFile: join(supervisorDir, "state.json"),
        autoStartServer: false,
        staleAfterMs: 1_000,
        maxFiles: 100
      });

      const snapshot = await supervisor.scan();
      const signal = snapshot.signals.find((entry) => entry.id === "worker-no-progress");

      expect(signal?.severity).toBe("critical");
      expect(snapshot.health).toBe("blocked");
      expect(snapshot.risks.some((risk) => risk.includes("Worker progress is stale"))).toBe(true);
    } finally {
      await removeProject(projectDir);
    }
  });

  it("opens and acknowledges notifications from supervision signals", async () => {
    const projectDir = await makeProject();
    try {
      const supervisorDir = join(projectDir, ".project-supervisor");
      await mkdir(supervisorDir, { recursive: true });
      await writeFile(join(supervisorDir, "worker-state.json"), JSON.stringify({
        workerId: "codex-main",
        status: "working",
        currentStep: "Reviewing instructions"
      }), "utf-8");
      const supervisor = new ProjectSupervisor({
        projectId: "test-project",
        projectDir,
        stateFile: join(supervisorDir, "state.json"),
        autoStartServer: false,
        notificationCooldownMs: 60_000,
        maxFiles: 100
      });

      await supervisor.createInstruction({
        instruction: "Review this proposed action.",
        createdBy: "supervisor",
        source: "system"
      });
      await supervisor.scan();

      const open = await supervisor.listNotifications("open");
      const notification = open.find((entry) => entry.signalId === "pending-human-decision");
      expect(notification?.status).toBe("open");

      const overview = await supervisor.getOverview();
      expect(overview.notifications.some((entry) => entry.signalId === "pending-human-decision")).toBe(true);

      await supervisor.acknowledgeNotification("pending-human-decision", "test");
      expect(await supervisor.listNotifications("open")).toHaveLength(0);

      await supervisor.scan();
      expect(await supervisor.listNotifications("open")).toHaveLength(0);
      const acknowledged = await supervisor.listNotifications("acknowledged");
      expect(acknowledged[0].acknowledgedBy).toBe("test");
    } finally {
      await removeProject(projectDir);
    }
  });

  it("resolves open notifications when their signal disappears", async () => {
    const projectDir = await makeProject();
    try {
      const supervisorDir = join(projectDir, ".project-supervisor");
      await mkdir(supervisorDir, { recursive: true });
      const supervisor = new ProjectSupervisor({
        projectId: "test-project",
        projectDir,
        stateFile: join(supervisorDir, "state.json"),
        autoStartServer: false,
        maxFiles: 100
      });

      await supervisor.scan();
      expect((await supervisor.listNotifications("open")).some((entry) => entry.signalId === "worker-heartbeat-missing")).toBe(true);

      await writeFile(join(supervisorDir, "worker-state.json"), JSON.stringify({
        workerId: "codex-main",
        status: "working",
        currentStep: "Continuing work"
      }), "utf-8");
      await supervisor.scan();

      expect((await supervisor.listNotifications("open")).some((entry) => entry.signalId === "worker-heartbeat-missing")).toBe(false);
      expect((await supervisor.listNotifications("resolved")).some((entry) => entry.signalId === "worker-heartbeat-missing")).toBe(true);
    } finally {
      await removeProject(projectDir);
    }
  });

  it("emits a critical signal for repeated command failures", async () => {
    const projectDir = await makeProject();
    try {
      const supervisorDir = join(projectDir, ".project-supervisor");
      const stateFile = join(supervisorDir, "state.json");
      await mkdir(supervisorDir, { recursive: true });
      await writeFile(stateFile, JSON.stringify({
        snapshots: [],
        instructions: [],
        tasks: [
          {
            id: "task-1",
            name: "check",
            command: "npm run check",
            startedAt: "2026-07-09T10:00:00.000Z",
            finishedAt: "2026-07-09T10:00:01.000Z",
            status: "failed",
            exitCode: 1,
            log: "first failure"
          },
          {
            id: "task-2",
            name: "check",
            command: "npm run check",
            startedAt: "2026-07-09T10:05:00.000Z",
            finishedAt: "2026-07-09T10:05:01.000Z",
            status: "timeout",
            exitCode: null,
            log: "second failure"
          }
        ]
      }, null, 2), "utf-8");
      const supervisor = new ProjectSupervisor({
        projectId: "test-project",
        projectDir,
        stateFile,
        autoStartServer: false,
        maxFiles: 100
      });

      const snapshot = await supervisor.scan();
      const signal = snapshot.signals.find((entry) => entry.id === "repeated-command-failure");

      expect(signal?.severity).toBe("critical");
      expect(signal?.detail).toContain("check");
      expect(snapshot.health).toBe("blocked");
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

  it("merges worker outbox acknowledgement events into instruction status", async () => {
    const projectDir = await makeProject();
    try {
      const supervisorDir = join(projectDir, ".project-supervisor");
      const outboxFile = join(supervisorDir, "outbox.jsonl");
      const supervisor = new ProjectSupervisor({
        projectId: "test-project",
        projectDir,
        stateFile: join(supervisorDir, "state.json"),
        workerInboxFile: join(supervisorDir, "inbox.jsonl"),
        workerOutboxFile: outboxFile,
        auditFile: join(supervisorDir, "audit.jsonl"),
        autoStartServer: false
      });

      const dispatched = await supervisor.createInstruction({
        instruction: "Run the smoke test.",
        createdBy: "human",
        source: "mobile",
        approve: true
      });
      await appendFile(outboxFile, JSON.stringify({
        instructionId: dispatched.id,
        workerId: dispatched.targetWorker,
        status: "completed",
        message: "Smoke test passed.",
        at: "2026-07-09T11:45:00.000Z"
      }) + "\n", "utf-8");

      const instructions = await supervisor.listInstructions();

      expect(instructions[0].workerStatus).toBe("completed");
      expect(instructions[0].workerMessage).toBe("Smoke test passed.");
    } finally {
      await removeProject(projectDir);
    }
  });

  it("lets a worker read inbox instructions and write acknowledgements", async () => {
    const projectDir = await makeProject();
    try {
      const supervisorDir = join(projectDir, ".project-supervisor");
      const supervisor = new ProjectSupervisor({
        projectId: "test-project",
        projectDir,
        stateFile: join(supervisorDir, "state.json"),
        workerInboxFile: join(supervisorDir, "inbox.jsonl"),
        workerOutboxFile: join(supervisorDir, "outbox.jsonl"),
        auditFile: join(supervisorDir, "audit.jsonl"),
        autoStartServer: false
      });

      const dispatched = await supervisor.createInstruction({
        instruction: "Inspect the latest failure.",
        createdBy: "human",
        source: "mobile",
        approve: true
      });
      const initialInbox = await supervisor.listWorkerInbox({ workerId: dispatched.targetWorker });
      expect(initialInbox).toHaveLength(1);
      expect(initialInbox[0].instruction).toBe("Inspect the latest failure.");

      const received = await supervisor.acknowledgeWorkerInstruction({
        instructionId: dispatched.id,
        status: "received",
        message: "I will inspect it now.",
        workerId: dispatched.targetWorker
      });
      expect(received.status).toBe("received");
      const activeInbox = await supervisor.listWorkerInbox({ workerId: dispatched.targetWorker });
      expect(activeInbox[0].workerStatus).toBe("received");
      expect(activeInbox[0].workerMessage).toBe("I will inspect it now.");

      await supervisor.acknowledgeWorkerInstruction({
        instructionId: dispatched.id,
        status: "completed",
        message: "Inspection complete.",
        workerId: dispatched.targetWorker
      });
      expect(await supervisor.listWorkerInbox({ workerId: dispatched.targetWorker })).toHaveLength(0);
      const allInbox = await supervisor.listWorkerInbox({ workerId: dispatched.targetWorker, includeAcknowledged: true });
      expect(allInbox[0].workerStatus).toBe("completed");
      expect(allInbox[0].workerMessage).toBe("Inspection complete.");
      await expect(supervisor.acknowledgeWorkerInstruction({ instructionId: "missing", status: "received" })).rejects.toThrow(/not found/);
    } finally {
      await removeProject(projectDir);
    }
  });

  it("builds an operator overview and approves or rejects the latest pending instruction", async () => {
    const projectDir = await makeProject();
    try {
      const supervisorDir = join(projectDir, ".project-supervisor");
      await mkdir(supervisorDir, { recursive: true });
      const supervisor = new ProjectSupervisor({
        projectId: "test-project",
        projectDir,
        stateFile: join(supervisorDir, "state.json"),
        workerInboxFile: join(supervisorDir, "inbox.jsonl"),
        auditFile: join(supervisorDir, "audit.jsonl"),
        autoStartServer: false,
        maxFiles: 100
      });

      const first = await supervisor.createInstruction({ instruction: "First pending instruction." });
      const second = await supervisor.createInstruction({ instruction: "Second pending instruction." });
      const overview = await supervisor.getOverview();

      expect(overview.activeProject.id).toBe("test-project");
      expect(overview.pendingInstructions.map((instruction) => instruction.id)).toEqual([first.id, second.id]);

      const approved = await supervisor.approveLatestPendingInstruction();
      expect(approved.id).toBe(second.id);
      expect(approved.status).toBe("dispatched");
      const inbox = await readFile(join(supervisorDir, "inbox.jsonl"), "utf-8");
      expect(inbox).toContain("Second pending instruction.");

      const rejected = await supervisor.rejectLatestPendingInstruction("Not now.");
      expect(rejected.id).toBe(first.id);
      expect(rejected.status).toBe("rejected");
      expect(rejected.rejectReason).toBe("Not now.");
    } finally {
      await removeProject(projectDir);
    }
  });

  it("requires the generated token for direct HTTP access", async () => {
    const projectDir = await makeProject();
    try {
      const supervisor = new ProjectSupervisor({
        projectId: "test-project",
        projectDir,
        stateFile: join(projectDir, ".project-supervisor", "state.json"),
        autoStartServer: false,
        maxFiles: 100
      });
      const unauthorized = makeResponse();
      await supervisor.handleHttp({ method: "GET", url: "/api/status", headers: { host: "localhost" } } as any, unauthorized as any);

      const token = await supervisor.ensureToken();
      const authorized = makeResponse();
      await supervisor.handleHttp({ method: "GET", url: `/api/overview?token=${token}`, headers: { host: "localhost" } } as any, authorized as any);

      expect(unauthorized.statusCode).toBe(401);
      expect(authorized.statusCode).toBe(200);
      expect(JSON.parse(authorized.body).activeProject.id).toBe("test-project");
    } finally {
      await removeProject(projectDir);
    }
  });

  it("registers the current project in a central project registry", async () => {
    const projectDir = await makeProject();
    try {
      const registryFile = join(projectDir, ".central-supervisor", "projects.json");
      const supervisor = new ProjectSupervisor({
        projectId: "test-project",
        projectDir,
        stateFile: join(projectDir, ".project-supervisor", "state.json"),
        projectRegistryFile: registryFile,
        autoStartServer: false
      });

      const project = await supervisor.registerCurrentProject();
      const registry = await supervisor.readProjectRegistry();
      const text = await supervisor.renderProjectsText();

      expect(project.id).toBe("test-project");
      expect(registry.activeProjectId).toBe("test-project");
      expect(registry.projects).toHaveLength(1);
      expect(registry.projects[0].stateFile).toContain("state.json");
      expect(registry.projects[0].workerInboxFile).toContain("inbox.jsonl");
      expect(registry.projects[0].workerOutboxFile).toContain("outbox.jsonl");
      expect(text).toContain("test-project (active)");
    } finally {
      await removeProject(projectDir);
    }
  });

  it("routes scans and instructions to the active project through the hub", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    try {
      const registryFile = join(projectA, ".central-supervisor", "projects.json");
      const supervisorDirB = join(projectB, ".project-supervisor");
      await mkdir(supervisorDirB, { recursive: true });
      await writeFile(join(supervisorDirB, "worker-state.json"), JSON.stringify({
        projectId: "project-b",
        workerId: "codex-b",
        status: "working",
        currentStep: "Building project B"
      }), "utf-8");

      const hub = new ProjectSupervisorHub({
        projectId: "project-a",
        projectDir: projectA,
        stateFile: join(projectA, ".project-supervisor", "state.json"),
        projectRegistryFile: registryFile,
        autoStartServer: false,
        maxFiles: 100
      });

      await hub.registerCurrentProject();
      await hub.registerProject(projectB, "project-b");
      await hub.activateProject("project-b");

      const snapshot = await hub.scan();
      const overview = await hub.getOverview();
      const instruction = await hub.createInstruction({
        instruction: "Continue project B and report status.",
        createdBy: "human",
        source: "mobile",
        approve: true
      });
      const inbox = await readFile(join(supervisorDirB, "inbox.jsonl"), "utf-8");

      expect(snapshot.projectDir).toBe(projectB);
      expect(snapshot.worker.workerId).toBe("codex-b");
      expect(snapshot.worker.currentStep).toBe("Building project B");
      expect(overview.activeProject.id).toBe("project-b");
      expect(instruction.projectId).toBe("project-b");
      expect(inbox).toContain("Continue project B and report status.");
    } finally {
      await removeProject(projectA);
      await removeProject(projectB);
    }
  });
});
