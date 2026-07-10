import type { SupervisorNotification } from "./supervisor-types.js";

export type NotificationDeliveryAdapter = {
  deliver(notification: SupervisorNotification): Promise<void>;
};

export type NotificationDeliverySource = {
  listNotificationOutbox(): Promise<SupervisorNotification[]>;
  markNotificationDelivery(params: { id: string; status: "delivered" | "failed"; error?: string }): Promise<SupervisorNotification>;
};

export type WebhookNotificationDeliveryOptions = {
  url: string;
  bearerToken?: string;
  timeoutMs?: number;
  panelUrl?: string;
  fetchImpl?: typeof fetch;
};

function validateWebhookUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Notification webhook must use HTTP or HTTPS.");
  if (parsed.username || parsed.password) throw new Error("Notification webhook URL must not contain credentials.");
  return parsed.toString();
}

export function formatNotificationText(notification: SupervisorNotification): string {
  return [
    `[Project Supervisor][${notification.severity.toUpperCase()}] ${notification.title}`,
    `Project: ${notification.projectId}`,
    notification.detail,
    notification.command ? `Suggested command: ${notification.command}` : undefined
  ].filter(Boolean).join("\n");
}

export class WebhookNotificationDeliveryAdapter implements NotificationDeliveryAdapter {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: WebhookNotificationDeliveryOptions) {
    this.url = validateWebhookUrl(options.url);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async deliver(notification: SupervisorNotification): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.options.bearerToken ? { authorization: `Bearer ${this.options.bearerToken}` } : {})
        },
        body: JSON.stringify({
          version: 1,
          event: "project-supervisor.notification",
          sentAt: new Date().toISOString(),
          text: formatNotificationText(notification),
          panelUrl: this.options.panelUrl || undefined,
          notification: {
            id: notification.id,
            projectId: notification.projectId,
            signalId: notification.signalId,
            severity: notification.severity,
            title: notification.title,
            detail: notification.detail,
            command: notification.command,
            createdAt: notification.createdAt,
            updatedAt: notification.updatedAt,
            occurrenceCount: notification.occurrenceCount
          }
        })
      });
      if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}.`);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("Notification webhook timed out.");
      if (error instanceof Error && /^Webhook returned HTTP \d+\.$/.test(error.message)) throw error;
      throw new Error(`Notification webhook request failed (${error instanceof Error ? error.name : "unknown error"}).`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class NotificationDeliveryWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly source: NotificationDeliverySource,
    private readonly adapter: NotificationDeliveryAdapter,
    private readonly intervalMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly onError: (error: unknown) => void = () => undefined
  ) {}

  start(): void {
    if (this.timer) return;
    const trigger = () => void this.runOnce().catch(this.onError);
    trigger();
    this.timer = setInterval(trigger, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const notifications = (await this.source.listNotificationOutbox()).slice(0, 10);
      for (const notification of notifications) {
        if (!this.isEligible(notification)) continue;
        try {
          await this.adapter.deliver(notification);
          await this.source.markNotificationDelivery({ id: notification.id, status: "delivered" });
        } catch (error) {
          await this.source.markNotificationDelivery({
            id: notification.id,
            status: "failed",
            error: error instanceof Error ? error.message : "Notification delivery failed."
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private isEligible(notification: SupervisorNotification): boolean {
    if ((notification.deliveryStatus ?? "pending") === "pending" || !notification.lastDeliveryAt) return true;
    const attempts = Math.max(1, notification.deliveryAttempts ?? 1);
    const backoffMs = Math.min(this.intervalMs * (2 ** attempts), 30 * 60_000);
    return this.now() - Date.parse(notification.lastDeliveryAt) >= backoffMs;
  }
}
