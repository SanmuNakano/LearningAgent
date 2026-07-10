import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLogService } from "./supervisor-audit.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeService(retentionDays = 30, maxEntries = 100): Promise<{ file: string; service: AuditLogService }> {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-audit-"));
  tempDirs.push(directory);
  const file = join(directory, "audit.jsonl");
  return { file, service: new AuditLogService(file, retentionDays, maxEntries) };
}

describe("AuditLogService", () => {
  it("queries newest entries by event and time range", async () => {
    const { file, service } = await makeService();
    await appendFile(file, [
      JSON.stringify({ event: "old", at: "2026-01-01T00:00:00.000Z", payload: { value: 1 } }),
      JSON.stringify({ event: "match", at: "2026-02-01T00:00:00.000Z", payload: { value: 2 } }),
      JSON.stringify({ event: "match", at: "2026-03-01T00:00:00.000Z", payload: { value: 3 } })
    ].join("\n") + "\n", "utf-8");

    await expect(service.query({ event: "match", from: "2026-01-15", to: "2026-03-15", limit: 1 })).resolves.toEqual([
      { event: "match", at: "2026-03-01T00:00:00.000Z", payload: { value: 3 } }
    ]);
    await expect(service.query({ from: "not-a-date" })).rejects.toThrow("valid date");
  });

  it("prunes by age and count while retaining malformed lines for investigation", async () => {
    const { file, service } = await makeService(10, 2);
    await appendFile(file, [
      JSON.stringify({ event: "expired", at: "2026-01-01T00:00:00.000Z" }),
      "malformed-line",
      JSON.stringify({ event: "recent-1", at: "2026-01-25T00:00:00.000Z" }),
      JSON.stringify({ event: "recent-2", at: "2026-01-30T00:00:00.000Z" })
    ].join("\n") + "\n", "utf-8");

    await expect(service.prune(new Date("2026-02-01T00:00:00.000Z"))).resolves.toMatchObject({ before: 4, after: 2, removed: 2 });
    const retained = await readFile(file, "utf-8");
    expect(retained).not.toContain("expired");
    expect(retained).not.toContain("malformed-line");
    expect(retained).toContain("recent-1");
    expect(retained).toContain("recent-2");
  });

  it("serializes append and prune operations", async () => {
    const { service } = await makeService(30, 100);
    await Promise.all([
      service.append("first", { order: 1 }),
      service.prune(new Date()),
      service.append("second", { order: 2 })
    ]);

    await expect(service.query({ limit: 10 })).resolves.toMatchObject([
      { event: "second" },
      { event: "first" }
    ]);
  });
});
