import { describe, expect, it } from "vitest";
import {
  NotificationDeliveryWorker,
  WebhookNotificationDeliveryAdapter,
  type NotificationDeliverySource
} from "./notification-delivery.js";
import type { SupervisorNotification } from "./supervisor-types.js";

function notification(overrides: Partial<SupervisorNotification> = {}): SupervisorNotification {
  return {
    id: "alert-1",
    projectId: "project-a",
    signalId: "worker-no-progress",
    severity: "critical",
    title: "Worker progress is stale",
    detail: "No progress was reported.",
    status: "open",
    deliveryStatus: "pending",
    createdAt: "2026-07-10T10:00:00.000Z",
    updatedAt: "2026-07-10T10:00:00.000Z",
    lastSeenAt: "2026-07-10T10:00:00.000Z",
    occurrenceCount: 1,
    ...overrides
  };
}

describe("notification delivery", () => {
  it("posts a privacy-limited webhook payload with optional bearer auth", async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestInit = init;
      return new Response(null, { status: 204 });
    };
    const adapter = new WebhookNotificationDeliveryAdapter({
      url: "https://alerts.example.test/supervisor",
      bearerToken: "secret-token",
      panelUrl: "https://panel.example.test/",
      fetchImpl
    });
    await adapter.deliver(notification({ command: "/supervise review" }));
    const payload = JSON.parse(String(requestInit?.body));
    expect(requestInit?.headers).toMatchObject({ authorization: "Bearer secret-token" });
    expect(payload.event).toBe("project-supervisor.notification");
    expect(payload.text).toContain("Worker progress is stale");
    expect(payload.notification).not.toHaveProperty("deliveryError");
    expect(JSON.stringify(payload)).not.toContain("secret-token");
  });

  it("marks success and records retry-visible failures with backoff", async () => {
    let now = Date.parse("2026-07-10T12:00:00.000Z");
    const item = notification();
    const source: NotificationDeliverySource = {
      async listNotificationOutbox() { return [item]; },
      async markNotificationDelivery(params) {
        item.deliveryStatus = params.status;
        item.deliveryError = params.error;
        item.lastDeliveryAt = new Date(now).toISOString();
        item.deliveryAttempts = (item.deliveryAttempts ?? 0) + 1;
        return item;
      }
    };
    let deliveryCalls = 0;
    let shouldFail = true;
    const worker = new NotificationDeliveryWorker(source, { async deliver() { deliveryCalls++; if (shouldFail) throw new Error("temporary failure"); } }, 60_000, () => now);
    await worker.runOnce();
    expect(item.deliveryStatus).toBe("failed");
    expect(item.deliveryAttempts).toBe(1);
    await worker.runOnce();
    expect(deliveryCalls).toBe(1);
    now += 120_000;
    shouldFail = false;
    await worker.runOnce();
    expect(deliveryCalls).toBe(2);
    expect(item.deliveryStatus).toBe("delivered");
  });

  it("rejects unsafe webhook URLs and sanitizes transport failures", async () => {
    expect(() => new WebhookNotificationDeliveryAdapter({ url: "file:///tmp/alert" })).toThrow(/HTTP or HTTPS/);
    expect(() => new WebhookNotificationDeliveryAdapter({ url: "https://user:pass@example.test/" })).toThrow(/must not contain credentials/);
    const adapter = new WebhookNotificationDeliveryAdapter({
      url: "https://alerts.example.test/private?token=hidden",
      fetchImpl: (async () => { throw new TypeError("request to secret URL failed"); }) as typeof fetch
    });
    await expect(adapter.deliver(notification())).rejects.toThrow("Notification webhook request failed (TypeError).");
  });
});
