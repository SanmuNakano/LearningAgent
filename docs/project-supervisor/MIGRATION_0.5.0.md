# Migrating Project Supervisor from 0.4.0 to 0.5.0

Release 0.5.0 is backward-compatible for the default, observer-only configuration. Existing JSON and JSONL files are read in place; new fields receive safe defaults.

## Before upgrading

1. Stop OpenClaw and any standalone `supervisor:worker:codex` process.
2. Back up the project `.project-supervisor` directory and the central supervisor home, normally `D:\learn\.project-supervisor`.
3. Keep API keys, tokens, cookies, and provider credentials out of these backups and project files.
4. Run `npm.cmd run release:check` from the plugin repository.

## Configuration changes

All new settings are optional:

- `workerRuntime.enabled` defaults to `false`.
- `workerRuntime.workerId` defaults to `codex-main` when the runtime is configured.
- `workerRuntime.sandbox` defaults to `workspace-write`.
- `auditRetentionDays` defaults to `90`.
- `maxAuditEntries` defaults to `10000`.
- acknowledgement, progress, notification delivery, and multi-project settings retain documented defaults.

To enable the managed Worker, configure non-secret provider metadata and name the environment variable that contains the credential:

```json
{
  "projectSupervisor": {
    "workerRuntime": {
      "enabled": true,
      "workerId": "codex-main",
      "sandbox": "workspace-write",
      "provider": {
        "id": "mirror",
        "baseUrl": "https://api.example.com/v1",
        "envKey": "MIRROR_API_KEY",
        "wireApi": "responses"
      }
    }
  }
}
```

`envKey` is an environment-variable name, never the credential value. Do not run the standalone Worker and managed runtime for the same Worker inbox at the same time.

## Behavior changes

- Every registered project is scanned in the background; active-project selection still controls commands and Worker actions.
- Failed and ignored instructions block health until they are retried successfully and marked `superseded`, verified and marked `resolved`, or manually `closed`.
- Audit history is automatically pruned at most once per day according to its age and entry-count limits.
- Pause and resume complete only after the Worker acknowledges the control instruction.
- A Worker instruction already marked `started` is not automatically replayed after a restart.

## Validation

Run:

```powershell
npm.cmd run release:check
npm.cmd run plugin:doctor
```

Then start OpenClaw and verify:

1. `/supervise status` reports the expected active project.
2. `/supervise projects` shows every registered project.
3. `/supervise ai` reports the intended runtime enabled/running state.
4. `/supervise audit` returns recent events.
5. If the runtime is enabled, approve one read-only instruction before allowing editing work.

This is an OpenClaw lifecycle plugin. Do not use `openclaw plugins validate --entry ./dist/index.js`; that command validates simple tool plugins and will reject this plugin because it intentionally does not expose `defineToolPlugin` metadata.

## Rollback

1. Stop OpenClaw and all Worker processes.
2. Set `workerRuntime.enabled` to `false`.
3. Restore the 0.4.0 plugin code and the pre-upgrade `.project-supervisor` backups.
4. Restart OpenClaw and verify the active project before dispatching instructions.

Do not reuse state written by 0.5.0 with 0.4.0 if you need to preserve control modes, instruction dispositions, runtime status, or newer audit behavior; the older version may discard fields it does not understand when it rewrites state.
