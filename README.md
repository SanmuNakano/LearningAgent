# QQ Study Router + Project Supervisor

OpenClaw plugin that routes QQBot messages to learning specialist agents and exposes a local Project Supervisor for mobile progress monitoring.

Product direction for the cross-project AI supervisor is tracked in [`docs/project-supervisor/PRODUCT.md`](docs/project-supervisor/PRODUCT.md). The file-based worker protocol is documented in [`docs/project-supervisor/FILE_PROTOCOL.md`](docs/project-supervisor/FILE_PROTOCOL.md).

## Project Supervisor

The supervisor watches a local project, keeps a rolling state file, exposes a mobile-friendly dashboard, and registers an OpenClaw command for phone/chat control.

Default local repository:

- `D:\learn\openclaw-plugins`
- Supervisor state: `D:\learn\openclaw-plugins\.project-supervisor\state.json`
- Project registry: `D:\learn\.project-supervisor\projects.json`
- Generated state, logs, dependencies, and build output are ignored by Git.

What it monitors:

- file activity, newest files, recent files, and extension counts
- git branch/status/last commit when `git` is available
- package scripts
- configured local ports
- configured log file tails
- whitelist command tasks started from the panel or OpenClaw
- risk state: `ok`, `watch`, or `blocked`
- structured supervision signals such as stale worker progress, repeated command failures, pending human decisions, local changes ready for review, and git ahead/behind state

Safe controls:

- Only named whitelist commands can run remotely.
- Defaults are `build`, `test`, and `check`.
- Arbitrary shell input is not exposed through the phone/dashboard UI.
- The dashboard uses a token. If no token is configured, one is generated in `.project-supervisor/state.json`.

OpenClaw commands:

```text
/supervise status
/supervise ai
/supervise review
/supervise alerts
/supervise ack alerts
/supervise ack <alert-id-or-signal-id>
/supervise projects
/supervise register
/supervise register D:\learn\another-project
/supervise activate openclaw-plugins
/supervise scan
/supervise propose
/supervise propose <instruction>
/supervise approve latest
/supervise approve <instruction-id>
/supervise reject latest
/supervise reject <instruction-id>
/supervise tell <instruction>
/supervise pause
/supervise url
/supervise run build
/supervise run test
```

Standalone local dashboard:

```bash
npm run supervisor:serve
```

Then open the printed URL from the same machine. For phone access, expose the host via OpenClaw Gateway, Tailscale, LAN binding, or a trusted tunnel.

Worker adapter helpers:

```bash
npm run supervisor:worker:heartbeat
npm run supervisor:worker:inbox
node ./dist/supervisor.js --worker-heartbeat working --project D:\learn\openclaw-plugins --worker-id codex-main --goal "Build supervisor" --step "Running tests" --progress
node ./dist/supervisor.js --worker-ack <instruction-id> received --project D:\learn\openclaw-plugins --message "Instruction received."
node ./dist/supervisor.js --worker-ack <instruction-id> completed --project D:\learn\openclaw-plugins --message "Done."
```

Example plugin config:

```json
{
  "projectSupervisor": {
    "projectDir": "D:\\learn\\openclaw-plugins",
    "host": "127.0.0.1",
    "port": 8791,
    "staleAfterMs": 14400000,
    "watchedPorts": [3000, 5173],
    "logFiles": ["logs/app.log"],
    "allowedCommands": {
      "build": "npm run build",
      "test": "npm test",
      "check": "npm run check"
    }
  }
}
```

## Routing Strategy (v0.3.0)

Five-tier routing with cascade escalation and multi-turn context:

1. **Fast-path regex** — Fixed commands (greetings, `今日学习`, `复盘`, `今日复习`/`错题复习`, explicit `5.5`/`最强`/`专家模式` requests) are routed instantly with zero API cost.

2. **Semantic embedding** — User messages are embedded and compared against route descriptions via cosine similarity. Routes to the best match if confidence >= threshold AND margin >= configured minimum. Costs one embedding API call (~50ms).

3. **LLM classifier** — When semantic confidence or margin is below threshold, a cheap model (default: `deepseek-v4-flash`) classifies the message. Costs one small LLM call (~200ms-1s).

4. **Regex fallback** — If no API is available (no credentials, network failure), falls back to improved keyword/regex matching. ALGO is checked before ENGINEER to prevent misroutes.

5. **Cascade escalation** — Specialists (`daily-coach`, `algo-coach`, `engineer-coach`) append `[ESCALATE_TO_DEEP_EXPERT]` to their reply when a problem is beyond their scope. The plugin detects this and automatically re-routes to `deep-expert` with the specialist's partial answer as context.

6. **Multi-turn context** — The plugin maintains a per-conversation cache of recent turns (user messages + assistant replies with agent attribution). When routing a new message, the last N turns are included as context in the specialist's prompt, so the specialist knows what was discussed even if it was with a different agent.

## Configuration

Plugin config (in OpenClaw config under `plugins["qq-study-router"]`):

| Option | Default | Description |
|--------|---------|-------------|
| `embeddingModel` | `text-embedding-3-small` | Embedding model for semantic routing |
| `embeddingProvider` | `sorux-chat` | Provider ID for embedding API |
| `semanticThreshold` | `0.38` | Minimum cosine similarity for confident semantic routing |
| `semanticMargin` | `0.12` | Minimum score gap between best and second-best route |
| `classifierModel` | `deepseek-v4-flash` | Model for LLM classifier fallback |
| `classifierProvider` | `sorux-chat` | Provider ID for classifier |
| `enableCascade` | `true` | Enable cascade escalation to deep-expert |
| `contextWindowSize` | `4` | Number of recent turns included for follow-up messages |
| `workspaceDir` | `OPENCLAW_STUDY_WORKSPACE` or `D:\learn\agent-learning` | Workspace directory shared by the learning agents |
| `embeddingCacheFile` | `<workspaceDir>\.route-embeddings.json` | Optional semantic route embedding cache path |

Provider credentials are read from OpenClaw config, falling back to environment variables (`SORUX_CHAT_API_KEY` or `OPENAI_API_KEY`) for the `sorux-chat` provider.

## Verified API Compatibility

Tested against `https://ai.soruxgpt.com/v1`:

- `/embeddings` with `text-embedding-3-small` — works, 1536 dimensions
- `/chat/completions` with `deepseek-v4-flash` — works (outputs reasoning text, plugin extracts route ID from response)
- `qwen3.5-plus` has thinking mode enabled by default — not suitable as classifier
- `gpt-4o-mini` may timeout on this provider — `deepseek-v4-flash` is the recommended classifier model

## Semantic Routing Test Results

Real cosine similarity scores from API testing:

| Message | daily-coach | algo-coach | engineer-coach | Routed to |
|---------|-------------|------------|----------------|-----------|
| 这道题怎么优化时间复杂度 | 0.3007 | **0.5110** | 0.1774 | algo-coach |
| 我的python项目报错了 | 0.1983 | 0.1871 | **0.4684** | engineer-coach |
| 今天我应该学什么 | **0.4679** | 0.2479 | 0.2188 | daily-coach |
| 帮我分析下这道DFS题的复杂度 | 0.2677 | **0.5655** | 0.1934 | algo-coach |
| 用python写两数之和的哈希表解法 | 0.1201 | **0.4008** | 0.2078 | algo-coach |
| OpenClaw认证失败怎么排查 | 0.1680 | 0.2599 | **0.5267** | engineer-coach |
| 今日学习 | **0.5404** | 0.2139 | 0.2350 | daily-coach |

All messages correctly routed with margin > 0.12 between best and second-best.

## Build

```bash
npm install
npm run plugin:build
npm run plugin:validate
npm test
```

`plugin:validate` runs `build + test` for this event-style plugin. OpenClaw's `plugins validate --entry` command validates simple tool plugin metadata; that legacy check is available as `npm run plugin:validate:tool` if a future tool plugin needs it.

## Key Changes from v0.1.0

- Removed `DEEP_RE` from initial routing — no more misrouting "复杂度"/"DFS" to the most expensive model
- ALGO regex now checked before ENGINEER — "python + 哈希表" correctly goes to algo-coach
- Deep-expert triggered via cascade (specialist escalation) or explicit user request only
- Semantic embedding as primary routing mechanism for non-fixed-command messages
- LLM classifier as fallback when semantic confidence is low
- Startup validation checks all required agents exist in config
