import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ProjectSupervisorHub,
  type SupervisorCommand,
  type SupervisorConfig,
  type WorkerRuntimeConfig
} from "./supervisor.js";
import { NotificationDeliveryWorker, WebhookNotificationDeliveryAdapter } from "./notification-delivery.js";
import { stripUrlToken } from "./supervisor-http.js";
import { ManagedCodexWorkerRuntime } from "./managed-worker-runtime.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function configFromPluginApi(api: any): SupervisorConfig {
  const pluginConfig = isRecord(api?.pluginConfig)
    ? api.pluginConfig
    : isRecord(api?.config?.plugins?.entries?.["qq-study-router"]?.config)
      ? api.config.plugins.entries["qq-study-router"].config
      : isRecord(api?.config?.plugins?.["qq-study-router"])
        ? api.config.plugins["qq-study-router"]
        : {};
  const raw = isRecord(pluginConfig.projectSupervisor) ? pluginConfig.projectSupervisor : pluginConfig;
  const allowedCommands = isRecord(raw.allowedCommands) ? raw.allowedCommands as Record<string, string | SupervisorCommand> : undefined;
  const runtimeRaw = isRecord(raw.workerRuntime) ? raw.workerRuntime : {};
  const providerRaw = isRecord(runtimeRaw.provider) ? runtimeRaw.provider : undefined;
  const workerRuntime: WorkerRuntimeConfig = {
    enabled: typeof runtimeRaw.enabled === "boolean" ? runtimeRaw.enabled : undefined,
    workerId: typeof runtimeRaw.workerId === "string" ? runtimeRaw.workerId : undefined,
    model: typeof runtimeRaw.model === "string" ? runtimeRaw.model : undefined,
    profile: typeof runtimeRaw.profile === "string" ? runtimeRaw.profile : undefined,
    sandbox: runtimeRaw.sandbox === "read-only" || runtimeRaw.sandbox === "workspace-write" ? runtimeRaw.sandbox : undefined,
    pollIntervalMs: typeof runtimeRaw.pollIntervalMs === "number" ? runtimeRaw.pollIntervalMs : undefined,
    timeoutMs: typeof runtimeRaw.timeoutMs === "number" ? runtimeRaw.timeoutMs : undefined,
    provider: providerRaw && typeof providerRaw.id === "string" && typeof providerRaw.baseUrl === "string" && typeof providerRaw.envKey === "string"
      ? {
          id: providerRaw.id,
          baseUrl: providerRaw.baseUrl,
          envKey: providerRaw.envKey,
          wireApi: providerRaw.wireApi === "chat" || providerRaw.wireApi === "responses" ? providerRaw.wireApi : undefined
        }
      : undefined
  };
  return {
    projectId: typeof raw.projectId === "string" ? raw.projectId : undefined,
    projectDir: typeof raw.projectDir === "string" ? raw.projectDir : undefined,
    stateFile: typeof raw.stateFile === "string" ? raw.stateFile : undefined,
    workerStateFile: typeof raw.workerStateFile === "string" ? raw.workerStateFile : undefined,
    workerInboxFile: typeof raw.workerInboxFile === "string" ? raw.workerInboxFile : undefined,
    workerOutboxFile: typeof raw.workerOutboxFile === "string" ? raw.workerOutboxFile : undefined,
    auditFile: typeof raw.auditFile === "string" ? raw.auditFile : undefined,
    projectRegistryFile: typeof raw.projectRegistryFile === "string" ? raw.projectRegistryFile : undefined,
    accountRegistryFile: typeof raw.accountRegistryFile === "string" ? raw.accountRegistryFile : undefined,
    defaultWorkerId: typeof raw.defaultWorkerId === "string" ? raw.defaultWorkerId : undefined,
    host: typeof raw.host === "string" ? raw.host : undefined,
    publicUrl: typeof raw.publicUrl === "string" ? raw.publicUrl : undefined,
    token: typeof raw.token === "string" ? raw.token : undefined,
    port: typeof raw.port === "number" || typeof raw.port === "string" ? Number(raw.port) : undefined,
    autoStartServer: typeof raw.autoStartServer === "boolean" ? raw.autoStartServer : undefined,
    scanIntervalMs: typeof raw.scanIntervalMs === "number" ? raw.scanIntervalMs : undefined,
    staleAfterMs: typeof raw.staleAfterMs === "number" ? raw.staleAfterMs : undefined,
    instructionAckTimeoutMs: typeof raw.instructionAckTimeoutMs === "number" ? raw.instructionAckTimeoutMs : undefined,
    instructionProgressTimeoutMs: typeof raw.instructionProgressTimeoutMs === "number" ? raw.instructionProgressTimeoutMs : undefined,
    maxFiles: typeof raw.maxFiles === "number" ? raw.maxFiles : undefined,
    maxHistory: typeof raw.maxHistory === "number" ? raw.maxHistory : undefined,
    maxInstructions: typeof raw.maxInstructions === "number" ? raw.maxInstructions : undefined,
    maxNotifications: typeof raw.maxNotifications === "number" ? raw.maxNotifications : undefined,
    auditRetentionDays: typeof raw.auditRetentionDays === "number" ? raw.auditRetentionDays : undefined,
    maxAuditEntries: typeof raw.maxAuditEntries === "number" ? raw.maxAuditEntries : undefined,
    maxTaskLogChars: typeof raw.maxTaskLogChars === "number" ? raw.maxTaskLogChars : undefined,
    commandTimeoutMs: typeof raw.commandTimeoutMs === "number" ? raw.commandTimeoutMs : undefined,
    notificationCooldownMs: typeof raw.notificationCooldownMs === "number" ? raw.notificationCooldownMs : undefined,
    notificationWebhookUrl: typeof raw.notificationWebhookUrl === "string" ? raw.notificationWebhookUrl : undefined,
    notificationWebhookBearerToken: typeof raw.notificationWebhookBearerToken === "string" ? raw.notificationWebhookBearerToken : undefined,
    notificationDeliveryIntervalMs: typeof raw.notificationDeliveryIntervalMs === "number" ? raw.notificationDeliveryIntervalMs : undefined,
    notificationDeliveryTimeoutMs: typeof raw.notificationDeliveryTimeoutMs === "number" ? raw.notificationDeliveryTimeoutMs : undefined,
    watchedPorts: Array.isArray(raw.watchedPorts) ? raw.watchedPorts as number[] : undefined,
    logFiles: Array.isArray(raw.logFiles) ? raw.logFiles as string[] : undefined,
    ignoreDirs: Array.isArray(raw.ignoreDirs) ? raw.ignoreDirs as string[] : undefined,
    allowedCommands,
    workerRuntime
  };
}

let singleton: ProjectSupervisorHub | null = null;

export function getProjectSupervisorForTests(): ProjectSupervisorHub | null {
  return singleton;
}

export function registerProjectSupervisor(api: any): void {
  const config = configFromPluginApi(api);
  const supervisor = new ProjectSupervisorHub(config, api.logger ?? {});
  const workerRuntime = new ManagedCodexWorkerRuntime(
    supervisor,
    supervisor.getConfig().workerRuntime,
    supervisor.getConfig().projectDir,
    (message) => api.logger?.warn?.(`project-supervisor worker runtime: ${message}`)
  );
  let notificationDelivery: NotificationDeliveryWorker | null = null;
  supervisor.setWorkerRuntimeStatusProvider(() => workerRuntime.getStatus());
  singleton = supervisor;

  api.registerService?.({
    id: "project-supervisor-service",
    start: async () => {
      await supervisor.ensureStarted();
      workerRuntime.start();
      if (config.notificationWebhookUrl) {
        try {
          notificationDelivery = new NotificationDeliveryWorker(
            supervisor,
            new WebhookNotificationDeliveryAdapter({
              url: config.notificationWebhookUrl,
              bearerToken: config.notificationWebhookBearerToken,
              timeoutMs: config.notificationDeliveryTimeoutMs,
              panelUrl: stripUrlToken(supervisor.getPanelUrl())
            }),
            config.notificationDeliveryIntervalMs,
            Date.now,
            (error) => api.logger?.warn?.(`project-supervisor notification delivery pass failed: ${error instanceof Error ? error.message : String(error)}`)
          );
          notificationDelivery.start();
        } catch (error) {
          notificationDelivery = null;
          api.logger?.error?.(`project-supervisor notification delivery disabled: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    stop: async () => {
      workerRuntime.stop();
      notificationDelivery?.stop();
      notificationDelivery = null;
      await supervisor.stop();
    }
  });

  api.lifecycle?.registerRuntimeLifecycle?.({
    id: "project-supervisor-cleanup",
    cleanup: async () => {
      workerRuntime.stop();
      notificationDelivery?.stop();
      notificationDelivery = null;
      await supervisor.stop();
    }
  });

  api.registerHttpRoute?.({
    path: "/plugins/project-supervisor",
    auth: "gateway",
    match: "prefix",
    replaceExisting: true,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      return await supervisor.handleHttp(req, res);
    }
  });

  api.registerCommand?.({
    name: "supervise",
    nativeNames: { default: "supervise" },
    description: "Show or control the local Project Supervisor.",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      await supervisor.ensureStarted();
      const args = String(ctx.args ?? "").trim();
      if (!args || /^status$/i.test(args)) return { text: await supervisor.renderTextStatus(false) };
      if (/^ai$/i.test(args)) return { text: await supervisor.renderWorkerText() };
      if (/^(pending|instructions)$/i.test(args)) return { text: await supervisor.renderInstructionsText() };
      if (/^projects$/i.test(args)) return { text: await supervisor.renderProjectsText() };
      if (/^(accounts|quota|quotas)$/i.test(args)) return { text: await supervisor.renderAccountsText() };
      const addAccountMatch = /^account\s+add\s+([a-zA-Z0-9_-]{1,64})(?:\s+([\s\S]+))?$/i.exec(args);
      if (addAccountMatch) {
        const account = await supervisor.registerAccount({ id: addAccountMatch[1], displayName: addAccountMatch[2]?.trim() });
        return { text: `Registered Codex account ${account.id} (${account.displayName}). No credentials were stored.` };
      }
      const removeAccountMatch = /^account\s+remove\s+([a-zA-Z0-9_-]{1,64})$/i.exec(args);
      if (removeAccountMatch) {
        await supervisor.removeAccount(removeAccountMatch[1]);
        return { text: `Removed Codex account ${removeAccountMatch[1]} and its quota windows.` };
      }
      const observeQuotaMatch = /^quota\s+observe\s+([a-zA-Z0-9_-]{1,64})\s+([\s\S]+)$/i.exec(args);
      if (observeQuotaMatch) {
        const result = await supervisor.observeQuotaSignal({ accountId: observeQuotaMatch[1], text: observeQuotaMatch[2] });
        return {
          text: result.observation.matched
            ? `Observed ${observeQuotaMatch[1]}/${result.observation.windowId}: ${result.observation.status}, reset ${result.observation.resetAt ?? "unknown"}.`
            : `Quota signal was recorded but not applied: ${result.observation.reason ?? "unrecognized format"}.`
        };
      }
      const addQuotaWatchMatch = /^quota\s+watch\s+add\s+([a-zA-Z0-9_-]{1,64})\s+([a-zA-Z0-9_-]{1,64})\s+([\s\S]+)$/i.exec(args);
      if (addQuotaWatchMatch) {
        const source = await supervisor.registerQuotaLogSource({
          accountId: addQuotaWatchMatch[1],
          id: addQuotaWatchMatch[2],
          file: addQuotaWatchMatch[3].trim()
        });
        return { text: `Watching ${source.file} as ${source.id} for Codex account ${source.accountId}.` };
      }
      const removeQuotaWatchMatch = /^quota\s+watch\s+remove\s+([a-zA-Z0-9_-]{1,64})$/i.exec(args);
      if (removeQuotaWatchMatch) {
        await supervisor.removeQuotaLogSource(removeQuotaWatchMatch[1]);
        return { text: `Removed quota log source ${removeQuotaWatchMatch[1]}.` };
      }
      if (/^quota\s+watch\s+scan$/i.test(args)) {
        const summaries = await supervisor.scanQuotaLogs();
        return {
          text: summaries.length > 0
            ? summaries.map((summary) => `${summary.sourceId}: ${summary.linesRead} line(s), ${summary.candidates} candidate(s), ${summary.matched} matched${summary.error ? `, error: ${summary.error}` : ""}`).join("\n")
            : "No enabled quota log sources."
        };
      }
      const exhaustedQuotaMatch = /^quota\s+exhausted\s+([a-zA-Z0-9_-]{1,64})\s+([a-zA-Z0-9_-]{1,64})\s+([\s\S]+)$/i.exec(args);
      if (exhaustedQuotaMatch) {
        const window = await supervisor.setQuota({
          accountId: exhaustedQuotaMatch[1],
          id: exhaustedQuotaMatch[2],
          status: "exhausted",
          resetAt: exhaustedQuotaMatch[3].trim(),
          source: "manual",
          confidence: "observed"
        });
        return { text: `Recorded ${window.accountId}/${window.id} as exhausted; reset ${window.resetAt}.` };
      }
      const availableQuotaMatch = /^quota\s+available\s+([a-zA-Z0-9_-]{1,64})\s+([a-zA-Z0-9_-]{1,64})$/i.exec(args);
      if (availableQuotaMatch) {
        const window = await supervisor.setQuota({
          accountId: availableQuotaMatch[1],
          id: availableQuotaMatch[2],
          status: "available",
          resetAt: null,
          source: "manual",
          confidence: "observed"
        });
        return { text: `Marked ${window.accountId}/${window.id} as available.` };
      }
      if (/^review$/i.test(args)) {
        const overview = await supervisor.getOverview();
        const pending = overview.pendingInstructions.slice(-5).reverse();
        const recentExecution = overview.recentInstructions.filter((instruction) => instruction.status === "dispatched").slice(0, 5);
        return {
          text: [
            `Active project: ${overview.activeProject.id}`,
            `Health: ${overview.snapshot.health}`,
            `Worker: ${overview.snapshot.worker.workerId}:${overview.snapshot.worker.status}`,
            `Step: ${overview.snapshot.worker.currentStep ?? "(not reported)"}`,
            `Review decision: ${overview.snapshot.review?.readiness ?? "unavailable"}`,
            `Change summary: ${overview.snapshot.review?.summary ?? "refresh scan"}`,
            `Recommendation: ${overview.snapshot.review?.recommendation ?? "refresh scan"}`,
            `Diff stat: ${overview.snapshot.git.diffStat ?? "(none)"}`,
            "Failed task excerpts:",
            ...(overview.snapshot.review?.failedTasks.length
              ? overview.snapshot.review.failedTasks.map((task) => `- ${task.name}/${task.status}: ${task.excerpt}`)
              : ["- none"]),
            "Log findings:",
            ...(overview.snapshot.review?.logFindings.length
              ? overview.snapshot.review.logFindings.map((finding) => `- ${finding.path}: ${finding.excerpt}`)
              : ["- none"]),
            "Signals:",
            ...(overview.signals.length > 0
              ? overview.signals.map((signal) => `- [${signal.severity}] ${signal.title}: ${signal.detail}${signal.command ? ` (${signal.command})` : ""}`)
              : ["- none"]),
            "Alerts:",
            ...(overview.notifications.length > 0
              ? overview.notifications.map((notification) => `- [${notification.severity}] ${notification.id}/${notification.signalId}: ${notification.title}: ${notification.detail}`)
              : ["- none"]),
            "Next actions:",
            ...overview.nextActions.map((action) => `- [${action.priority}] ${action.title}: ${action.detail}${action.command ? ` (${action.command})` : ""}`),
            "Pending instructions:",
            ...(pending.length > 0
              ? pending.map((instruction) => `- ${instruction.id} -> ${instruction.targetWorker}: ${instruction.instruction}`)
              : ["- none"]),
            "Recent instruction execution:",
            ...(recentExecution.length > 0
              ? recentExecution.map((instruction) => `- ${instruction.id} -> ${instruction.targetWorker}: ${instruction.workerStatus ?? "awaiting_ack"}${instruction.resolutionStatus ? `/${instruction.resolutionStatus}` : ""}${instruction.workerMessage ? ` (${instruction.workerMessage})` : ""}`)
              : ["- none"])
          ].join("\n")
        };
      }
      if (/^(alerts|notifications)$/i.test(args)) {
        const notifications = (await supervisor.listNotifications("open")).slice(-8).reverse();
        return {
          text: notifications.length > 0
            ? notifications.map((notification) => [
              `${notification.id} [${notification.severity}] ${notification.signalId}`,
              notification.title,
              notification.detail,
              notification.command ? `command: ${notification.command}` : null,
              `seen: ${notification.lastSeenAt}, count: ${notification.occurrenceCount}`
            ].filter((line) => line !== null).join("\n")).join("\n\n")
            : "No open supervisor alerts."
        };
      }
      if (/^ack\s+(alerts?|notifications?|all)$/i.test(args)) {
        const notifications = await supervisor.acknowledgeOpenNotifications("mobile");
        return { text: `Acknowledged ${notifications.length} open supervisor alert(s).` };
      }
      const ackNotificationMatch = /^ack\s+([a-zA-Z0-9_-]+)$/i.exec(args);
      if (ackNotificationMatch) {
        const notification = await supervisor.acknowledgeNotification(ackNotificationMatch[1], "mobile");
        return { text: `Acknowledged alert ${notification.id} (${notification.signalId}).` };
      }
      const registerMatch = /^(register|register-project)(?:\s+([\s\S]+))?$/i.exec(args);
      if (registerMatch) {
        const projectDir = registerMatch[2]?.trim();
        const project = projectDir ? await supervisor.registerProject(projectDir) : await supervisor.registerCurrentProject();
        return { text: `Registered project ${project.id}:\n${project.projectDir}` };
      }
      const activateMatch = /^(activate|use)\s+([a-zA-Z0-9_-]+)$/i.exec(args);
      if (activateMatch) {
        const project = await supervisor.activateProject(activateMatch[2]);
        return { text: `Active project is now ${project.id}:\n${project.projectDir}` };
      }
      if (/^(scan|refresh)$/i.test(args)) return { text: await supervisor.renderTextStatus(true) };
      const auditMatch = /^audit(?:\s+([a-zA-Z0-9_-]+))?(?:\s+(\d+))?$/i.exec(args);
      if (auditMatch) {
        const entries = await supervisor.queryAuditLog({ event: auditMatch[1], limit: auditMatch[2] ? Number(auditMatch[2]) : 10 });
        return { text: entries.length
          ? entries.map((entry) => `${entry.at} ${entry.event} ${JSON.stringify(entry.payload)}`).join("\n")
          : "No matching audit entries." };
      }
      if (/^prune-history$/i.test(args)) {
        const result = await supervisor.maintainHistory("mobile");
        return { text: `History retention complete: removed ${result.removed}, retained ${result.after}, cutoff ${result.cutoffAt}.` };
      }
      if (/^(url|panel)$/i.test(args)) return { text: `Project Supervisor panel:\n${supervisor.getPanelUrl()}` };
      const proposeMatch = /^propose(?:\s+([\s\S]+))?$/i.exec(args);
      if (proposeMatch) {
        const instructionText = proposeMatch[1]?.trim();
        if (!instructionText) {
          const snapshot = await supervisor.latest();
          return {
            text: [
              "Recommended next actions:",
              ...snapshot.nextActions.map((action) => `- [${action.priority}] ${action.title}: ${action.detail}${action.command ? ` (${action.command})` : ""}`)
            ].join("\n")
          };
        }
        const instruction = await supervisor.createInstruction({ instruction: instructionText, createdBy: "supervisor", source: "mobile" });
        return { text: `Created pending instruction ${instruction.id}.\nApprove with /supervise approve ${instruction.id}` };
      }
      const tellMatch = /^tell\s+([\s\S]+)$/i.exec(args);
      if (tellMatch) {
        const instruction = await supervisor.createInstruction({ instruction: tellMatch[1], createdBy: "human", source: "mobile", approve: true });
        return { text: `Dispatched instruction ${instruction.id} to ${instruction.targetWorker}.` };
      }
      if (/^pause$/i.test(args)) {
        const instruction = await supervisor.pauseWorker("human");
        return { text: `Pause requested with instruction ${instruction.id}. Waiting for worker acknowledgement.` };
      }
      if (/^resume$/i.test(args)) {
        const instruction = await supervisor.resumeWorker("human");
        return { text: `Resume requested with instruction ${instruction.id}. Waiting for worker acknowledgement.` };
      }
      if (/^approve\s+latest$/i.test(args)) {
        const instruction = await supervisor.approveLatestPendingInstruction();
        return { text: `Approved and dispatched latest pending instruction ${instruction.id} to ${instruction.targetWorker}.` };
      }
      const approveMatch = /^approve\s+([a-f0-9]{8,32})$/i.exec(args);
      if (approveMatch) {
        const instruction = await supervisor.approveInstruction(approveMatch[1]);
        return { text: `Approved and dispatched ${instruction.id} to ${instruction.targetWorker}.` };
      }
      const rejectLatestMatch = /^reject\s+latest(?:\s+([\s\S]+))?$/i.exec(args);
      if (rejectLatestMatch) {
        const instruction = await supervisor.rejectLatestPendingInstruction(rejectLatestMatch[1]);
        return { text: `Rejected latest pending instruction ${instruction.id}.` };
      }
      const rejectMatch = /^reject\s+([a-f0-9]{8,32})(?:\s+([\s\S]+))?$/i.exec(args);
      if (rejectMatch) {
        const instruction = await supervisor.rejectInstruction(rejectMatch[1], rejectMatch[2]);
        return { text: `Rejected ${instruction.id}.` };
      }
      const resolveMatch = /^resolve\s+([a-f0-9]{8,32})(?:\s+([\s\S]+))?$/i.exec(args);
      if (resolveMatch) {
        const instruction = await supervisor.resolveInstruction(resolveMatch[1], { status: "resolved", resolvedBy: "mobile", note: resolveMatch[2] });
        return { text: `Marked instruction ${instruction.id} resolved.` };
      }
      const supersedeMatch = /^supersede\s+([a-f0-9]{8,32})\s+([a-f0-9]{8,32})(?:\s+([\s\S]+))?$/i.exec(args);
      if (supersedeMatch) {
        const instruction = await supervisor.resolveInstruction(supersedeMatch[1], { status: "superseded", resolvedBy: "mobile", supersededByInstructionId: supersedeMatch[2], note: supersedeMatch[3] });
        return { text: `Marked instruction ${instruction.id} superseded by ${instruction.supersededByInstructionId}.` };
      }
      const closeMatch = /^close\s+([a-f0-9]{8,32})(?:\s+([\s\S]+))?$/i.exec(args);
      if (closeMatch) {
        const instruction = await supervisor.resolveInstruction(closeMatch[1], { status: "closed", resolvedBy: "mobile", note: closeMatch[2] });
        return { text: `Closed instruction ${instruction.id}.` };
      }
      const runMatch = /^run\s+([a-zA-Z0-9_-]+)$/i.exec(args);
      if (runMatch) {
        const task = await supervisor.runAllowedCommand(runMatch[1]);
        return { text: `Started ${task.name} (${task.id}).\n${await supervisor.renderTextStatus(false)}` };
      }
      return {
        text: [
          "Project Supervisor commands:",
          "/supervise status",
          "/supervise ai",
          "/supervise review",
          "/supervise alerts",
          "/supervise ack alerts",
          "/supervise ack <alert-id-or-signal-id>",
          "/supervise projects",
          "/supervise register",
          "/supervise register <project-dir>",
          "/supervise activate <project-id>",
          "/supervise accounts",
          "/supervise account add <id> [display-name]",
          "/supervise account remove <id>",
          "/supervise quota observe <account-id> <limit-message>",
          "/supervise quota watch add <account-id> <source-id> <log-file>",
          "/supervise quota watch remove <source-id>",
          "/supervise quota watch scan",
          "/supervise quota exhausted <account-id> <window-id> <reset-at>",
          "/supervise quota available <account-id> <window-id>",
          "/supervise scan",
          "/supervise audit [event] [limit]",
          "/supervise prune-history",
          "/supervise propose",
          "/supervise propose <instruction>",
          "/supervise approve latest",
          "/supervise approve <instruction-id>",
          "/supervise reject latest",
          "/supervise reject <instruction-id>",
          "/supervise resolve <failed-or-ignored-id> [note]",
          "/supervise supersede <failed-or-ignored-id> <completed-replacement-id> [note]",
          "/supervise close <failed-or-ignored-id> [note]",
          "/supervise tell <instruction>",
          "/supervise pause",
          "/supervise resume",
          "/supervise url",
          "/supervise run build",
          "/supervise run test",
          `Allowed commands: ${Object.keys((await supervisor.getActiveSupervisor()).getConfig().allowedCommands).join(", ")}`
        ].join("\n")
      };
    }
  });
}
