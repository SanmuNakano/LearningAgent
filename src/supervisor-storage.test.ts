import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectSupervisor } from "./supervisor.js";
import {
  emptySupervisorState,
  JsonSupervisorStateStorage,
  type SupervisorStateStorage
} from "./supervisor-storage.js";
import type { SupervisorState } from "./supervisor-types.js";

class MemoryStateStorage implements SupervisorStateStorage {
  state = emptySupervisorState();
  writes = 0;

  async read(): Promise<SupervisorState> {
    return structuredClone(this.state);
  }

  async write(state: SupervisorState): Promise<void> {
    this.state = structuredClone(state);
    this.writes++;
  }
}

describe("supervisor state storage", () => {
  it("normalizes missing and malformed JSON state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supervisor-storage-"));
    const file = join(dir, "state.json");
    try {
      const storage = new JsonSupervisorStateStorage(file);
      await expect(storage.read()).resolves.toEqual(emptySupervisorState());
      await writeFile(file, "{not-json", "utf-8");
      await expect(storage.read()).resolves.toEqual(emptySupervisorState());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes atomic JSON writes without leaving temporary files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supervisor-storage-"));
    const file = join(dir, "state.json");
    try {
      const storage = new JsonSupervisorStateStorage(file);
      await Promise.all([
        storage.write({ ...emptySupervisorState(), token: "first" }),
        storage.write({ ...emptySupervisorState(), token: "second" })
      ]);
      expect(JSON.parse(await readFile(file, "utf-8")).token).toBe("second");
      expect((await readdir(dir)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("allows ProjectSupervisor to use a replaceable state backend", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "supervisor-storage-project-"));
    const storage = new MemoryStateStorage();
    try {
      const supervisor = new ProjectSupervisor({ projectDir, autoStartServer: false }, {}, storage);
      const token = await supervisor.ensureToken();
      expect(token).toBeTruthy();
      expect(storage.state.token).toBe(token);
      expect(storage.writes).toBe(1);
      expect(await supervisor.readState()).toEqual(storage.state);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
