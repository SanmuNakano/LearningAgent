# AI Project Supervisor Product Definition

## One Sentence

AI Project Supervisor is a cross-project control agent that monitors both a software project and the AI agent working on it, then lets the human owner approve or send next-step instructions from mobile.

## What This Is

This is not only a project dashboard.

It is a supervisor for AI-assisted project work. For every future project, it should answer:

- Is the project itself healthy?
- Is the project AI still working normally?
- Is the AI stuck, idle, looping, failing tests, or waiting for the user?
- What is the safest next instruction?
- Should the supervisor notify the user and ask for approval?
- After approval, how should the supervisor tell the project AI what to do next?

## Actors

- Human owner: the user who approves decisions, sends instructions, and owns the project.
- Supervisor agent: the control layer that observes, summarizes, asks for approval, and dispatches instructions.
- Worker AI: the AI agent actually building or debugging the project.
- Project: any local repository or workspace under supervision.

## Product Boundary

The supervisor should be independent from `agent-learning`.

`agent-learning` is a learning memory/workspace. AI Project Supervisor is a reusable project-control product. It may supervise a learning project, but it must also work for future apps, plugins, tools, websites, and experiments.

## Core Jobs

### 1. Observe The Project

The supervisor monitors the concrete project state:

- Git branch, dirty files, commit status, remote sync status.
- Build/test/check command results.
- Running dev servers and watched ports.
- Important logs and error summaries.
- Recent file activity.
- Open tasks and command history.

### 2. Observe The Worker AI

The supervisor monitors the AI that is working on the project:

- Current goal.
- Current plan and step status.
- Last meaningful progress time.
- Last tool/command activity.
- Whether the AI is waiting for user input.
- Whether the AI is blocked.
- Whether the AI is repeatedly failing the same step.
- Whether tests/builds are currently being run.
- Whether a final answer was produced before verification.

The preferred model is explicit AI heartbeat state, not fragile log scraping.

Example worker AI state:

```json
{
  "projectId": "learning-agent",
  "workerId": "codex-main",
  "status": "working",
  "goal": "Improve project supervisor",
  "currentStep": "Run tests and inspect failures",
  "plan": [
    { "step": "Read current implementation", "status": "completed" },
    { "step": "Patch supervisor config", "status": "in_progress" },
    { "step": "Verify build and tests", "status": "pending" }
  ],
  "lastProgressAt": "2026-07-09T10:30:00.000Z",
  "needsUserApproval": false,
  "blocker": null
}
```

### 3. Decide Whether To Notify

The supervisor should avoid noisy alerts. It should notify only when the user can make a useful decision:

- Worker AI is blocked and needs direction.
- Tests/builds failed after an AI change.
- Worker AI is idle for longer than expected.
- There are uncommitted changes ready for review.
- Local work has not been pushed to remote.
- A risky command or project action needs approval.
- The AI proposes a meaningful next step that needs human confirmation.

### 4. Ask For Approval

The supervisor should be usable from mobile.

Typical approval flow:

1. Supervisor detects a decision point.
2. Supervisor sends a short status and proposed next action.
3. Human approves, rejects, edits, or sends a new instruction.
4. Supervisor records the decision.
5. Supervisor dispatches the approved instruction to the worker AI.

### 5. Dispatch Instructions To Worker AI

The supervisor can become an instruction sender, but it should not silently control the worker AI without policy.

Allowed instruction types:

- Continue with the current plan.
- Run a whitelisted command.
- Stop and summarize.
- Investigate a specific failure.
- Commit/push after checks pass.
- Change priority.
- Ask the worker AI to produce a plan before editing.
- Pause the worker AI.

Dispatch should be auditable:

```json
{
  "id": "cmd_001",
  "projectId": "learning-agent",
  "targetWorker": "codex-main",
  "createdBy": "human",
  "status": "approved",
  "instruction": "Run tests, fix failures, then summarize before committing.",
  "createdAt": "2026-07-09T10:35:00.000Z",
  "approvedAt": "2026-07-09T10:36:00.000Z"
}
```

## Mobile Command Surface

Initial command ideas:

- `/supervise status` - project and worker summary.
- `/supervise ai` - worker AI state, current goal, current step, blocker.
- `/supervise scan` - force project scan.
- `/supervise run test` - run an allowed command.
- `/supervise propose` - ask supervisor for the next recommended action.
- `/supervise approve <id>` - approve a pending action.
- `/supervise reject <id>` - reject a pending action.
- `/supervise tell <message>` - send an instruction to the worker AI.
- `/supervise pause` - pause command dispatch.

## Architecture

### Supervisor Core

The core is project-agnostic:

- Loads registered projects.
- Scans project state.
- Reads worker AI state.
- Maintains task and command history.
- Produces health, risks, and next actions.
- Exposes HTTP/mobile commands.

### Project Adapter

Each project can define:

- Root directory.
- Build/test/check commands.
- Ports to watch.
- Logs to tail.
- Files to ignore.
- Worker AI adapter.

### Worker AI Adapter

The worker adapter answers:

- How do we read the AI's state?
- How do we send an instruction?
- How do we know whether the instruction was received?

Possible adapters:

- File-based heartbeat and inbox/outbox.
- OpenClaw runtime integration.
- Codex thread integration if available.
- Terminal/log fallback.

## Health Model

Project health and worker health should be separate.

Project health:

- `ok`: build/test state is good, no high-risk project issues.
- `watch`: attention useful, but no confirmed blocker.
- `blocked`: clear failure or required human decision.

Worker AI health:

- `working`: active and making progress.
- `waiting`: waiting for user approval/input.
- `idle`: no activity beyond expected window.
- `stuck`: repeated failures or no progress on same step.
- `done`: completed and waiting for review.

Overall status should combine both:

- Project ok + AI working = healthy.
- Project ok + AI waiting = needs approval.
- Project failed + AI stuck = blocked.
- Project dirty + AI done = ready for review/commit.

## Non Goals For The First Version

- Do not become a full CI/CD platform.
- Do not auto-run arbitrary shell commands.
- Do not silently rewrite code without user approval.
- Do not mix learning memory with supervisor runtime state.
- Do not depend on one specific project forever.
- Do not spam the user for harmless idle time.

## MVP

The first useful version should support one active project and one worker AI.

Required:

- Project registration for `D:\learn\openclaw-plugins`.
- Project scan: Git, package scripts, build/test/check, logs, ports.
- Worker AI state model, even if initially file-based.
- Command history and pending approvals.
- Mobile commands for status, approve, reject, tell, run.
- Clear next-action recommendation.
- Audit log.

## Roadmap

### Phase 1: Product Grounding

- Write product definition.
- Separate project supervision from learning workspace.
- Keep existing project scan and dashboard working.
- Define worker AI state schema.

### Phase 2: AI State And Command Queue

- Add worker heartbeat file.
- Add command inbox/outbox.
- Show worker state in status output and dashboard.
- Add pending approval records.

### Phase 3: Mobile Control Loop

- Add `/supervise ai`.
- Add `/supervise propose`.
- Add `/supervise approve <id>`.
- Add `/supervise tell <message>`.
- Require approval before dispatching risky instructions.

### Phase 4: Multi-Project Support

- Register multiple project roots.
- Select active project from mobile.
- Keep per-project state isolated.
- Support different worker AI adapters.

### Phase 5: Smarter Supervision

- Detect repeated failures.
- Summarize logs and diffs.
- Recommend commit/push/review timing.
- Track whether worker AI followed approved instructions.

## Open Decisions

- Should state live inside each project, or in one central supervisor home directory?
- What is the first worker AI adapter: file-based, OpenClaw runtime, or Codex thread integration?
- Should mobile approval be required for all instructions or only risky ones?
- How should the supervisor pause/resume a worker AI safely?
- How much project history should be retained?
