import type { IncomingMessage, ServerResponse } from "node:http";
import { quotaParsers } from "./quota.js";
import type { ProjectSupervisor, ProjectSupervisorHub } from "./supervisor.js";
import type { InstructionStatus, SupervisorNotificationStatus } from "./supervisor-types.js";
import { renderDashboardHtml } from "./supervisor-dashboard.js";
import {
  establishDashboardSession,
  isAuthorizedRequest,
  json,
  readBodyJson,
  stripUrlToken
} from "./supervisor-http.js";

type ControllerTarget =
  | {
      kind: "project";
      supervisor: ProjectSupervisor;
      ensureToken: () => Promise<string>;
    }
  | {
      kind: "hub";
      supervisor: ProjectSupervisorHub;
      ensureToken: () => Promise<string>;
      rememberToken: (token: string) => void;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseWorkerStatus(value: unknown) {
  return value === "unknown" || value === "working" || value === "waiting" || value === "idle" || value === "stuck" || value === "done"
    ? value
    : undefined;
}

function parseWorkerInstructionStatus(value: unknown) {
  return value === "received" || value === "started" || value === "completed" || value === "failed" || value === "ignored"
    ? value
    : undefined;
}

export async function handleSupervisorHttp(
  target: ControllerTarget,
  req: IncomingMessage,
  res: ServerResponse,
  token = ""
): Promise<boolean> {
  const authToken = token || await target.ensureToken();
  if (target.kind === "hub") target.rememberToken(authToken);

  const parsed = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const originalPath = parsed.pathname;
  const routePrefix = originalPath.startsWith("/plugins/project-supervisor") ? "/plugins/project-supervisor" : "";
  if (parsed.pathname.startsWith("/plugins/project-supervisor")) {
    parsed.pathname = parsed.pathname.replace(/^\/plugins\/project-supervisor/, "") || "/";
  }
  if (req.method === "GET" && parsed.pathname === "/" && establishDashboardSession(res, parsed, authToken, originalPath)) return true;
  if (!isAuthorizedRequest(req, parsed, authToken)) {
    json(res, 401, { error: "unauthorized" });
    return true;
  }
  if (req.method === "GET" && parsed.pathname === "/") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(renderDashboardHtml(routePrefix));
    return true;
  }

  const supervisor = target.supervisor;
  if (req.method === "GET" && parsed.pathname === "/api/overview") {
    json(res, 200, await supervisor.getOverview());
    return true;
  }
  if (req.method === "GET" && parsed.pathname === "/api/status") {
    if (target.kind === "hub") {
      const active = await target.supervisor.getActiveSupervisor();
      json(res, 200, {
        snapshot: await active.latest(),
        commands: Object.keys(active.getConfig().allowedCommands),
        panelUrl: stripUrlToken(target.supervisor.getPanelUrl()),
        registry: await target.supervisor.readProjectRegistry()
      });
    } else {
      json(res, 200, {
        snapshot: await target.supervisor.latest(),
        commands: Object.keys(target.supervisor.getConfig().allowedCommands),
        panelUrl: stripUrlToken(target.supervisor.getPanelUrl())
      });
    }
    return true;
  }
  if (req.method === "GET" && parsed.pathname === "/api/worker") {
    json(res, 200, { worker: await supervisor.getWorkerState(), control: await supervisor.getControlState() });
    return true;
  }
  if (req.method === "POST" && parsed.pathname === "/api/worker-heartbeat") {
    const body = await readBodyJson(req);
    if (!isRecord(body)) throw new Error("Worker heartbeat body must be an object.");
    const status = body.status === undefined ? undefined : parseWorkerStatus(body.status);
    if (body.status !== undefined && !status) throw new Error("A valid worker status is required.");
    json(res, 200, { worker: await supervisor.updateWorkerHeartbeat({
      workerId: optionalString(body.workerId),
      status,
      goal: optionalString(body.goal),
      currentStep: optionalString(body.currentStep) ?? optionalString(body.step),
      plan: body.plan,
      lastProgressAt: optionalString(body.lastProgressAt),
      lastActivityAt: optionalString(body.lastActivityAt),
      needsUserApproval: typeof body.needsUserApproval === "boolean" ? body.needsUserApproval : undefined,
      blocker: body.blocker === null ? null : optionalString(body.blocker),
      markProgress: body.markProgress === true
    }) });
    return true;
  }
  if (req.method === "GET" && parsed.pathname === "/api/worker-inbox") {
    const includeAcknowledged = parsed.searchParams.get("includeAcknowledged") === "1" || parsed.searchParams.get("includeAcknowledged") === "true";
    const workerId = parsed.searchParams.get("workerId") ?? undefined;
    json(res, 200, { instructions: await supervisor.listWorkerInbox({ workerId, includeAcknowledged }) });
    return true;
  }
  if (req.method === "POST" && parsed.pathname === "/api/worker-ack") {
    const body = await readBodyJson(req);
    const instructionId = isRecord(body) && typeof body.instructionId === "string"
      ? body.instructionId
      : isRecord(body) && typeof body.id === "string" ? body.id : "";
    const status = parseWorkerInstructionStatus(isRecord(body) ? body.status : undefined);
    if (!status) throw new Error("A valid worker instruction status is required.");
    const message = isRecord(body) && typeof body.message === "string" ? body.message : undefined;
    const workerId = isRecord(body) && typeof body.workerId === "string" ? body.workerId : undefined;
    json(res, 200, { event: await supervisor.acknowledgeWorkerInstruction({ instructionId, status, message, workerId }) });
    return true;
  }
  if (req.method === "GET" && parsed.pathname === "/api/instructions") {
    const status = parsed.searchParams.get("status");
    const parsedStatus: InstructionStatus | undefined =
      status === "pending" || status === "approved" || status === "rejected" || status === "dispatched" ? status : undefined;
    json(res, 200, { instructions: await supervisor.listInstructions(parsedStatus) });
    return true;
  }
  if (req.method === "GET" && parsed.pathname === "/api/audit") {
    const rawLimit = parsed.searchParams.get("limit");
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error("Audit limit must be a positive integer.");
    json(res, 200, { entries: await supervisor.queryAuditLog({
      event: parsed.searchParams.get("event") ?? undefined,
      from: parsed.searchParams.get("from") ?? undefined,
      to: parsed.searchParams.get("to") ?? undefined,
      limit
    }) });
    return true;
  }
  if (req.method === "POST" && parsed.pathname === "/api/maintenance/history") {
    const body = await readBodyJson(req);
    const actor = isRecord(body) ? optionalString(body.actor) ?? "http" : "http";
    json(res, 200, { result: await supervisor.maintainHistory(actor) });
    return true;
  }
  if (req.method === "GET" && parsed.pathname === "/api/notifications") {
    const status = parsed.searchParams.get("status");
    const parsedStatus: SupervisorNotificationStatus | undefined =
      status === "open" || status === "acknowledged" || status === "resolved" ? status : undefined;
    json(res, 200, { notifications: await supervisor.listNotifications(parsedStatus) });
    return true;
  }
  if (req.method === "GET" && parsed.pathname === "/api/notification-outbox") {
    json(res, 200, { notifications: await supervisor.listNotificationOutbox() });
    return true;
  }
  if (req.method === "POST" && parsed.pathname === "/api/mark-notification-delivery") {
    const body = await readBodyJson(req);
    const id = isRecord(body) && typeof body.id === "string" ? body.id : "";
    const status = isRecord(body) && body.status === "delivered" ? "delivered" : isRecord(body) && body.status === "failed" ? "failed" : undefined;
    if (!status) throw new Error("Delivery status must be delivered or failed.");
    const error = isRecord(body) && typeof body.error === "string" ? body.error : undefined;
    json(res, 200, { notification: await supervisor.markNotificationDelivery({ id, status, error }) });
    return true;
  }
  if (req.method === "POST" && parsed.pathname === "/api/ack-notification") {
    const body = await readBodyJson(req);
    const id = isRecord(body) && typeof body.id === "string" ? body.id : "";
    const acknowledgedBy = isRecord(body) && typeof body.acknowledgedBy === "string" ? body.acknowledgedBy : "human";
    json(res, 200, { notification: await supervisor.acknowledgeNotification(id, acknowledgedBy) });
    return true;
  }
  if (req.method === "POST" && parsed.pathname === "/api/ack-notifications") {
    const body = await readBodyJson(req);
    const acknowledgedBy = isRecord(body) && typeof body.acknowledgedBy === "string" ? body.acknowledgedBy : "human";
    json(res, 200, { notifications: await supervisor.acknowledgeOpenNotifications(acknowledgedBy) });
    return true;
  }
  if (req.method === "GET" && parsed.pathname === "/api/projects") {
    json(res, 200, { registry: await supervisor.readProjectRegistry() });
    return true;
  }

  if (target.kind === "hub") {
    const hub = target.supervisor;
    if (req.method === "GET" && parsed.pathname === "/api/accounts") {
      json(res, 200, await hub.getQuotaRegistry());
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/accounts/register") {
      const body = await readBodyJson(req);
      if (!isRecord(body)) throw new Error("Account body must be an object.");
      const account = await hub.registerAccount({
        id: optionalString(body.id) ?? "",
        displayName: optionalString(body.displayName),
        accountType: body.accountType === undefined ? undefined : quotaParsers.accountType(body.accountType),
        workspaceName: optionalString(body.workspaceName),
        timezone: optionalString(body.timezone),
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined
      });
      json(res, 200, { account, registry: await hub.getQuotaRegistry() });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/accounts/remove") {
      const body = await readBodyJson(req);
      const id = isRecord(body) ? optionalString(body.id) ?? "" : "";
      await hub.removeAccount(id);
      json(res, 200, { removed: id, registry: await hub.getQuotaRegistry() });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/quotas/set") {
      const body = await readBodyJson(req);
      if (!isRecord(body)) throw new Error("Quota body must be an object.");
      const source = body.source === undefined ? undefined : quotaParsers.source(body.source);
      const window = await hub.setQuota({
        accountId: optionalString(body.accountId) ?? "",
        id: optionalString(body.id) ?? "",
        label: optionalString(body.label),
        quotaType: body.quotaType === undefined ? undefined : quotaParsers.quotaType(body.quotaType),
        status: body.status === undefined ? undefined : quotaParsers.quotaStatus(body.status),
        remaining: body.remaining === null ? null : typeof body.remaining === "number" ? body.remaining : undefined,
        resetAt: body.resetAt === null ? null : optionalString(body.resetAt),
        observedAt: optionalString(body.observedAt),
        source,
        confidence: body.confidence === undefined ? undefined : quotaParsers.confidence(body.confidence, source ?? "manual")
      });
      json(res, 200, { window, registry: await hub.getQuotaRegistry() });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/quotas/observe") {
      const body = await readBodyJson(req);
      if (!isRecord(body)) throw new Error("Quota observation body must be an object.");
      const result = await hub.observeQuotaSignal({
        accountId: optionalString(body.accountId) ?? "",
        text: optionalString(body.text) ?? "",
        observedAt: optionalString(body.observedAt),
        windowId: optionalString(body.windowId),
        quotaType: body.quotaType === undefined ? undefined : quotaParsers.quotaType(body.quotaType)
      });
      json(res, result.observation.matched ? 200 : 202, { ...result, registry: await hub.getQuotaRegistry() });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/quota-log-sources/register") {
      const body = await readBodyJson(req);
      if (!isRecord(body)) throw new Error("Quota log source body must be an object.");
      const source = await hub.registerQuotaLogSource({
        id: optionalString(body.id) ?? "",
        accountId: optionalString(body.accountId) ?? "",
        file: optionalString(body.file) ?? "",
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        windowId: optionalString(body.windowId),
        quotaType: body.quotaType === undefined ? undefined : quotaParsers.quotaType(body.quotaType),
        startAt: body.startAt === "beginning" ? "beginning" : body.startAt === "end" ? "end" : undefined
      });
      json(res, 200, { source, registry: await hub.getQuotaRegistry() });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/quota-log-sources/remove") {
      const body = await readBodyJson(req);
      const id = isRecord(body) ? optionalString(body.id) ?? "" : "";
      await hub.removeQuotaLogSource(id);
      json(res, 200, { removed: id, registry: await hub.getQuotaRegistry() });
      return true;
    }
    if (req.method === "POST" && parsed.pathname === "/api/quota-log-sources/scan") {
      json(res, 200, { sources: await hub.scanQuotaLogs(), registry: await hub.getQuotaRegistry() });
      return true;
    }
  }

  if (req.method === "POST" && parsed.pathname === "/api/scan") {
    const snapshot = await supervisor.scan();
    json(res, 200, target.kind === "hub" ? { snapshot, registry: await supervisor.readProjectRegistry() } : { snapshot });
    return true;
  }
  if (req.method === "POST" && parsed.pathname === "/api/register-project") {
    if (target.kind === "hub") {
      const body = await readBodyJson(req);
      const projectDir = isRecord(body) && typeof body.projectDir === "string" ? body.projectDir : "";
      const projectId = isRecord(body) && typeof body.projectId === "string" ? body.projectId : undefined;
      const project = projectDir ? await target.supervisor.registerProject(projectDir, projectId) : await target.supervisor.registerCurrentProject();
      json(res, 200, { project, registry: await target.supervisor.readProjectRegistry() });
    } else {
      json(res, 200, { project: await target.supervisor.registerCurrentProject(), registry: await target.supervisor.readProjectRegistry() });
    }
    return true;
  }
  if (target.kind === "hub" && req.method === "POST" && parsed.pathname === "/api/activate-project") {
    const body = await readBodyJson(req);
    const id = isRecord(body) && typeof body.id === "string" ? body.id : isRecord(body) && typeof body.projectId === "string" ? body.projectId : "";
    const project = await target.supervisor.activateProject(id);
    json(res, 200, { project, registry: await target.supervisor.readProjectRegistry() });
    return true;
  }
  if (req.method === "POST" && parsed.pathname === "/api/run") {
    const body = await readBodyJson(req);
    const command = isRecord(body) && typeof body.command === "string" ? body.command : "";
    json(res, 200, { task: await supervisor.runAllowedCommand(command) });
    return true;
  }
  if (req.method === "POST" && parsed.pathname === "/api/propose") {
    const body = await readBodyJson(req);
    const instruction = isRecord(body) && typeof body.instruction === "string" ? body.instruction : "";
    json(res, 200, { instruction: await supervisor.createInstruction({ instruction, createdBy: "supervisor", source: "http" }) });
    return true;
  }
  if (req.method === "POST" && parsed.pathname === "/api/tell") {
    const body = await readBodyJson(req);
    const instruction = isRecord(body) && typeof body.instruction === "string" ? body.instruction : "";
    json(res, 200, { instruction: await supervisor.createInstruction({ instruction, createdBy: "human", source: "http", approve: true }) });
    return true;
  }
  if (req.method === "POST" && parsed.pathname === "/api/pause") {
    json(res, 200, { instruction: await supervisor.pauseWorker("human"), control: await supervisor.getControlState() });
    return true;
  }
  if (req.method === "POST" && parsed.pathname === "/api/resume") {
    json(res, 200, { instruction: await supervisor.resumeWorker("human"), control: await supervisor.getControlState() });
    return true;
  }
  if (req.method === "POST" && parsed.pathname === "/api/approve") {
    const body = await readBodyJson(req);
    const id = isRecord(body) && typeof body.id === "string" ? body.id : "";
    json(res, 200, { instruction: await supervisor.approveInstruction(id) });
    return true;
  }
  if (req.method === "POST" && parsed.pathname === "/api/approve-latest") {
    json(res, 200, { instruction: await supervisor.approveLatestPendingInstruction() });
    return true;
  }
  if (req.method === "POST" && parsed.pathname === "/api/reject") {
    const body = await readBodyJson(req);
    const id = isRecord(body) && typeof body.id === "string" ? body.id : "";
    const reason = isRecord(body) && typeof body.reason === "string" ? body.reason : undefined;
    json(res, 200, { instruction: await supervisor.rejectInstruction(id, reason) });
    return true;
  }
  if (req.method === "POST" && parsed.pathname === "/api/reject-latest") {
    const body = await readBodyJson(req);
    const reason = isRecord(body) && typeof body.reason === "string" ? body.reason : undefined;
    json(res, 200, { instruction: await supervisor.rejectLatestPendingInstruction(reason) });
    return true;
  }
  if (req.method === "POST" && parsed.pathname === "/api/resolve-instruction") {
    const body = await readBodyJson(req);
    if (!isRecord(body)) throw new Error("Instruction resolution body must be an object.");
    const id = optionalString(body.id) ?? "";
    const status = body.status === "resolved" || body.status === "superseded" || body.status === "closed" ? body.status : undefined;
    if (!status) throw new Error("Instruction resolution status must be resolved, superseded, or closed.");
    json(res, 200, { instruction: await supervisor.resolveInstruction(id, {
      status,
      resolvedBy: optionalString(body.resolvedBy) ?? "http",
      note: optionalString(body.note),
      supersededByInstructionId: optionalString(body.supersededByInstructionId)
    }) });
    return true;
  }

  json(res, 404, { error: "not found" });
  return true;
}
