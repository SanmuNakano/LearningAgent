# AI Project Supervisor Architecture

## Goals

- Keep project/worker supervision independent from OpenClaw, HTTP, CLI, and dashboard presentation.
- Keep Codex quota ingestion replaceable because personal-account formats are not a stable public API.
- Keep runtime state and credentials separate; account metadata must never contain login secrets.
- Make every platform boundary testable without starting the full gateway.

## Current Layers

### Entry Layer

- `src/index.ts` registers the QQ study router and delegates supervisor plugin registration to the OpenClaw adapter.
- `src/supervisor.ts` remains a backward-compatible standalone executable and dynamically loads the CLI adapter only when launched directly.

### Platform Adapters

- `src/supervisor-openclaw.ts` owns OpenClaw configuration discovery, service lifecycle registration, HTTP route registration, and `/supervise` commands.
- `src/supervisor-cli.ts` owns standalone command-line parsing and output.
- `src/supervisor-http.ts` owns authentication, bootstrap-cookie exchange, JSON body limits, safe URL rendering, and JSON/error responses.
- `src/supervisor-controller.ts` owns the shared HTTP endpoint router for both single-project and hub modes.
- `src/supervisor-dashboard.ts` owns the self-contained browser dashboard.

### Application/Core Layer

- `src/supervisor.ts` owns project scanning orchestration, worker state, instructions, notifications, active-project routing, and the public core classes.
- `src/quota.ts` owns Codex account metadata, quota windows, observations, log-source metadata, cursors, and quota notifications.

### Ingestion Adapters

- `src/codex-quota-adapter.ts` converts supported client messages into normalized quota observations.
- `src/quota-log-watcher.ts` reads explicitly registered files incrementally and passes candidate lines to the quota adapter.

## Dependency Direction

```text
index
  -> supervisor-openclaw
       -> supervisor core
            -> quota service
            -> quota ingestion adapters
            -> supervisor-http
            -> supervisor-dashboard

supervisor executable
  --dynamic--> supervisor-cli
                  -> supervisor core
```

Platform adapters may depend on the core. The core must not import OpenClaw. The CLI is dynamically loaded to preserve the historical `node dist/supervisor.js` entry without introducing a static circular dependency.

## State Ownership

- Per-project runtime state stays under `<project>/.project-supervisor/`.
- Cross-project registry and Codex account/quota state stay under the supervisor home directory.
- Worker interoperability remains file-based (`worker-state.json`, `inbox.jsonl`, `outbox.jsonl`).
- Raw Codex log messages are never persisted by the quota subsystem.

## Next Refactoring Stages

No major feature should be added to `supervisor.ts` until these stages are complete:

1. Extract shared exported types and normalized configuration.
2. Extract project scanning and health/signal evaluation.
3. ~~Replace duplicated `ProjectSupervisor`/`ProjectSupervisorHub` HTTP route branches with one controller/router.~~ Completed in Phase 13.
4. Extract instruction, worker, and notification services from the core class.
5. Introduce a storage interface before migrating project state from JSON to SQLite.

Each stage must preserve the public API, OpenClaw command surface, standalone CLI, file protocol, and full test suite.
