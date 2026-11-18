# 失败即续跑验收

## 范围

新增 `StopFailure` 钩子处理与 `harness continue` 后台续跑，缺省关闭；不改既有命令行为，不自动执行需要人完成的动作。

## 触发器

- `hook --client claude --event stop-failure` 能接收 `{session_id, error, error_details?, last_assistant_message?}` 载荷，钩子入口退出码为 0 且不向客户端输出拦截结果。
- `continuation.enabled` 为 `false` 时只记 `continue.notice`，并在 `harness status` 里显示可续跑提示，不派发进程。
- 缺省不对错误类型做白名单：任何 `StopFailure` 错误在启用后都会派发一次续跑。
- `continuation.skipErrors` 命中时只记 `continue.skip`，不派发进程。
- 同一错误连续 `maxSameErrors` 轮出现且进展指纹不变时停止，原因为需要人处理，并写明错误类型。
- `rate_limit` 与 `overloaded` 续跑前有退避等待，等待时间逐轮增长且有上限；其他错误不等待。
- 启用后存在 Agent 能接着做的欠项时，派发一个 detach 的续跑进程并立即返回。
- 无欠项或只差人来做时不派发，记录原因。

## 续跑进程

- 每轮拼出的命令包含原会话 ID、权限模式与 harness 生成的欠项提示。
- 一轮结束后重新计算欠项，仍有欠项则继续下一轮。
- 达到 `maxRounds`、连续 `maxIdleRounds` 轮指纹不变、连续 `maxFailures` 轮失败、被判定为用户接管时停止，并写明原因。
- 每轮提示包含该错误类型对应的恢复建议。
- 环境变量 `HARNESS_CONTINUATION=1` 存在时，派生的钩子不再派发新进程。
- 同一会话同时只有一个续跑进程；第二个进程检测到锁后退出并记 `continue.skip`。
- 会话被其他客户端进程占用时不续跑，记录“已由用户接管”。

## 授权边界

- Agent 通过工具运行 `harness continue` 被门禁拒绝并说明正确做法；人运行不受限。
- Agent 修改 `continuation` 配置被门禁拒绝；该配置是门禁文件，改动需要人确认。
- 续跑进程内 `harness approve`、`harness confirm --yes`、`harness escalate resolve` 仍被既有人工规则拦截。

## 通用性

- 判定与派发逻辑与客户端无关，按客户端只区分触发器。
- Claude Code 使用 `StopFailure`；Codex 是否用 `stop` 加失败检测由实测决定，结论写进交付说明。
- 本机 `~/.config/harness/continue.json` 支持命令模板与 `${session}`、`${prompt}` 占位符，以及 `json`、`jsonl`、`text` 输出解析；用假客户端证明非内置客户端可被驱动。

## 可见性与记录

- 每轮续跑在会话记录里留下一条 harness 写的用户消息，含“自动续跑第 N 轮”、上一轮中断的错误类型、当前欠项与下一步；`/resume` 后能直接读到。
- 配置了 `notify` 时，续跑**开始**触发一次、停止再触发一次，占位符替换正确；未配置时不执行外部命令。
- 续跑进程的输出写到 `.git/harness/continue/<会话>.log`，日志路径可从 `status` 与账本取得。
- 会话锁存在期间，`harness status` 显示 `continuation: 进行中`，含会话、轮次与上一轮时间；锁释放后显示停止原因与总轮次。
- 账本写 `continue.notice`、`continue.dispatch`、`continue.round`、`continue.stop`、`continue.skip`，内容含会话、轮次、欠项快照与原因。

## 兼容性

- 不配置 `continuation` 时既有命令输出与行为不变，除 `status` 新增的提示行与账本新增事件外。
- `Stop` 钩子的收尾检查行为不变。
- 新增门禁规则只匹配 `harness continue` 与 `continuation` 配置键。

## 交付

- 每条行为先有失败用例再实现，记录红灯命令与输出。
- 端到端用假客户端覆盖“失败后自动续跑直到完成”。
- `npm test`、`npm run docs:build`、`npm run docs:check` 与 `git diff --check` 通过。
- 完成独立评审，合并本地 `main` 并推送 `origin main`，删除任务分支。
- 不修改版本号与 CHANGELOG，不打标签。
