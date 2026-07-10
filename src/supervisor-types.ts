import type { CodexAccount, QuotaLogCursor, QuotaLogSource, QuotaWindow } from "./quota.js";

export type SupervisorHealth = "ok" | "watch" | "blocked";
export type TaskStatus = "running" | "ok" | "failed" | "timeout";
export type WorkerStatus = "unknown" | "working" | "waiting" | "idle" | "stuck" | "done";
export type WorkerStateSource = "file" | "missing" | "invalid";
export type InstructionStatus = "pending" | "approved" | "rejected" | "dispatched";
export type WorkerInstructionStatus = "received" | "started" | "completed" | "failed" | "ignored";
export type WorkerControlMode = "active" | "pause_requested" | "paused" | "resume_requested";
export type InstructionResolutionStatus = "resolved" | "superseded" | "closed";

export type AuditLogEntry = {
  event: string;
  at: string;
  payload?: unknown;
};

export type AuditLogQuery = {
  event?: string;
  from?: string;
  to?: string;
  limit?: number;
};

export type AuditRetentionResult = {
  file: string;
  before: number;
  after: number;
  removed: number;
  cutoffAt: string;
};

export type CodexProviderMetadata = {
  id: string;
  baseUrl: string;
  envKey: string;
  wireApi?: "responses" | "chat";
};

export type WorkerRuntimeConfig = {
  enabled?: boolean;
  workerId?: string;
  model?: string;
  profile?: string;
  sandbox?: "read-only" | "workspace-write";
  pollIntervalMs?: number;
  timeoutMs?: number;
  provider?: CodexProviderMetadata;
};

export type WorkerRuntimeStatus = {
  enabled: boolean;
  running: boolean;
  workerId: string;
  model?: string;
  profile?: string;
  providerId?: string;
  sandbox: "read-only" | "workspace-write";
  startedAt?: string;
  stoppedAt?: string;
  lastPollAt?: string;
  lastError?: string;
};

export type SupervisorCommand = {
  title: string;
  command: string;
  timeoutMs?: number;
};

export type SupervisorConfig = {
  projectId?: string;
  projectDir?: string;
  stateFile?: string;
  workerStateFile?: string;
  workerInboxFile?: string;
  workerOutboxFile?: string;
  auditFile?: string;
  projectRegistryFile?: string;
  accountRegistryFile?: string;
  defaultWorkerId?: string;
  host?: string;
  port?: number;
  publicUrl?: string;
  token?: string;
  autoStartServer?: boolean;
  scanIntervalMs?: number;
  staleAfterMs?: number;
  instructionAckTimeoutMs?: number;
  instructionProgressTimeoutMs?: number;
  maxFiles?: number;
  maxHistory?: number;
  maxInstructions?: number;
  maxTaskLogChars?: number;
  commandTimeoutMs?: number;
  notificationCooldownMs?: number;
  notificationWebhookUrl?: string;
  notificationWebhookBearerToken?: string;
  notificationDeliveryIntervalMs?: number;
  notificationDeliveryTimeoutMs?: number;
  maxNotifications?: number;
  auditRetentionDays?: number;
  maxAuditEntries?: number;
  watchedPorts?: number[];
  logFiles?: string[];
  ignoreDirs?: string[];
  allowedCommands?: Record<string, string | SupervisorCommand>;
  workerRuntime?: WorkerRuntimeConfig;
};

export type FileScanSummary = {
  totalFiles: number;
  skipped: number;
  newest: Array<{ path: string; modifiedAt: string; size: number }>;
  recent: Array<{ path: string; modifiedAt: string; size: number }>;
  byExtension: Record<string, number>;
};

export type GitSummary = {
  available: boolean;
  branch?: string;
  upstream?: string;
  status?: string;
  changedFiles?: number;
  aheadBy?: number;
  behindBy?: number;
  lastCommit?: string;
  diffStat?: string;
  changes?: Array<{ path: string; status: string; staged: boolean; untracked: boolean }>;
  error?: string;
};

export type ProjectReviewSummary = {
  readiness: "clean" | "fix_required" | "review_required" | "ready_to_commit";
  summary: string;
  recommendation: string;
  changedFiles: number;
  stagedFiles: number;
  untrackedFiles: number;
  failedTasks: Array<{ name: string; status: TaskStatus; finishedAt?: string; excerpt: string }>;
  logFindings: Array<{ path: string; excerpt: string }>;
};

export type PortSummary = {
  port: number;
  open: boolean;
};

export type TaskRecord = {
  id: string;
  name: string;
  command: string;
  startedAt: string;
  finishedAt?: string;
  status: TaskStatus;
  exitCode?: number | null;
  durationMs?: number;
  log: string;
};

export type WorkerPlanItem = {
  step: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
};

export type WorkerState = {
  projectId: string;
  workerId: string;
  status: WorkerStatus;
  source: WorkerStateSource;
  goal?: string;
  currentStep?: string;
  plan: WorkerPlanItem[];
  lastProgressAt?: string;
  lastActivityAt?: string;
  needsUserApproval: boolean;
  blocker?: string | null;
  updatedAt: string;
  error?: string;
};

export type WorkerHeartbeatUpdate = {
  workerId?: string;
  status?: WorkerStatus;
  goal?: string;
  currentStep?: string;
  plan?: unknown;
  lastProgressAt?: string;
  lastActivityAt?: string;
  needsUserApproval?: boolean;
  blocker?: string | null;
  markProgress?: boolean;
};

export type SupervisorInstruction = {
  id: string;
  projectId: string;
  targetWorker: string;
  createdBy: "human" | "supervisor";
  status: InstructionStatus;
  instruction: string;
  source: "mobile" | "http" | "system";
  kind?: "work" | "pause" | "resume";
  createdAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  dispatchedAt?: string;
  rejectReason?: string;
  workerStatus?: WorkerInstructionStatus;
  workerMessage?: string;
  workerUpdatedAt?: string;
  resolutionStatus?: InstructionResolutionStatus;
  resolutionAt?: string;
  resolutionBy?: string;
  resolutionNote?: string;
  supersededByInstructionId?: string;
};

export type WorkerControlState = {
  mode: WorkerControlMode;
  instructionId?: string;
  requestedAt?: string;
  changedAt?: string;
  requestedBy?: string;
};

export type WorkerInstructionEvent = {
  instructionId: string;
  projectId?: string;
  workerId?: string;
  status: WorkerInstructionStatus;
  message?: string;
  at: string;
};

export type WorkerInboxInstruction = {
  id: string;
  projectId: string;
  targetWorker: string;
  instruction: string;
  kind?: "work" | "pause" | "resume";
  createdAt: string;
  approvedAt?: string;
  dispatchedAt: string;
  workerStatus?: WorkerInstructionStatus;
  workerMessage?: string;
  workerUpdatedAt?: string;
};

export type ProjectRegistryEntry = {
  id: string;
  name?: string;
  projectDir: string;
  stateFile?: string;
  workerStateFile?: string;
  workerInboxFile?: string;
  workerOutboxFile?: string;
  auditFile?: string;
  addedAt: string;
  lastSeenAt?: string;
};

export type ProjectRegistry = {
  activeProjectId?: string;
  projects: ProjectRegistryEntry[];
};

export type SupervisorNextAction = {
  id: string;
  priority: "low" | "medium" | "high";
  title: string;
  detail: string;
  command?: string;
};

export type SupervisionSignal = {
  id: string;
  severity: "info" | "watch" | "critical";
  title: string;
  detail: string;
  command?: string;
};

export type SupervisorNotificationStatus = "open" | "acknowledged" | "resolved";
export type SupervisorNotificationDeliveryStatus = "pending" | "delivered" | "failed";

export type SupervisorNotification = {
  id: string;
  projectId: string;
  signalId: string;
  severity: "info" | "watch" | "critical";
  title: string;
  detail: string;
  command?: string;
  status: SupervisorNotificationStatus;
  deliveryStatus?: SupervisorNotificationDeliveryStatus;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  deliveryAttempts?: number;
  lastDeliveryAt?: string;
  deliveryError?: string;
  sourceSnapshotId?: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
};

export type SupervisorSnapshot = {
  id: string;
  projectDir: string;
  scannedAt: string;
  health: SupervisorHealth;
  summary: string;
  risks: string[];
  fileScan: FileScanSummary;
  git: GitSummary;
  packageScripts: string[];
  ports: PortSummary[];
  logTails: Array<{ path: string; text: string; error?: string }>;
  tasks: TaskRecord[];
  worker: WorkerState;
  instructions: SupervisorInstruction[];
  nextActions: SupervisorNextAction[];
  signals: SupervisionSignal[];
  projects: ProjectRegistry;
  review?: ProjectReviewSummary;
};

export type SupervisorState = {
  token?: string;
  snapshots: SupervisorSnapshot[];
  tasks: TaskRecord[];
  instructions: SupervisorInstruction[];
  notifications: SupervisorNotification[];
  control?: WorkerControlState;
};

export type ProjectSupervisionSummary = {
  projectId: string;
  name?: string;
  projectDir: string;
  health: SupervisorHealth;
  scannedAt: string;
  summary: string;
  openAlerts: number;
  criticalAlerts: number;
  scanError?: string;
};

export type SupervisorOverview = {
  activeProject: ProjectRegistryEntry;
  snapshot: SupervisorSnapshot;
  registry: ProjectRegistry;
  projectSummaries: ProjectSupervisionSummary[];
  commands: string[];
  pendingInstructions: SupervisorInstruction[];
  recentInstructions: SupervisorInstruction[];
  nextActions: SupervisorNextAction[];
  signals: SupervisionSignal[];
  notifications: SupervisorNotification[];
  control: WorkerControlState;
  workerRuntime?: WorkerRuntimeStatus;
  accounts: CodexAccount[];
  quotaWindows: QuotaWindow[];
  quotaLogSources: QuotaLogSource[];
  quotaLogCursors: QuotaLogCursor[];
  panelUrl: string;
};
