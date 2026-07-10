import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isQuotaSignalCandidate, pollQuotaLogSource } from "./quota-log-watcher.js";
import type { QuotaLogSource } from "./quota.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "quota-log-"));
  const file = join(dir, "codex.log");
  const source: QuotaLogSource = {
    id: "codex-a-log",
    accountId: "codex-a",
    file,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  return { dir, file, source };
}

describe("pollQuotaLogSource", () => {
  it("reads only appended complete lines and preserves an incomplete tail", async () => {
    const { dir, file, source } = await fixture();
    try {
      await writeFile(file, "ordinary log\nUsage limit reached. Try again in 5h.\npartial", "utf-8");
      const first = await pollQuotaLogSource(source);
      expect(first.lines).toEqual(["ordinary log", "Usage limit reached. Try again in 5h."]);
      expect(first.lines.filter(isQuotaSignalCandidate)).toEqual(["Usage limit reached. Try again in 5h."]);

      await appendFile(file, " line\nCodex quota is available again.\n", "utf-8");
      const second = await pollQuotaLogSource(source, first.cursor);
      expect(second.lines).toEqual(["partial line", "Codex quota is available again."]);
      expect(second.lines).not.toContain("Usage limit reached. Try again in 5h.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("restarts at byte zero after a log is truncated", async () => {
    const { dir, file, source } = await fixture();
    try {
      await writeFile(file, "ordinary long first line\nsecond line\n", "utf-8");
      const first = await pollQuotaLogSource(source);
      await writeFile(file, "额度已恢复，可以使用。\n", "utf-8");
      const second = await pollQuotaLogSource(source, first.cursor);
      expect(second.rotated).toBe(true);
      expect(second.lines).toEqual(["额度已恢复，可以使用。"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports missing files without throwing or exposing file contents", async () => {
    const { dir, source } = await fixture();
    try {
      const result = await pollQuotaLogSource(source);
      expect(result.lines).toEqual([]);
      expect(result.cursor.lastError).toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
