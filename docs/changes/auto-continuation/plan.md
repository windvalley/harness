# 失败即续跑：用客户端钩子自动接到下一轮

- 验收清单：`docs/changes/auto-continuation/acceptance.md`
- 任务分级：先方案后实施。
  理由是新增钩子事件处理、后台续跑进程与人工授权开关，改动跨适配器、CLI、门禁规则与会话记录，风险面涉及“无人监督连续执行”。

## 背景与结论先行

告警中心四阶段实施中，会话反复停下。0.21.0 解决了前两类：收尾检查不再催着去验证、同一状态拦三次、阶段之间自动接续。

第三类没解决：2026-11-17 20:58 那一轮以 `API Error: Upstream request failed` 结束。
Claude Code 此时触发 `StopFailure` 而不是 `Stop`，而 `StopFailure` 文档写明是 fire-and-forget，钩子的输出与退出码都被忽略，所以钩子本身无法让这一轮继续。

用户提出的方向是：不新增 `harness drive` 命令，直接用 `StopFailure` 钩子触发续跑。
本方案采纳这个方向，并说明它成立的前提与必须补的那一部分。

技术事实（已核实）：

- Claude Code 2.1.326 的 `StopFailure` 输入是 `{hook_event_name, error, error_details?, last_assistant_message?}` 加通用字段，**包含 `session_id`**，与 `Stop` 共用同一套会话标识。
- 钩子执行是 `await` 的，不是纯后台；但输出与退出码被忽略，因此钩子能做的只有“自己去做事”，不能“要求客户端继续”。
- 它**替代** `Stop` 触发：一轮以 API 错误结束时只发 `StopFailure`，不发 `Stop`。
  这解释了本次中断为什么收尾检查完全没发声：那一轮根本没有走到收尾检查。
- 全部错误类型：`rate_limit`、`overloaded`、`server_error`、`max_output_tokens`、`invalid_request`、`model_not_found`、`verification_required`、`unknown`、`authentication_failed`、`oauth_org_not_allowed`、`account_on_hold`、`billing_error`、`cloud_credential_error`。
- 本次中断的错误是 `unknown`（`Upstream request failed`）。

因此可行的做法是：`StopFailure` 钩子在同进程内**拉起一个新的无头续跑进程**去接着做欠项，而钩子自己正常退出。
续跑进程是一次新的客户端调用，必然要消耗一次新的会话轮次，这正是“自动续跑”的代价与含义。

## 设计

### 一、钩子只做判断与派发，不做长任务

`StopFailure` 钩子 `hook --client claude --event stop-failure`：

1. 读载荷里的 `session_id` 与 `error`。
2. 用与收尾检查完全相同的一套读取，计算该会话经手的任务分支欠项。
3. 按配置决定是否续跑：
   - 无欠项、只差人来处理、已有未解除上报：不续跑，写一条账本记录后退出。
   - 有 Agent 能接着做的欠项：进入下一步。
4. 派发一个 detach 的续跑进程后立即返回 0。

如果钩子内部同步跑续跑，客户端钩子超时会把钩子杀掉，而且用户终端会卡住，所以必须 detach。

### 二、续跑进程：一次新的无头会话轮次

`harness continue --session <id>`（内部命令，也允许人手动运行）：

- 拼出 `claude -p --resume <会话> --permission-mode <模式> --output-format json "<本轮提示>"`。
- 本轮提示由 harness 生成：欠项清单、下一步命令、以及“每一轮以工具调用推进”的要求。
- 跑完一轮后重新计算欠项：仍有欠项就再来一轮，直到完成、要人、连续无进展或到达上限。
- 每轮写 `continue.round`，停下写 `continue.stop`，含会话、轮次、欠项快照与停止原因。

换句话说：**stop 钩子负责“会话停下时提醒 Agent”，StopFailure 钩子负责“会话出事时把 Agent 拉起来”**，两者共用同一套欠项判定，不重复设计。

### 三、只有人授权过一次才允许自动续跑

这是本方案唯一的安全开关，缺省关闭。

- `.harness/config.json` 新增 `continuation`：
  - `enabled`：缺省 `false`。为 `false` 时 `StopFailure` 钩子只记一条 `continue.notice`，在账本与 `status` 里显示“这一轮因 X 中断，仍有欠项，可运行 harness continue 续跑”，不做任何自动动作。
  - `maxRounds` 缺省 20，`maxIdleRounds` 缺省 3，`maxFailures` 缺省 3，`maxSameErrors` 缺省 2。
  - `permissionMode` 缺省 `bypassPermissions`（按用户此前的选择），`client` 缺省 `claude`。
  - `skipErrors` 缺省空数组，见下一节。
- 打开 `enabled` 是门禁改动，需要人确认；Agent 不能自行打开。
- 新增门禁规则：`harness continue` 与改动 `continuation` 配置都只能由人发起。
  Agent 在自己的会话里运行 `harness continue` 会被拒绝，理由是它会在当前会话之外再开一个无人监督的执行者，Agent 既看不到结果也无法对后果负责；需要续跑时由钩子派发或由人运行。
- 续跑进程里的 Agent 拿不到任何新增权限：`harness approve`、`harness confirm --yes`、`harness escalate resolve` 仍由既有人工规则拦截。

### 四、错误分类：缺省全部续跑，靠兜底停下

不按错误类型做白名单。理由是白名单本身要猜，而绝大多数错误都能靠新的一轮改变请求而恢复：

| 错误 | 新的一轮能否推进 | 做法 |
| --- | --- | --- |
| `rate_limit`、`overloaded`、`server_error`、`unknown` | 通常能，等一等或重发即可 | 续跑，先退避等待 |
| `max_output_tokens` | 能，让模型接着写并缩短单次输出 | 续跑，提示里说明上一轮被截断，从断点继续并控制输出长度 |
| `invalid_request` | 常能，多是工具参数或上下文形态问题 | 续跑，提示里要求先读回失败点、修正参数后重试 |
| `model_not_found`、`cloud_credential_error` | 能，换备选模型或另一凭据 | 续跑，提示里说明模型或凭据不可用，按配置换用备选 |
| `verification_required`、`authentication_failed`、`oauth_org_not_allowed`、`account_on_hold`、`billing_error` | 通常靠人处理，但重试代价几乎为零 | 仍续跑一次，连续出现即停 |

- 缺省行为：`StopFailure` 一到就续跑，不判断错误类型。
  最后一行的几种错误多数在请求被受理前就失败，重试代价通常很低；“先试一次、连续同错误就停”比预先判定哪些错误不可恢复更省事，也少一个要维护的名单。
  这一条的实际代价在实施时用实测记录（重试次数与花费）确认，不只凭推断。
- 兜底判据比错误类型更可靠：
  - 同一错误连续 `maxSameErrors` 轮（缺省 2）出现且指纹没变，立即停，判为人处理并写明错误类型。
  - 连续 `maxFailures` 轮（缺省 3）失败停。
  - 指纹连续 `maxIdleRounds` 轮（缺省 3）不变停。
  这三条同时覆盖偶发抖动与稳定失败，不需要事先知道哪些错误是稳定的。
- 每轮的提示按错误类型附带恢复建议（上表右列），由 harness 生成，不指望模型自己推断上一轮为什么断。
- `continuation.skipErrors` 是减法项：用户确实不想为某类错误续跑时填进去，例如在有计费告警的环境里填 `billing_error`。
  它不是缺省策略。

### 四、防递归与防并发

- 续跑进程启动时在环境变量里带 `HARNESS_CONTINUATION=1`，派生的钩子据此不再派发新的续跑，避免套娃。
- 会话级锁：同一 `session_id` 同时只允许一个续跑进程，第二个进程检测到锁后退出并记账。
- 客户端进程探测：续跑前若发现该会话正被另一个客户端进程占用（用户重新打开了终端），不续跑并记账“已由用户接管”。
- `-p` 模式下若无头会话本身也触发 `StopFailure`，由第 1 条阻断递归；由 `maxFailures` 兜底停下。
- 退避：续跑前按错误类型等待，`rate_limit` 与 `overloaded` 等待时间较长（缺省 60 秒起，逐轮翻倍，上限 10 分钟），其余类型不等待。
  等待期间保持会话锁，用户随时可以打断。
- 退出条件：完成、要人、同一错误连续 `maxSameErrors` 轮且指纹不变、连续 `maxFailures` 轮失败、指纹连续 `maxIdleRounds` 轮不变、到达 `maxRounds`、被用户接管。

### 五、Codex 与其他客户端

- Codex 的钩子事件只有 `pre-tool-use`、`post-tool-use`、`stop`、`session-start`、`user-prompt-submit`、`subagent-start`、`subagent-stop`、`pre-compact`、`post-compact`、`permission-request`、`interrupt`，**没有 `StopFailure`**。
  Codex 一轮出错时是否触发 `stop` 需要实测；若触发，则同一套 `stop` 钩子已经覆盖，只是续跑触发器换成 `stop` 里的“失败判定”。
- 因此本方案的实现分两层：
  - 判定与派发逻辑与客户端无关（`src/continue/`）。
  - 每个客户端一个触发器：Claude Code 用 `StopFailure`（已确认可用）；Codex 用 `stop` 加错误检测（实施时实测确认）；其他客户端用通用命令模板 `hook --client generic --event stop-failure`。
- 通用命令模板配置放在本机 `~/.config/harness/continue.json`，支持 `${session}`、`${prompt}` 占位符与 `json`、`jsonl`、`text` 三种输出解析，第三方 Agent 不需要为它写代码。

### 六、进度可见与通知：静默记账不够

先说一个不能绕过的限制：`StopFailure` 钩子的输出与退出码都被客户端忽略，所以**钩子这一侧没有任何办法把字打到用户终端上**。
只写账本的话，用户在下次运行 `harness status` 或打开 `audit` 之前根本不知道会话已经被续跑，这在“自动替你花钱跑模型”的场景下不可接受。

所以方案要求四个通道同时存在，缺省全部开启，用户不需要配置任何东西就能知道：

1. **会话内可见（主要通道）**：续跑默认续同一会话，每轮的提示由 harness 写成一条用户消息，内容是“自动续跑第 N 轮、上一轮因什么中断、当前欠项、下一步”。
   用户下次 `/resume` 或 `claude --resume <会话>` 打开时，第一眼看到的就是这些轮次，和手动输入“继续”完全一样。
2. **启动即通知（主动通道）**：`notify` 在**续跑开始时**触发一次，不是只在停止时。
   内容含会话、中断错误类型、第 1 轮要做的欠项。
   停止时再触发一次。两次都带 `${session}`、`${rounds}`、`${reason}`。
   未配置 `notify` 时，退化为下一项的日志文件。
3. **日志文件与 status 实时行（无需配置）**：续跑进程的 stdout 与 stderr 写到 `.git/harness/continue/<会话>.log`。
   会话锁存在期间，`harness status` 显示一行 `continuation: 进行中 会话 <id> 第 N 轮 上一轮 <时间>`，并打印日志路径；锁释放后改为显示停止原因与总轮次。
   这样即使没配通知，用户随手看 `status` 就能知道有没有东西在替他跑。
4. **账本（事后核账）**：`continue.notice`（未启用时的提示）、`continue.dispatch`（派发成功，含轮次上限与错误类型）、`continue.round`、`continue.stop`、`continue.skip`。

`sleep` 与退避期间的等待也写进日志与 status 的“上一轮时间”，让用户能看出是“在等”还是“卡住”。

## 与收尾检查的关系

| 中断类型 | 谁负责 |
| --- | --- |
| Agent 正常结束、还有欠项 | `Stop` 钩子的收尾检查，最多拦 `stop.idleBlocks` 次 |
| 一轮因 API 错误、上下文耗尽等结束 | `StopFailure` 钩子派发续跑进程 |
| 阶段之间没有待办 | 收尾检查按阶段文件续跑；续跑进程同样能处理 |
| 只差人来做 | 两者都只提示，不动手 |

## 兼容性与默认行为

- `continuation.enabled` 缺省 `false`：不配置时不派发任何进程，只在账本与 `status` 里多一条提示，行为和 0.21.0 基本一致。
- 新增的钩子事件由 `install` 写入客户端配置，未安装或旧版本客户端不接受 `StopFailure` 时该钩子不会被调用，不影响现有 `Stop`。
- 新增门禁规则只匹配 `harness continue` 与 `continuation` 配置键。
- 不改动既有命令的参数与输出。

## 实施步骤

| 步骤 | 改动 | 验证方式 |
| --- | --- | --- |
| 1 | 写出失败用例：`stop-failure` 载荷被接收、未启用时只记账、`skipErrors` 生效、启用后派发、递归阻断、会话锁、接管检测、退避与各停止条件 | `node --test` 定向运行，记录失败输出 |
| 2 | 新增 `src/continue/`：欠项判定复用、派发、锁、进程模板与输出解析 | 派发与退出条件用例转绿 |
| 3 | `hook` 增加 `--event stop-failure`，`install` 为 Claude Code 写入 `StopFailure` 钩子 | 安装与钩子用例转绿 |
| 4 | 新增 `harness continue` 命令与 `status` 的续跑一行 | 命令级用例转绿 |
| 5 | 门禁规则、规则文档、参考手册与文档站 | `npm run docs:build` 并审查生成差异 |
| 6 | 用假客户端做端到端：模拟一轮 `unknown` 错误后自动续跑并推进到完成 | 端到端用例与日志 |
| 7 | 真实客户端最少验证一条：制造一次可恢复的失败（或临时把 `skipErrors` 之外的错误都放开），确认钩子真的派发且续跑轮次落在同一会话 | 实测记录 |
| 8 | Codex 的 `stop` 失败触发实测，确认后可接入或不接入 | 实测记录与结论 |
| 9 | 全量回归 | `npm test`、`npm run docs:check`、`git diff --check` |
| 10 | 独立评审，合并本地 `main`，推送 `origin main`，删除任务分支 | 评审结论与合并记录 |

不修改版本号与 CHANGELOG，不打标签，发版另行授权。

## 已知限制

- `StopFailure` 是 fire-and-forget：钩子无法“让这一轮继续”，只能另起一轮；每续一次都是一次新的模型调用。
- 缺省对所有错误都续跑一次，包括需要人处理的鉴权、计费类错误。
  它们靠“同一错误连续 `maxSameErrors` 轮即停”兜底，最坏是多跑一两轮；这几类通常在请求发出前失败，实际代价很低。
- 续跑进程与用户终端会话并发写同一会话时，客户端行为未被规范，靠会话锁与进程探测尽量避免；探测不到的极端情况仍可能两边同时续跑。
- 客户端不支持落盘会话时无法续跑，只能退化为“记一条提示”。
- `bypassPermissions` 下任何客户端本身允许、而 harness 规则没覆盖的动作都会被真正执行。

## 待确认

- 通知通道缺省是否需要 `notify` 才算可用。当前设计是不配置也有会话内消息、日志文件与 `status` 实时行，`notify` 只是更主动的补充。
- 每轮是否都在日志里写一条独立分隔行，便于人直接 `tail -f` 跟进度；当前设计是写，但未在验收里单独列出。

## 方案评审

本仓库没有配置方案评审者，本轮未运行方案评审。
