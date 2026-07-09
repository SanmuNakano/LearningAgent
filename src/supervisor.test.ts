import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
});
