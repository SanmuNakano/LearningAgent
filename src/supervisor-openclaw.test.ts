import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getProjectSupervisorForTests, registerProjectSupervisor } from "./supervisor-openclaw.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Project Supervisor OpenClaw lifecycle", () => {
  it("starts and stops one enabled managed worker runtime", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "supervisor-runtime-"));
    tempDirs.push(projectDir);
    let service: { start(): Promise<void>; stop(): Promise<void> } | undefined;
    registerProjectSupervisor({
      pluginConfig: {
        projectSupervisor: {
          projectDir,
          projectRegistryFile: path.join(projectDir, ".central-supervisor", "projects.json"),
          accountRegistryFile: path.join(projectDir, ".central-supervisor", "accounts.json"),
          autoStartServer: false,
          scanIntervalMs: 600_000,
          workerRuntime: { enabled: true, pollIntervalMs: 600_000 }
        }
      },
      registerService(value: typeof service) { service = value; },
      lifecycle: { registerRuntimeLifecycle() {} },
      registerHttpRoute() {},
      registerCommand() {},
      logger: {}
    });

    await service?.start();
    expect((await getProjectSupervisorForTests()?.getOverview())?.workerRuntime).toMatchObject({ enabled: true, running: true });

    await service?.stop();
    expect((await getProjectSupervisorForTests()?.getOverview())?.workerRuntime).toMatchObject({ enabled: true, running: false });
  });
});
