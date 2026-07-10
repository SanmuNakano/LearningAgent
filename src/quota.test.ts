import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexQuotaService } from "./quota.js";

async function makeService() {
  const dir = await mkdtemp(join(tmpdir(), "codex-quota-"));
  return { dir, service: new CodexQuotaService(join(dir, "accounts.json")) };
}

describe("CodexQuotaService", () => {
  it("tracks multiple accounts with independent quota reset times", async () => {
    const { dir, service } = await makeService();
    try {
      await service.registerAccount({ id: "personal-a", displayName: "Personal A" });
      await service.registerAccount({ id: "work-b", displayName: "Work B", accountType: "business", workspaceName: "Team" });
      await service.setQuota({
        accountId: "personal-a",
        id: "weekly",
        quotaType: "weekly",
        status: "exhausted",
        resetAt: "2026-07-10T02:00:00.000Z",
        source: "client_signal",
        confidence: "observed"
      });
      await service.setQuota({
        accountId: "work-b",
        id: "daily",
        quotaType: "daily",
        status: "exhausted",
        resetAt: "2026-07-11T02:00:00.000Z",
        source: "manual",
        confidence: "estimated"
      });

      const created = await service.reconcile(new Date("2026-07-10T03:00:00.000Z"));
      const registry = await service.read();

      expect(created).toHaveLength(1);
      expect(created[0].signalId).toBe("codex-quota-reset:personal-a:weekly");
      expect(registry.windows.find((window) => window.accountId === "personal-a")?.status).toBe("available_unverified");
      expect(registry.windows.find((window) => window.accountId === "work-b")?.status).toBe("exhausted");
      expect(await service.reconcile(new Date("2026-07-10T04:00:00.000Z"))).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deduplicates reset reminders and tracks notification delivery", async () => {
    const { dir, service } = await makeService();
    try {
      await service.registerAccount({ id: "codex-a" });
      await service.setQuota({
        accountId: "codex-a",
        id: "rolling",
        quotaType: "rolling",
        status: "exhausted",
        resetAt: "2026-07-10T01:00:00.000Z"
      });
      await service.reconcile(new Date("2026-07-10T02:00:00.000Z"));

      const pending = await service.listNotificationOutbox();
      expect(pending).toHaveLength(1);
      const delivered = await service.markNotificationDelivery(pending[0].id, "delivered");
      expect(delivered?.deliveryAttempts).toBe(1);
      expect(await service.listNotificationOutbox()).toHaveLength(0);

      await service.setQuota({
        accountId: "codex-a",
        id: "rolling",
        status: "exhausted",
        resetAt: "2026-07-10T05:00:00.000Z"
      });
      expect(await service.reconcile(new Date("2026-07-10T06:00:00.000Z"))).toHaveLength(1);
      expect((await service.listNotifications()).filter((notification) => notification.status === "open")).toHaveLength(1);

      await service.setQuota({ accountId: "codex-a", id: "rolling", status: "available", resetAt: null });
      expect(await service.listNotifications("open")).toHaveLength(0);
      expect(await service.listNotificationOutbox()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent account updates without losing records", async () => {
    const { dir, service } = await makeService();
    try {
      await Promise.all([
        service.registerAccount({ id: "a" }),
        service.registerAccount({ id: "b" }),
        service.registerAccount({ id: "c" })
      ]);
      expect((await service.read()).accounts.map((account) => account.id).sort()).toEqual(["a", "b", "c"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("starts new log sources at the current end unless backfill is requested", async () => {
    const { dir, service } = await makeService();
    try {
      const logFile = join(dir, "codex.log");
      await writeFile(logFile, "historical quota message\n", "utf-8");
      await service.registerAccount({ id: "codex-a" });
      await service.registerLogSource({ id: "tail", accountId: "codex-a", file: logFile });
      await service.registerLogSource({ id: "backfill", accountId: "codex-a", file: logFile, startAt: "beginning" });
      const registry = await service.read();
      expect(registry.logCursors.find((cursor) => cursor.sourceId === "tail")?.offset).toBeGreaterThan(0);
      expect(registry.logCursors.some((cursor) => cursor.sourceId === "backfill")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
