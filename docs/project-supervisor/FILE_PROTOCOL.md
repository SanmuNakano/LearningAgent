# AI Project Supervisor File Protocol

This protocol lets the supervisor observe and command a worker AI without depending on one specific AI runtime.

By default, files live under each supervised project:

```text
.project-supervisor/
  worker-state.json
  inbox.jsonl
  outbox.jsonl
  audit.jsonl
  state.json
```

The directory is runtime state and should stay ignored by Git.

## Worker Heartbeat

The worker AI writes `.project-supervisor/worker-state.json`.

Example:

```json
{
  "projectId": "learning-agent",
  "workerId": "codex-main",
  "status": "working",
  "goal": "Improve AI Project Supervisor",
  "currentStep": "Run tests and update docs",
  "plan": [
    { "step": "Read implementation", "status": "completed" },
    { "step": "Patch supervisor", "status": "completed" },
    { "step": "Verify and commit", "status": "in_progress" }
  ],
  "lastProgressAt": "2026-07-09T11:10:00.000Z",
  "lastActivityAt": "2026-07-09T11:12:00.000Z",
  "needsUserApproval": false,
  "blocker": null,
  "updatedAt": "2026-07-09T11:12:00.000Z"
}
```

Supported worker statuses:

- `unknown`
- `working`
- `waiting`
- `idle`
- `stuck`
- `done`

Supported plan statuses:

- `pending`
- `in_progress`
- `completed`
- `blocked`

The worker AI can write heartbeat state directly, or use the helper API/CLI. Helper writes normalize plan items, trim text fields, preserve existing fields when omitted, refresh `lastActivityAt`, and refresh `lastProgressAt` when the update marks progress or changes meaningful status/goal/step/plan content.

## Instruction Inbox

The supervisor appends approved instructions to `.project-supervisor/inbox.jsonl`.

Each line is one JSON object:

```json
{"id":"abc123","projectId":"learning-agent","targetWorker":"codex-main","instruction":"Run tests and summarize failures.","kind":"work","createdAt":"2026-07-09T11:20:00.000Z","approvedAt":"2026-07-09T11:21:00.000Z","dispatchedAt":"2026-07-09T11:21:01.000Z"}
```

The worker AI may poll this file or let a runtime adapter consume it.

## Worker Outbox

The worker AI appends acknowledgement events to `.project-supervisor/outbox.jsonl`.

Each line is one JSON object:

```json
{"instructionId":"abc123","projectId":"learning-agent","workerId":"codex-main","status":"received","message":"Instruction received.","at":"2026-07-09T11:22:00.000Z"}
```

Supported instruction event statuses:

- `received`
- `started`
- `completed`
- `failed`
- `ignored`

The supervisor merges the latest outbox event into instruction status views. If an instruction reports `failed`, project health becomes `blocked` until the failure receives a Supervisor disposition. `resolved` records that the issue was verified as fixed, `superseded` links it to a completed replacement instruction, and `closed` records an explicit manual close. The original Worker result remains unchanged for audit history.

## Worker Adapter Helpers

The file-based adapter can report heartbeat state, read open inbox instructions, and write acknowledgement events.

HTTP:

- `POST /api/worker-heartbeat` writes `.project-supervisor/worker-state.json`.
- `GET /api/worker-inbox` returns non-terminal inbox instructions for the active project.
- `GET /api/worker-inbox?includeAcknowledged=1` includes completed, failed, and ignored instructions.
- `GET /api/worker-inbox?workerId=codex-main` filters by worker id.
- `POST /api/worker-ack` with `{ "id": "...", "status": "received", "message": "..." }` appends an outbox acknowledgement.

Heartbeat body example:

```json
{
  "workerId": "codex-main",
  "status": "working",
  "goal": "Implement supervisor alerts",
  "step": "Running tests",
  "plan": [
    { "step": "Patch code", "status": "completed" },
    { "step": "Run tests", "status": "in_progress" }
  ],
  "needsUserApproval": false,
  "blocker": null,
  "markProgress": true
}
```

CLI:

```bash
npm run supervisor:worker:inbox
node ./dist/supervisor.js --worker-heartbeat working --project D:\learn\openclaw-plugins --worker-id codex-main --goal "Implement supervisor alerts" --step "Running tests" --progress
node ./dist/supervisor.js --worker-heartbeat waiting --project D:\learn\openclaw-plugins --needs-approval true --blocker "Need approval to run deployment."
node ./dist/supervisor.js --worker-heartbeat working --project D:\learn\openclaw-plugins --plan-json "[{\"step\":\"Patch code\",\"status\":\"completed\"}]"
node ./dist/supervisor.js --worker-inbox --project D:\learn\openclaw-plugins
node ./dist/supervisor.js --worker-ack <instruction-id> received --project D:\learn\openclaw-plugins --message "Instruction received."
node ./dist/supervisor.js --worker-ack <instruction-id> completed --project D:\learn\openclaw-plugins --message "Done."
```

### Codex CLI Worker Adapter

The opt-in Codex Worker adapter converts approved inbox instructions into non-interactive `codex exec` runs:

```bash
npm run supervisor:worker:codex -- --once
npm run supervisor:worker:codex
node ./dist/supervisor.js --worker-codex --project D:\learn\openclaw-plugins --worker-id codex-main --once
```

The adapter processes one instruction at a time and uses the local Codex login. Work and resume instructions run with `--sandbox workspace-write` by default. Pause instructions never launch Codex; they complete only after the adapter reaches a point where no Codex process is running.

Safety behavior:

- only dispatched instructions for the configured worker ID are consumed;
- the adapter writes heartbeat and acknowledgement state automatically;
- it never passes a sandbox-bypass flag;
- process errors and timeouts become sanitized failed acknowledgements;
- an instruction left `received` or `started` after adapter restart is failed instead of replayed automatically;
- idle heartbeats are rate-limited to avoid audit-log noise.

The adapter is not enabled by default. Enabling it may consume Codex quota and allows approved instructions to modify files inside the selected project.

The adapter inherits the local Codex configuration, including custom `model_provider` definitions. `--codex-profile <profile>` selects a dedicated Codex profile for Worker execution so App/interactive authentication and third-party provider authentication do not need to share one configuration path.

Repeatable `--codex-config <key=value>` arguments support standalone CLI installations that do not load Codex App custom-provider tables. These overrides must contain provider metadata only. Do not put real API keys or access tokens on the command line; use an environment-backed provider field or a local proxy that manages credentials outside the Worker process.

## Audit Log

The supervisor appends decision events to `.project-supervisor/audit.jsonl`.

Events include:

- `instruction_created`
- `instruction_approved`
- `instruction_rejected`
- `instruction_dispatched`

The audit log is for debugging, review, and future mobile history.

Audit history is bounded independently from state history. `auditRetentionDays` defaults to 90 days and `maxAuditEntries` defaults to 10,000 valid or retained lines. Automatic maintenance runs at most once per day for each project; malformed lines remain available for investigation unless the count cap removes them. Manual maintenance is available through `/supervise prune-history` and `POST /api/maintenance/history`.

Audit queries return newest entries first and accept an exact event name, inclusive `from`/`to` timestamps, and a limit capped at 200:

```text
GET /api/audit?event=instruction_dispatched&from=2026-07-01&limit=50
/supervise audit instruction_dispatched 10
```

JSON state remains bounded by `maxHistory`, `maxInstructions`, and `maxNotifications`. The existing `SupervisorStateStorage` boundary keeps SQLite possible, but the default remains atomic JSON because current workloads do not require concurrent writers or database-only queries.

## Project Registry

For multi-project supervision, the supervisor keeps a central project registry.

Default location:

```text
<parent-of-project>/.project-supervisor/projects.json
```

Example:

```json
{
  "activeProjectId": "openclaw-plugins",
  "projects": [
    {
      "id": "openclaw-plugins",
      "name": "openclaw-plugins",
      "projectDir": "D:\\learn\\openclaw-plugins",
      "stateFile": "D:\\learn\\openclaw-plugins\\.project-supervisor\\state.json",
      "workerStateFile": "D:\\learn\\openclaw-plugins\\.project-supervisor\\worker-state.json",
      "workerInboxFile": "D:\\learn\\openclaw-plugins\\.project-supervisor\\inbox.jsonl",
      "workerOutboxFile": "D:\\learn\\openclaw-plugins\\.project-supervisor\\outbox.jsonl",
      "auditFile": "D:\\learn\\openclaw-plugins\\.project-supervisor\\audit.jsonl",
      "addedAt": "2026-07-09T11:30:00.000Z",
      "lastSeenAt": "2026-07-09T11:30:00.000Z"
    }
  ]
}
```

`activeProjectId` is the command-routing switch. Command runs, approvals, direct instructions, and Worker control are applied to that active project. Background scans cover every registered project, and health/alert views aggregate their results. Each project keeps its own `.project-supervisor/state.json`, inbox, outbox, and audit log.

## Mobile Commands

The OpenClaw command surface maps to the protocol:

- `/supervise status` shows project and worker state.
- `/supervise ai` shows detailed worker heartbeat.
- `/supervise review` shows active project, worker state, next actions, and pending instructions.
- `/supervise alerts` shows open supervisor alerts across all registered projects.
- `/supervise ack alerts` acknowledges all open supervisor alerts across all registered projects.
- `/supervise ack <alert-id-or-signal-id>` acknowledges one supervisor alert.
- `/supervise projects` lists registered projects with health, scan time, and alert counts.
- `/supervise register` registers the current project in the central registry.
- `/supervise register <project-dir>` registers another local project and makes it active.
- `/supervise activate <project-id>` or `/supervise use <project-id>` switches the active project.
- `/supervise propose` shows recommended next actions.
- `/supervise propose <instruction>` creates a pending instruction.
- `/supervise approve latest` approves and dispatches the newest pending instruction.
- `/supervise approve <id>` approves and dispatches a pending instruction.
- `/supervise reject latest` rejects the newest pending instruction.
- `/supervise reject <id>` rejects a pending instruction.
- `/supervise tell <instruction>` immediately dispatches a human-approved instruction.
- `/supervise pause` dispatches a typed pause request and blocks normal worker instruction dispatch.
- `/supervise resume` dispatches a typed resume request after the worker has confirmed it is paused.
- `/supervise pending` lists recent supervisor instructions.
- `/supervise resolve <id> [note]` marks a failed or ignored instruction resolved.
- `/supervise supersede <id> <completed-replacement-id> [note]` links a failed or ignored instruction to its successful replacement.
- `/supervise close <id> [note]` manually closes a failed or ignored instruction.

## HTTP API

The dashboard and phone gateway use the same active project routing:

- `GET /api/projects` returns the registry.
- `GET /api/overview` returns the active project, latest snapshot, pending instructions, recent instructions, next actions, allowed commands, registry, and panel URL.
- `POST /api/resolve-instruction` accepts `{ "id", "status": "resolved" | "superseded" | "closed", "note"?, "resolvedBy"?, "supersededByInstructionId"? }`.
- `POST /api/worker-heartbeat` writes the active project's worker heartbeat.
- `GET /api/notifications?status=open` returns supervisor alerts.
- `POST /api/ack-notification` with `{ "id": "..." }` acknowledges one alert.
- `POST /api/ack-notifications` acknowledges all open alerts for the active project.
- `POST /api/register-project` with optional `{ "projectDir": "...", "projectId": "..." }` registers a project.
- `POST /api/activate-project` with `{ "id": "project-id" }` switches the active project.
- `POST /api/approve-latest` approves the newest pending instruction for the active project.
- `POST /api/reject-latest` rejects the newest pending instruction for the active project.
- `POST /api/pause` and `POST /api/resume` start the acknowledged worker control handshake.
- `GET /api/status`, `POST /api/scan`, `GET /api/worker`, `GET /api/instructions`, `POST /api/run`, `POST /api/propose`, `POST /api/tell`, `POST /api/approve`, and `POST /api/reject` operate on the active project.

## Worker Pause And Resume Control

The per-project supervisor state stores one control mode:

- `active`: normal worker instructions may be approved and dispatched.
- `pause_requested`: a typed pause instruction was dispatched; normal dispatch is blocked while acknowledgement is pending.
- `paused`: the worker reported the pause instruction `completed`; normal dispatch remains blocked.
- `resume_requested`: a typed resume instruction was dispatched; normal dispatch remains blocked until completion.

Pause and resume are idempotent while the matching state is already active. A failed or ignored pause returns control to `active`. A failed or ignored resume returns control to `paused`. This prevents the supervisor from claiming the worker stopped or resumed before the worker explicitly confirms it.

## Supervision Signals

Snapshots and `GET /api/overview` include `signals`.

Signals are structured decision hints:

```json
{
  "id": "worker-no-progress",
  "severity": "critical",
  "title": "Worker progress is stale",
  "detail": "No worker progress has been reported since 2026-07-09T10:00:00.000Z.",
  "command": "/supervise review"
}
```

Current signal examples:

- `worker-heartbeat-missing`
- `worker-no-progress`
- `worker-instruction-unacknowledged`
- `worker-instruction-stalled`
- `worker-instruction-failed`
- `worker-instruction-ignored`
- `repeated-command-failure`
- `repeated-worker-instruction-failure`
- `pending-human-decision`
- `worker-done-review-ready`
- `local-changes-ready`
- `git-ahead-unpushed`
- `git-behind-upstream`

Critical signals promote overall project health to `blocked`. Watch signals promote an otherwise healthy project to `watch`.

## Change And Failure Review

Each new snapshot includes a deterministic `review` object. It does not call an LLM or persist full diffs again. It combines:

- Git changed-file status, staged/untracked counts, and `git diff --stat HEAD`;
- the latest result for each supervised command, so a successful retry clears an older failure;
- short error-focused excerpts from failed task output and configured log tails;
- one readiness decision: `clean`, `fix_required`, `review_required`, or `ready_to_commit`;
- a recommended next action for the human or worker AI.

Full command logs and configured log tails retain their existing limits. Review excerpts are deliberately short and are derived from data already present in the snapshot.

## Notifications

Signals with severity `watch` or `critical` create notifications. Informational signals stay visible in status and overview but do not alert.

Notification statuses:

- `open`: needs human attention.
- `acknowledged`: a human has seen it.
- `resolved`: the underlying signal disappeared before acknowledgement.

Notifications are deduplicated by `projectId + signalId`. After acknowledgement, the same signal will not reopen until the configured cooldown expires. Default cooldown is 30 minutes.

### Notification Delivery Outbox

An external OpenClaw/QQ adapter can poll open notifications that have not been delivered:

- `GET /api/notification-outbox` returns pending and previously failed deliveries.
- `POST /api/mark-notification-delivery` with `{ "id": "...", "status": "delivered" }` marks a successful delivery.
- `POST /api/mark-notification-delivery` with `{ "id": "...", "status": "failed", "error": "..." }` records a retry-visible failure.
- `--notification-outbox` exposes the same queue to a local adapter.
- `--mark-notification-delivery <id-or-signal-id> <delivered|failed>` records the adapter result.

A delivered notification remains delivered across periodic scans. It is queued again only when the signal changes materially or an acknowledged/resolved notification is reopened after cooldown.

### Automatic Webhook Delivery

When `notificationWebhookUrl` is configured, the OpenClaw service polls the notification delivery outbox and sends up to ten eligible items per pass. The webhook must use HTTP or HTTPS and must not contain URL credentials.

The JSON payload uses `version: 1` and `event: "project-supervisor.notification"`. It contains a human-readable text summary, a token-free panel URL, and only the notification fields needed by a downstream mobile or chat adapter. Supervisor state, worker messages, delivery errors, and the optional bearer token are not copied into the payload.

Successful requests mark the item `delivered`. Failed requests retain a sanitized error and retry with exponential backoff capped at 30 minutes. Configuration controls the polling interval and per-request timeout:

- `notificationWebhookUrl`
- `notificationWebhookBearerToken`
- `notificationDeliveryIntervalMs`
- `notificationDeliveryTimeoutMs`

## Dashboard Authentication

The generated dashboard URL contains a bootstrap query token for compatibility with phone links. Opening the dashboard exchanges that token for an `HttpOnly`, `SameSite=Strict` session cookie and redirects to a clean URL. API clients may alternatively send `Authorization: Bearer <token>`.

Request bodies are limited to 1 MiB. Startup logs redact query tokens; external gateways and tunnels should also be configured to avoid logging sensitive query strings.

## Codex Account And Quota Registry

Codex account metadata and quota windows are stored centrally, separate from project runtime state:

```text
<supervisor-home>/accounts.json
```

Account records contain display metadata only. They must not contain passwords, browser cookies, API keys, refresh tokens, or other login credentials.

Supported quota window types:

- `rolling`
- `daily`
- `weekly`
- `monthly`
- `credits`
- `custom`

Supported quota statuses:

- `available`
- `low`
- `exhausted`
- `available_unverified`
- `unknown`

Every observation records a source (`manual`, `client_signal`, `official_api`, or `estimated`) and confidence (`exact`, `observed`, or `estimated`). When an exhausted window reaches its recorded `resetAt`, it becomes `available_unverified` and emits one deduplicated notification through the standard notification outbox.

HTTP API:

- `GET /api/accounts`
- `POST /api/accounts/register`
- `POST /api/accounts/remove`
- `POST /api/quotas/set`
- `POST /api/quotas/observe` with `{ "accountId": "...", "text": "..." }`

Mobile commands:

- `/supervise accounts`
- `/supervise account add <id> [display-name]`
- `/supervise account remove <id>`
- `/supervise quota observe <account-id> <limit-message>`
- `/supervise quota exhausted <account-id> <window-id> <reset-at>`
- `/supervise quota available <account-id> <window-id>`

Quota recovery is intentionally marked unverified until the user or a future official/client adapter confirms that the account can be used again.

### Codex Client Signal Adapter

The versioned client adapter accepts explicit Codex CLI/App limit messages through HTTP, OpenClaw commands, or the standalone CLI:

```bash
node ./dist/supervisor.js --quota-observe personal-a --text "Usage limit reached. Try again in 5h."
node ./dist/supervisor.js --quota-observe personal-a --text-file D:\logs\codex-limit.txt
```

It recognizes supported English and Chinese exhaustion/recovery phrases, absolute reset timestamps, Unix reset fields, and relative day/hour/minute/second durations. Unrecognized or ambiguous messages are recorded but never applied to quota state.

Raw signal text is not persisted. The registry keeps only normalized status/window/reset fields, parser version, match reason, observation time, and a SHA-256 evidence hash. This provides audit correlation without retaining potentially sensitive CLI or account text.

### Automatic Quota Log Watcher

Each log source binds one explicitly configured local file to one registered Codex account. Sources are stored in `accounts.json`; raw file contents are never copied into supervisor state.

New sources default to `startAt: "end"` so historical log entries do not create stale recovery alerts. The registration API may explicitly use `startAt: "beginning"` when a controlled backfill is required.

Mobile commands:

- `/supervise quota watch add <account-id> <source-id> <absolute-log-file>`
- `/supervise quota watch remove <source-id>`
- `/supervise quota watch scan`

HTTP API:

- `POST /api/quota-log-sources/register`
- `POST /api/quota-log-sources/remove`
- `POST /api/quota-log-sources/scan`

The watcher runs during every supervisor scan. It:

- reads only bytes appended after the persisted cursor;
- waits for a newline before processing an incomplete tail;
- detects file replacement using file identity and detects truncation by size;
- limits each read to 256 KiB;
- skips the oldest excess backlog when more than 256 KiB accumulated and reports `skippedBytes`;
- filters ordinary log lines before invoking the quota parser;
- advances the cursor only after candidate lines have been processed;
- persists offsets, file identity, size, timestamps, and sanitized errors, but never raw log lines.

Log paths must be explicitly registered by an authenticated supervisor user. Environment variables in paths are not expanded; use an absolute path.
