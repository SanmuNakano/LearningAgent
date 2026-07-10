# Changelog

## 0.5.0 - 2026-07-10

Release 0.5.0 promotes AI Project Supervisor from a single-project observer into an opt-in managed Worker control plane.

### Added

- Codex account quota windows, limit-signal parsing, and incremental log watching without retaining raw account messages.
- Replaceable Supervisor state storage, separated controller/dashboard/service boundaries, and architecture guard tests.
- Worker instruction compliance signals, structured Git/project reviews, and error-focused task/log summaries.
- Webhook notification delivery with privacy-limited payloads, retry backoff, and sanitized errors.
- A persisted pause/resume handshake and an opt-in Codex CLI Worker adapter.
- Managed Worker runtime lifecycle with validated non-secret provider metadata and runtime visibility.
- Continuous scanning and alert aggregation across all registered projects.
- Audited `resolved`, `superseded`, and `closed` dispositions for failed or ignored instructions.
- Bounded audit retention plus event/time-range queries over HTTP and mobile commands.
- Release packaging that excludes test artifacts and validates version/document/package consistency before distribution.

### Changed

- Background scans now cover every registered project; commands and Worker control still target only the active project.
- Failed or ignored instructions remain immutable but stop blocking health after an explicit Supervisor disposition.
- Successful command retries clear older failure decisions by using the latest result for each command.

### Security

- Provider credentials remain outside project configuration and must be supplied through the named environment variable.
- Webhook payloads exclude Supervisor state, Worker messages, delivery errors, dashboard tokens, and bearer credentials.
- Interrupted `started` Worker instructions are not replayed automatically after restart.

### Compatibility

- No required state migration is performed; missing fields are normalized to safe defaults.
- Managed Worker execution remains disabled unless `projectSupervisor.workerRuntime.enabled` is explicitly set to `true`.
- See `docs/project-supervisor/MIGRATION_0.5.0.md` before enabling the managed runtime or rolling back.

## 0.4.0

- Established the QQ study router and the initial file-based Project Supervisor control loop through Phase 8.
