import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type CodexAccountType = "personal" | "business" | "enterprise";
export type QuotaType = "rolling" | "daily" | "weekly" | "monthly" | "credits" | "custom";
export type QuotaStatus = "available" | "low" | "exhausted" | "available_unverified" | "unknown";
export type QuotaSource = "manual" | "client_signal" | "official_api" | "estimated";
export type QuotaConfidence = "exact" | "observed" | "estimated";
export type QuotaNotificationStatus = "open" | "acknowledged" | "resolved";
export type QuotaDeliveryStatus = "pending" | "delivered" | "failed";

export type CodexAccount = {
  id: string;
  displayName: string;
  accountType: CodexAccountType;
  workspaceName?: string;
  timezone: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type QuotaWindow = {
  id: string;
  accountId: string;
  label: string;
  quotaType: QuotaType;
  status: QuotaStatus;
  remaining?: number;
  resetAt?: string;
  observedAt: string;
  source: QuotaSource;
  confidence: QuotaConfidence;
  lastNotifiedResetAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type QuotaNotification = {
  id: string;
  projectId: "accounts";
  signalId: string;
  severity: "info";
  title: string;
  detail: string;
  command: string;
  status: QuotaNotificationStatus;
  deliveryStatus: QuotaDeliveryStatus;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  deliveryAttempts?: number;
  lastDeliveryAt?: string;
  deliveryError?: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
};

export type QuotaRegistry = {
  version: 1;
  accounts: CodexAccount[];
  windows: QuotaWindow[];
  notifications: QuotaNotification[];
  observations: QuotaObservationRecord[];
  logSources: QuotaLogSource[];
  logCursors: QuotaLogCursor[];
  updatedAt?: string;
};

export type QuotaLogSource = {
  id: string;
  accountId: string;
  file: string;
  enabled: boolean;
  windowId?: string;
  quotaType?: QuotaType;
  createdAt: string;
  updatedAt: string;
};

export type QuotaLogCursor = {
  sourceId: string;
  fileId?: string;
  offset: number;
  size: number;
  updatedAt: string;
  lastError?: string;
  lastErrorAt?: string;
};

export type RegisterQuotaLogSourceInput = {
  id: string;
  accountId: string;
  file: string;
  enabled?: boolean;
  windowId?: string;
  quotaType?: QuotaType;
  startAt?: "beginning" | "end";
};

export type QuotaObservationRecord = {
  id: string;
  accountId: string;
  windowId?: string;
  matched: boolean;
  status?: QuotaStatus;
  quotaType?: QuotaType;
  resetAt?: string;
  observedAt: string;
  evidenceHash: string;
  parserVersion: string;
  reason?: string;
  createdAt: string;
};

export type RecordQuotaObservationInput = Omit<QuotaObservationRecord, "id" | "createdAt">;

export type RegisterAccountInput = {
  id: string;
  displayName?: string;
  accountType?: CodexAccountType;
  workspaceName?: string;
  timezone?: string;
  enabled?: boolean;
};

export type SetQuotaInput = {
  accountId: string;
  id: string;
  label?: string;
  quotaType?: QuotaType;
  status?: QuotaStatus;
  remaining?: number | null;
  resetAt?: string | null;
  observedAt?: string;
  source?: QuotaSource;
  confidence?: QuotaConfidence;
};

const ACCOUNT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const WINDOW_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function nowIso(): string {
  return new Date().toISOString();
}

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function validIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function normalizeAccountType(value: unknown): CodexAccountType {
  return value === "business" || value === "enterprise" ? value : "personal";
}

function normalizeQuotaType(value: unknown): QuotaType {
  return value === "rolling" || value === "daily" || value === "weekly" || value === "monthly" || value === "credits" || value === "custom"
    ? value
    : "custom";
}

function normalizeQuotaStatus(value: unknown): QuotaStatus {
  return value === "available" || value === "low" || value === "exhausted" || value === "available_unverified" || value === "unknown"
    ? value
    : "unknown";
}

function normalizeQuotaSource(value: unknown): QuotaSource {
  return value === "client_signal" || value === "official_api" || value === "estimated" ? value : "manual";
}

function normalizeConfidence(value: unknown, source: QuotaSource): QuotaConfidence {
  if (value === "exact" || value === "observed" || value === "estimated") return value;
  return source === "official_api" ? "exact" : source === "estimated" ? "estimated" : "observed";
}

function normalizeRegistry(raw: unknown): QuotaRegistry {
  if (!raw || typeof raw !== "object") return { version: 1, accounts: [], windows: [], notifications: [], observations: [], logSources: [], logCursors: [] };
  const value = raw as Record<string, unknown>;
  return {
    version: 1,
    accounts: Array.isArray(value.accounts) ? value.accounts as CodexAccount[] : [],
    windows: Array.isArray(value.windows) ? value.windows as QuotaWindow[] : [],
    notifications: Array.isArray(value.notifications) ? value.notifications as QuotaNotification[] : [],
    observations: Array.isArray(value.observations) ? value.observations as QuotaObservationRecord[] : [],
    logSources: Array.isArray(value.logSources) ? value.logSources as QuotaLogSource[] : [],
    logCursors: Array.isArray(value.logCursors) ? value.logCursors as QuotaLogCursor[] : [],
    updatedAt: validIso(value.updatedAt)
  };
}

async function readRegistry(file: string): Promise<QuotaRegistry> {
  try {
    return normalizeRegistry(JSON.parse(await fs.readFile(file, "utf-8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return normalizeRegistry(undefined);
    throw error;
  }
}

async function writeRegistry(file: string, registry: QuotaRegistry): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(registry, null, 2), "utf-8");
  await fs.rename(tempFile, file);
}

export class CodexQuotaService {
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string, private readonly maxNotifications = 200, private readonly maxObservations = 500) {}

  async read(): Promise<QuotaRegistry> {
    return await readRegistry(this.file);
  }

  private async mutate<T>(fn: (registry: QuotaRegistry) => T | Promise<T>): Promise<T> {
    const operation = this.mutationQueue.then(async () => {
      const registry = await this.read();
      const result = await fn(registry);
      registry.updatedAt = nowIso();
      registry.notifications = registry.notifications.slice(-this.maxNotifications);
      registry.observations = registry.observations.slice(-this.maxObservations);
      await writeRegistry(this.file, registry);
      return result;
    });
    this.mutationQueue = operation.catch(() => undefined);
    return await operation;
  }

  async registerAccount(input: RegisterAccountInput): Promise<CodexAccount> {
    const id = input.id.trim();
    if (!ACCOUNT_ID_RE.test(id)) throw new Error("Account id must use 1-64 letters, numbers, underscores, or hyphens.");
    return await this.mutate((registry) => {
      const now = nowIso();
      const existing = registry.accounts.find((account) => account.id === id);
      const account: CodexAccount = {
        id,
        displayName: cleanText(input.displayName, 120) ?? existing?.displayName ?? id,
        accountType: input.accountType ?? existing?.accountType ?? "personal",
        workspaceName: cleanText(input.workspaceName, 160) ?? existing?.workspaceName,
        timezone: cleanText(input.timezone, 80) ?? existing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
        enabled: input.enabled ?? existing?.enabled ?? true,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      if (existing) Object.assign(existing, account);
      else registry.accounts.push(account);
      return account;
    });
  }

  async removeAccount(id: string): Promise<void> {
    const accountId = id.trim();
    await this.mutate((registry) => {
      if (!registry.accounts.some((account) => account.id === accountId)) throw new Error(`Account "${accountId}" was not found.`);
      registry.accounts = registry.accounts.filter((account) => account.id !== accountId);
      registry.windows = registry.windows.filter((window) => window.accountId !== accountId);
      registry.notifications = registry.notifications.filter((notification) => !notification.signalId.startsWith(`codex-quota-reset:${accountId}:`));
      registry.observations = registry.observations.filter((observation) => observation.accountId !== accountId);
      const removedSourceIds = new Set(registry.logSources.filter((source) => source.accountId === accountId).map((source) => source.id));
      registry.logSources = registry.logSources.filter((source) => source.accountId !== accountId);
      registry.logCursors = registry.logCursors.filter((cursor) => !removedSourceIds.has(cursor.sourceId));
    });
  }

  async setQuota(input: SetQuotaInput): Promise<QuotaWindow> {
    const accountId = input.accountId.trim();
    const id = input.id.trim();
    if (!WINDOW_ID_RE.test(id)) throw new Error("Quota window id must use 1-64 letters, numbers, underscores, or hyphens.");
    return await this.mutate((registry) => {
      if (!registry.accounts.some((account) => account.id === accountId)) throw new Error(`Account "${accountId}" was not found.`);
      const now = nowIso();
      const existing = registry.windows.find((window) => window.accountId === accountId && window.id === id);
      const source = input.source ?? existing?.source ?? "manual";
      const resetAt = input.resetAt === null ? undefined : input.resetAt === undefined ? existing?.resetAt : validIso(input.resetAt);
      if (input.resetAt !== undefined && input.resetAt !== null && !resetAt) throw new Error("resetAt must be a valid date/time.");
      const remaining = input.remaining === null
        ? undefined
        : input.remaining === undefined
          ? existing?.remaining
          : Number.isFinite(input.remaining) ? input.remaining : undefined;
      const window: QuotaWindow = {
        id,
        accountId,
        label: cleanText(input.label, 120) ?? existing?.label ?? id,
        quotaType: input.quotaType ?? existing?.quotaType ?? "custom",
        status: input.status ?? existing?.status ?? "unknown",
        remaining,
        resetAt,
        observedAt: validIso(input.observedAt) ?? now,
        source,
        confidence: input.confidence ?? existing?.confidence ?? normalizeConfidence(undefined, source),
        lastNotifiedResetAt: existing?.lastNotifiedResetAt,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      if (window.status === "exhausted" && existing?.resetAt !== window.resetAt) window.lastNotifiedResetAt = undefined;
      if (existing) Object.assign(existing, window);
      else registry.windows.push(window);
      if (window.status === "available" || window.status === "exhausted") {
        const signalId = `codex-quota-reset:${accountId}:${id}`;
        for (const notification of registry.notifications) {
          if (notification.signalId !== signalId || notification.status !== "open") continue;
          notification.status = "resolved";
          notification.resolvedAt = now;
          notification.updatedAt = now;
        }
      }
      return window;
    });
  }

  async reconcile(at = new Date()): Promise<QuotaNotification[]> {
    return await this.mutate((registry) => {
      const now = at.toISOString();
      const created: QuotaNotification[] = [];
      const enabledAccounts = new Map(registry.accounts.filter((account) => account.enabled).map((account) => [account.id, account]));
      for (const window of registry.windows) {
        const account = enabledAccounts.get(window.accountId);
        if (!account || window.status !== "exhausted" || !window.resetAt || Date.parse(window.resetAt) > at.getTime()) continue;
        if (window.lastNotifiedResetAt === window.resetAt) continue;
        window.status = "available_unverified";
        window.lastNotifiedResetAt = window.resetAt;
        window.updatedAt = now;
        const signalId = `codex-quota-reset:${account.id}:${window.id}`;
        const notification: QuotaNotification = {
          id: randomBytes(8).toString("hex"),
          projectId: "accounts",
          signalId,
          severity: "info",
          title: `Codex quota may be available: ${account.displayName}`,
          detail: `${window.label} reached its recorded reset time ${window.resetAt}. Source: ${window.source}; confidence: ${window.confidence}.`,
          command: `/supervise quota available ${account.id} ${window.id}`,
          status: "open",
          deliveryStatus: "pending",
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
          occurrenceCount: 1
        };
        registry.notifications.push(notification);
        created.push(notification);
      }
      return created;
    });
  }

  async recordObservation(input: RecordQuotaObservationInput): Promise<QuotaObservationRecord> {
    return await this.mutate((registry) => {
      if (!registry.accounts.some((account) => account.id === input.accountId)) throw new Error(`Account "${input.accountId}" was not found.`);
      const record: QuotaObservationRecord = {
        ...input,
        id: randomBytes(8).toString("hex"),
        evidenceHash: input.evidenceHash.slice(0, 128),
        parserVersion: input.parserVersion.slice(0, 40),
        reason: cleanText(input.reason, 240),
        createdAt: nowIso()
      };
      registry.observations.push(record);
      return record;
    });
  }

  async registerLogSource(input: RegisterQuotaLogSourceInput): Promise<QuotaLogSource> {
    const id = input.id.trim();
    const accountId = input.accountId.trim();
    if (!WINDOW_ID_RE.test(id)) throw new Error("Log source id must use 1-64 letters, numbers, underscores, or hyphens.");
    if (!input.file.trim()) throw new Error("Log source file is required.");
    return await this.mutate(async (registry) => {
      if (!registry.accounts.some((account) => account.id === accountId)) throw new Error(`Account "${accountId}" was not found.`);
      const now = nowIso();
      const existing = registry.logSources.find((source) => source.id === id);
      if (existing && existing.accountId !== accountId) throw new Error(`Log source "${id}" already belongs to another account.`);
      const source: QuotaLogSource = {
        id,
        accountId,
        file: path.resolve(input.file),
        enabled: input.enabled ?? existing?.enabled ?? true,
        windowId: cleanText(input.windowId, 64) ?? existing?.windowId,
        quotaType: input.quotaType ?? existing?.quotaType,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      const fileChanged = Boolean(existing && existing.file !== source.file);
      if (existing) {
        if (fileChanged) registry.logCursors = registry.logCursors.filter((cursor) => cursor.sourceId !== id);
        Object.assign(existing, source);
      } else registry.logSources.push(source);
      if ((!existing || fileChanged) && input.startAt !== "beginning") {
        try {
          const stat = await fs.stat(source.file);
          registry.logCursors.push({
            sourceId: source.id,
            fileId: `${stat.dev}:${stat.ino}`,
            offset: stat.size,
            size: stat.size,
            updatedAt: now
          });
        } catch {
          // The periodic watcher records a sanitized error until the file appears.
        }
      }
      return source;
    });
  }

  async removeLogSource(id: string): Promise<void> {
    const sourceId = id.trim();
    await this.mutate((registry) => {
      if (!registry.logSources.some((source) => source.id === sourceId)) throw new Error(`Log source "${sourceId}" was not found.`);
      registry.logSources = registry.logSources.filter((source) => source.id !== sourceId);
      registry.logCursors = registry.logCursors.filter((cursor) => cursor.sourceId !== sourceId);
    });
  }

  async updateLogCursor(cursor: QuotaLogCursor): Promise<QuotaLogCursor> {
    return await this.mutate((registry) => {
      const existing = registry.logCursors.find((entry) => entry.sourceId === cursor.sourceId);
      if (existing) {
        Object.assign(existing, cursor);
        if (!cursor.lastError) {
          existing.lastError = undefined;
          existing.lastErrorAt = undefined;
        }
      }
      else registry.logCursors.push(cursor);
      return cursor;
    });
  }

  async listNotifications(status?: QuotaNotificationStatus): Promise<QuotaNotification[]> {
    const notifications = (await this.read()).notifications;
    return status ? notifications.filter((notification) => notification.status === status) : notifications;
  }

  async listNotificationOutbox(): Promise<QuotaNotification[]> {
    return (await this.listNotifications("open"))
      .filter((notification) => notification.deliveryStatus !== "delivered")
      .slice(-20)
      .reverse();
  }

  async markNotificationDelivery(id: string, status: "delivered" | "failed", error?: string): Promise<QuotaNotification | undefined> {
    return await this.mutate((registry) => {
      const notification = registry.notifications.find((entry) => entry.id === id || entry.signalId === id);
      if (!notification) return undefined;
      const now = nowIso();
      notification.deliveryStatus = status;
      notification.deliveryAttempts = (notification.deliveryAttempts ?? 0) + 1;
      notification.lastDeliveryAt = now;
      notification.deliveryError = status === "failed" ? cleanText(error, 500) ?? "delivery failed" : undefined;
      notification.updatedAt = now;
      return notification;
    });
  }

  async acknowledgeNotification(id: string, acknowledgedBy = "human"): Promise<QuotaNotification | undefined> {
    return await this.mutate((registry) => {
      const notification = registry.notifications.find((entry) => entry.id === id || entry.signalId === id);
      if (!notification) return undefined;
      const now = nowIso();
      notification.status = "acknowledged";
      notification.acknowledgedAt = now;
      notification.acknowledgedBy = cleanText(acknowledgedBy, 80) ?? "human";
      notification.updatedAt = now;
      return notification;
    });
  }

  async acknowledgeOpenNotifications(acknowledgedBy = "human"): Promise<QuotaNotification[]> {
    return await this.mutate((registry) => {
      const now = nowIso();
      const changed = registry.notifications.filter((notification) => notification.status === "open");
      for (const notification of changed) {
        notification.status = "acknowledged";
        notification.acknowledgedAt = now;
        notification.acknowledgedBy = cleanText(acknowledgedBy, 80) ?? "human";
        notification.updatedAt = now;
      }
      return changed;
    });
  }

  async renderText(): Promise<string> {
    const registry = await this.read();
    if (registry.accounts.length === 0) return "No Codex accounts registered. Use /supervise account add <id> [name].";
    return registry.accounts.map((account) => {
      const windows = registry.windows.filter((window) => window.accountId === account.id);
      return [
        `${account.id} (${account.displayName}) [${account.accountType}${account.enabled ? "" : ", disabled"}]`,
        ...(windows.length > 0
          ? windows.map((window) => `  ${window.id}: ${window.status}, reset ${window.resetAt ?? "unknown"}, ${window.source}/${window.confidence}`)
          : ["  no quota windows"])
      ].join("\n");
    }).join("\n\n");
  }
}

export const quotaParsers = {
  accountType: normalizeAccountType,
  quotaType: normalizeQuotaType,
  quotaStatus: normalizeQuotaStatus,
  source: normalizeQuotaSource,
  confidence: normalizeConfidence
};
