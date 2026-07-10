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

### 1. Worker 仍是手动启动

Codex Worker Adapter 已经可运行，但目前主要通过独立 CLI 启动。OpenClaw 服务还不会根据配置自动启动、停止和展示 Worker runtime 状态。

### 2. 第三方 Provider 需要显式配置

本机 standalone Codex CLI 没有自动加载 Codex App 写入的 custom-provider 表。真实联调需要显式传递 `mirror` Provider metadata。API Key 不应放入命令行参数；凭据应继续由环境变量或本地代理管理。

### 3. 只持续扫描 active project

Registry 可以保存多个项目，但定时扫描、项目告警和通知投递仍以 active project 为主。未激活项目不会持续刷新完整监督状态。

### 4. 历史指令缺少正式解决流程

失败或 ignored 指令会持续产生监督信号。当前可以通过后续回执说明成功重试，但还没有正式的 `resolved`、`superseded` 或人工关闭操作。

### 5. 仍缺少发布收尾

- 当前版本仍为 `0.4.0`。
- 尚未形成 Phase 18 对应的正式 release notes。
- 本地提交需要按发布计划推送到远端。

## 下一阶段：Phase 19

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

## 后续候选阶段

- Phase 20：后台扫描全部注册项目并聚合跨项目告警。
- Phase 21：为 failed/ignored 指令增加 resolved、superseded 和人工关闭流程。
- Phase 22：历史保留策略、审计查询和可选 SQLite 存储。
- Release 0.5.0：版本升级、迁移说明、发布检查和远端部署。

## 本阶段复盘

最重要的进展：监督器已经首次真正驱动 Codex CLI 完成批准指令，而不只是观察文件状态。

最重要的弱点：Worker runtime 的启动与 Provider 配置仍依赖人工命令，不适合长期无人值守运行。

下一小步：先实现 Phase 19 的 runtime 配置模型和生命周期，不继续扩展新的监督信号。

