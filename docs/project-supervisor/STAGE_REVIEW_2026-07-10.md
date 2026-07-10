# AI Project Supervisor 阶段总结

日期：2026-07-10  
范围：Phase 1–18

## 阶段结论

AI Project Supervisor 已经完成单项目、单 Worker MVP，并进入可运行 Beta 阶段。

当前系统不再只是状态面板。它已经能够观察项目和 Worker、生成监督信号、请求人工决策、派发批准指令、追踪执行回执，并通过真实 Codex CLI Worker 执行指令。

当前验证基线：

- TypeScript 构建通过。
- 12 个测试文件、87 项测试通过。
- 已通过本地第三方 `mirror` Provider 完成真实只读指令。
- 真实指令完成了 `received -> started -> completed` 回执链路。
- 真实联调没有修改项目文件。

## 已完成能力

### 1. 项目观察

- 扫描文件活动、Git 分支与变更、package scripts、端口和日志。
- 运行白名单命令并记录输出、超时和结果。
- 汇总 Git diff statistics、失败命令和日志错误片段。
- 给出 `clean`、`fix_required`、`review_required`、`ready_to_commit` 判断。

### 2. Worker 观察与协议

- 使用 `worker-state.json` 记录目标、当前步骤、计划、活动时间和阻塞原因。
- 使用 `inbox.jsonl` 派发批准指令。
- 使用 `outbox.jsonl` 记录 `received`、`started`、`completed`、`failed`、`ignored`。
- 检测未确认、长时间无进度、失败、忽略和重复失败。

### 3. 人工控制闭环

- 支持 propose、approve、reject、tell、pause 和 resume。
- 暂停/恢复使用持久化四态握手：`active`、`pause_requested`、`paused`、`resume_requested`。
- 暂停期间阻止普通 Worker 指令派发。
- 迟到回执不能覆盖更新的控制请求。

### 4. 操作界面与通知

- 提供 HTTP API、OpenClaw `/supervise` 命令和浏览器 Dashboard。
- 生成结构化监督信号和去重通知。
- 支持通知确认、自动恢复、冷却时间和投递状态。
- 支持可选 Webhook 自动投递、超时和指数退避。

### 5. Codex 配额观察

- 管理不包含凭据的 Codex 账号元数据。
- 支持多种配额窗口、恢复时间和置信度。
- 支持中英文限制消息解析。
- 支持增量日志监听、文件轮换和游标持久化。

### 6. 架构稳定性

- HTTP、Dashboard、CLI、OpenClaw、服务和存储边界已经拆分。
- 项目状态存储可替换，默认 JSON 写入使用串行化和原子替换。
- 架构边界测试阻止核心类重新吸收平台逻辑。

### 7. 真实 Codex Worker

- 新增 opt-in Codex CLI Worker Adapter。
- 一次只处理一条批准指令。
- 默认使用 `workspace-write`，不传递任何 sandbox bypass 参数。
- 暂停指令不会启动 Codex 子进程。
- 子进程失败、超时和重启中断会写入安全回执。
- 中断后的 `started` 指令不会自动重放，避免重复编辑。
- 支持 model、profile 和显式 custom-provider config overrides。
- 第三方 Provider 错误只保留脱敏摘要，不保存完整失败 transcript。

## 当前限制

### 1. Managed Worker 仍是可选能力

OpenClaw 已能根据配置管理 Codex Worker runtime，但默认保持关闭。启用后会消耗 Provider 配额并允许批准指令修改项目，因此仍需要人工完成 Provider、环境变量和 sandbox 配置。

### 2. 第三方 Provider 需要显式配置

本机 standalone Codex CLI 没有自动加载 Codex App 写入的 custom-provider 表。真实联调需要显式传递 `mirror` Provider metadata。API Key 不应放入命令行参数；凭据应继续由环境变量或本地代理管理。

### 3. 多项目共享一个进程内调度器

全部注册项目都会持续扫描和聚合告警，但命令和 Worker 控制仍只作用于 active project。当前设计适合单机、单 Supervisor 进程，不支持多个进程同时写入同一项目状态。

### 4. SQLite 仍未启用

当前 JSON state 使用原子替换，审计日志具有保留策略和查询能力。只有出现多写入者、大规模索引查询或明显性能瓶颈时，才值得通过已有 `SupervisorStateStorage` 边界引入 SQLite。

### 5. 远端发布仍需人工确认

- Release 0.5.0 候选版本、变更记录、迁移说明和发布检查已经形成。
- 本地 `main` 比 `origin/main` 领先，Phase 19–22 仍需审查后提交。
- 推送、打标签和远端部署属于显式发布操作，不在本阶段自动执行。

## Phase 19 计划（历史）

主题：Managed Worker Runtime

目标：让 Codex Worker 从“可手动运行的适配器”变成“由 Project Supervisor 安全管理的可选服务”。

### 计划任务

1. 增加持久化 Worker runtime 配置：enabled、workerId、model、profile、sandbox、poll interval、timeout。
2. 支持安全的第三方 Provider metadata 配置，但禁止在 Supervisor state、日志或命令行中保存真实密钥。
3. 将 Codex Worker Adapter 接入 OpenClaw service lifecycle，保证 start/stop 幂等且只有一个执行循环。
4. 在 HTTP overview、Dashboard 和 `/supervise ai` 中显示 runtime enabled、running、last poll 和 last error。
5. 增加 runtime start/stop、配置验证、重启恢复和 Provider 失败测试。
6. 使用只读批准指令再次完成真实端到端 smoke test。

### Phase 19 验收标准

- 配置启用后，OpenClaw 启动会自动启动一个 Worker runtime。
- 配置关闭时，不会创建 Codex 子进程。
- 同一项目不会出现两个并发 Worker 执行循环。
- pause 状态下不会启动普通工作指令。
- 第三方 Provider 可以工作，真实密钥不进入项目文件、state、audit 或进程参数。
- OpenClaw stop/restart 后不会自动重复执行已经 `started` 的指令。
- 完整测试套件和一次真实只读联调通过。

### Phase 19 验收结果（2026-07-10）

- 已完成持久化 runtime 配置、非密钥 Provider metadata、OpenClaw service 生命周期接入和运行状态展示。
- 已通过单实例启停、关闭不创建 adapter、重启恢复、Provider 失败脱敏和配置校验测试。
- 已通过显式 `mirror` Provider metadata 的真实只读批准指令；状态依次达到 `received`、`started`、`completed`，且未修改源码。
- `npm run check` 通过，共 93 项测试。

### Phase 20 验收结果（2026-07-10）

- 后台扫描和手动刷新已覆盖全部注册项目，命令与 Worker 控制仍只作用于 active project。
- HTTP overview、Dashboard、`/supervise projects` 和 `/supervise alerts` 已聚合跨项目健康与告警。
- 非活动项目告警可以直接确认和进入统一通知投递队列。
- 单项目目录缺失不会中断其他项目扫描，重叠扫描也会被合并为同一次执行。
- `npm run check` 通过，共 95 项测试。

### Phase 21 验收结果（2026-07-10）

- failed/ignored Worker 结果现在可以标记为 `resolved`、关联已完成替代指令的 `superseded`，或人工 `closed`。
- 原始 Worker 结果不会被覆盖，处置时间、操作者、说明和替代指令均进入 state 与 audit。
- 已处置指令不再阻塞健康状态，也不再持续产生失败或 ignored 告警。
- HTTP、Dashboard 和移动端命令均可执行处置流程。
- 已将 Phase 19 首次认证失败的 smoke 指令关联到后续成功只读重试；失败信号消失，项目健康从 `blocked` 恢复为 `watch`。
- `npm run check` 通过，共 97 项测试。

### Phase 22 验收结果（2026-07-10）

- 审计日志现在按保留天数和最大条数双重限制，默认保留 90 天且最多 10,000 条。
- 审计写入和裁剪串行化，裁剪使用原子替换，避免实时写入与维护互相覆盖。
- HTTP 和移动端均可按事件名、起止时间和数量查询最新审计记录，也可手动触发历史维护。
- 每个项目每天最多自动维护一次；state 中的 snapshot、task、instruction、notification 继续使用已有条数上限。
- SQLite 继续作为 `SupervisorStateStorage` 后面的可选后端；当前单写入者和有限查询量不足以证明引入数据库迁移的收益。
- `npm run check` 通过，共 101 项测试。

### Release 0.5.0 候选版本（2026-07-10）

- `package.json`、`package-lock.json` 和 `openclaw.plugin.json` 已统一升级到 0.5.0。
- 已形成覆盖 Phase 9–22 的变更记录，以及从 0.4.0 升级和回滚的迁移说明。
- `release:check` 会执行全量测试、版本与文档校验、Git 空白检查和 `npm pack --dry-run`。
- 生产构建已排除测试产物；候选包包含 25 个文件，大小 72.1 kB。
- OpenClaw 成功加载 0.5.0，`plugins doctor` 未发现插件问题。
- 尚未执行提交、打标签、推送和远端部署。

## 后续候选阶段

- Release 0.5.0 远端发布：审查差异、形成提交、打标签并部署。
- Phase 23：发布后运行观测、故障恢复演练和真实多项目稳定性验证。

## 本阶段复盘

最重要的进展：监督器已经从单项目观察器发展为可选托管 Worker、持续扫描多项目并保留可查询审计历史的控制面。

最重要的弱点：真实长期运行、进程崩溃恢复和远端部署还没有经过持续时间足够长的稳定性验证。

下一小步：先审查并发布 0.5.0，再通过真实多项目运行验证决定 Phase 23 的优化方向。
