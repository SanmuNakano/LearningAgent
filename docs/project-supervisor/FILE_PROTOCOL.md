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

## Instruction Inbox

The supervisor appends approved instructions to `.project-supervisor/inbox.jsonl`.

Each line is one JSON object:

```json
{"id":"abc123","projectId":"learning-agent","targetWorker":"codex-main","instruction":"Run tests and summarize failures.","createdAt":"2026-07-09T11:20:00.000Z","approvedAt":"2026-07-09T11:21:00.000Z","dispatchedAt":"2026-07-09T11:21:01.000Z"}
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

The supervisor merges the latest outbox event into instruction status views. If an instruction reports `failed`, project health becomes `blocked` until the failure is reviewed or superseded by a later event.

## Audit Log

The supervisor appends decision events to `.project-supervisor/audit.jsonl`.

Events include:

- `instruction_created`
- `instruction_approved`
- `instruction_rejected`
- `instruction_dispatched`

The audit log is for debugging, review, and future mobile history.

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

`activeProjectId` is the routing switch. Status, scan, command runs, approvals, and direct instructions are applied to that active project. Each project keeps its own `.project-supervisor/state.json`, inbox, outbox, and audit log.

## Mobile Commands

The OpenClaw command surface maps to the protocol:

- `/supervise status` shows project and worker state.
- `/supervise ai` shows detailed worker heartbeat.
- `/supervise review` shows active project, worker state, next actions, and pending instructions.
- `/supervise projects` lists registered projects.
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
- `/supervise pause` asks the worker AI to stop editing and report current status.
- `/supervise pending` lists recent supervisor instructions.

## HTTP API

The dashboard and phone gateway use the same active project routing:

- `GET /api/projects` returns the registry.
- `GET /api/overview` returns the active project, latest snapshot, pending instructions, recent instructions, next actions, allowed commands, registry, and panel URL.
- `POST /api/register-project` with optional `{ "projectDir": "...", "projectId": "..." }` registers a project.
- `POST /api/activate-project` with `{ "id": "project-id" }` switches the active project.
- `POST /api/approve-latest` approves the newest pending instruction for the active project.
- `POST /api/reject-latest` rejects the newest pending instruction for the active project.
- `GET /api/status`, `POST /api/scan`, `GET /api/worker`, `GET /api/instructions`, `POST /api/run`, `POST /api/propose`, `POST /api/tell`, `POST /api/approve`, and `POST /api/reject` operate on the active project.

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
- `repeated-command-failure`
- `repeated-worker-instruction-failure`
- `pending-human-decision`
- `worker-done-review-ready`
- `local-changes-ready`
- `git-ahead-unpushed`
- `git-behind-upstream`

Critical signals promote overall project health to `blocked`. Watch signals promote an otherwise healthy project to `watch`.
