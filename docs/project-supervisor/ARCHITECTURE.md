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

- `src/supervisor.ts` owns project scanning orchestration, active-project routing, and the backward-compatible public core classes.
- `src/supervisor-services.ts` owns worker state/inbox/outbox behavior, supervisor instruction lifecycle, and notification delivery/acknowledgement behavior.
- `src/supervisor-storage.ts` defines the replaceable supervisor-state storage interface and the default atomic JSON implementation.
- `src/quota.ts` owns Codex account metadata, quota windows, observations, log-source metadata, cursors, and quota notifications.

### Ingestion Adapters

- `src/codex-quota-adapter.ts` converts supported client messages into normalized quota observations.
- `src/quota-log-watcher.ts` reads explicitly registered files incrementally and passes candidate lines to the quota adapter.

### Worker Execution Adapters

- `src/codex-worker-adapter.ts` consumes approved file-protocol instructions and runs the local Codex CLI with bounded concurrency, workspace sandboxing, timeouts, heartbeat updates, and acknowledgement reporting.
- Worker execution remains opt-in and depends only on the supervisor public worker protocol, not on OpenClaw internals.

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

supervisor core
  -> supervisor state storage interface
       -> atomic JSON storage (default)
       -> SQLite storage (future, optional)
```

Platform adapters may depend on the core. The core must not import OpenClaw. The CLI is dynamically loaded to preserve the historical `node dist/supervisor.js` entry without introducing a static circular dependency.

## State Ownership

- Per-project runtime state stays under `<project>/.project-supervisor/`.
- `ProjectSupervisor` receives its state backend through `SupervisorStateStorage`; existing callers use `JsonSupervisorStateStorage` automatically.
- Cross-project registry and Codex account/quota state stay under the supervisor home directory.
- Worker interoperability remains file-based (`worker-state.json`, `inbox.jsonl`, `outbox.jsonl`).
- Raw Codex log messages are never persisted by the quota subsystem.

## Next Refactoring Stages

No major feature should be added to `supervisor.ts` until these stages are complete:

1. Extract shared exported types and normalized configuration.
2. Extract project scanning and health/signal evaluation.
3. ~~Replace duplicated `ProjectSupervisor`/`ProjectSupervisorHub` HTTP route branches with one controller/router.~~ Completed in Phase 13.
4. ~~Extract instruction, worker, and notification services from the core class.~~ Completed in Phase 13.
5. ~~Introduce a storage interface before migrating project state from JSON to SQLite.~~ Completed in Phase 13.

Each stage must preserve the public API, OpenClaw command surface, standalone CLI, file protocol, and full test suite.

Phase 13 architecture stabilization is complete. A SQLite backend is now possible without changing `ProjectSupervisor`, but should only be added when query, retention, or concurrency requirements justify the migration.
