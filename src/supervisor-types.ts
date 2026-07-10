import type { CodexAccount, QuotaLogCursor, QuotaLogSource, QuotaWindow } from "./quota.js";

export type SupervisorHealth = "ok" | "watch" | "blocked";
export type TaskStatus = "running" | "ok" | "failed" | "timeout";
export type WorkerStatus = "unknown" | "working" | "waiting" | "idle" | "stuck" | "done";
export type WorkerStateSource = "file" | "missing" | "invalid";
export type InstructionStatus = "pending" | "approved" | "rejected" | "dispatched";
export type WorkerInstructionStatus = "received" | "started" | "completed" | "failed" | "ignored";

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
  maxFiles?: number;
  maxHistory?: number;
  maxInstructions?: number;
  maxTaskLogChars?: number;
  commandTimeoutMs?: number;
  notificationCooldownMs?: number;
  maxNotifications?: number;
  watchedPorts?: number[];
  logFiles?: string[];
  ignoreDirs?: string[];
  allowedCommands?: Record<string, string | SupervisorCommand>;
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
  error?: string;
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
  createdAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  dispatchedAt?: string;
  rejectReason?: string;
  workerStatus?: WorkerInstructionStatus;
  workerMessage?: string;
  workerUpdatedAt?: string;
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
};

export type SupervisorOverview = {
  activeProject: ProjectRegistryEntry;
  snapshot: SupervisorSnapshot;
  registry: ProjectRegistry;
  commands: string[];
  pendingInstructions: SupervisorInstruction[];
  recentInstructions: SupervisorInstruction[];
  nextActions: SupervisorNextAction[];
  signals: SupervisionSignal[];
  notifications: SupervisorNotification[];
  accounts: CodexAccount[];
  quotaWindows: QuotaWindow[];
  quotaLogSources: QuotaLogSource[];
  quotaLogCursors: QuotaLogCursor[];
  panelUrl: string;
};

