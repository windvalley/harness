# 实施方案：远程交付模式（M1）

<!-- 用户授权后按本文连续执行，每完成一步在下表标出完成与验证方式。 -->

- 行为说明：同目录的 spec.md
- 验收清单：同目录的 acceptance.md
- 版本：0.9.0

## 验收与测试

测试放在新文件 `test/delivery.test.mjs`。
远程用本地裸仓库，`git push` 与 `git fetch` 走真实的 git。
平台命令用假的 `gh`、`glab`，记录参数并返回 JSON，做法与 `test/helpers.mjs` 的 `fakeCodex` 一致。

| 验收条目 | 测试 | 层级 |
| --- | --- | --- |
| R1 | 现有 `test/*.test.mjs` 全部回归 | 集成 |
| R2 | 远程模式下 merge 拒绝且主分支不变 | 集成 |
| R3、R4 | submit 推送核对过的提交并创建 MR，描述含门禁结果 | 集成 |
| R5 | 已有 MR 时只替换管理区块；区块替换保留其他文字 | 集成、单元 |
| R6 | status 在远程模式下提示 submit，显示 MR 链接与过期 | 集成 |
| R7 | sync 快进主分支、同步文件、执行后置命令 | 集成 |
| R8、X6 | 远程改了门禁文件时 sync 要求确认，确认后导入；目标提交关掉确认开关仍要确认 | 集成 |
| R9 | 改 `delivery` 段在 `confirmOnGateChange=false` 时 merge、submit、sync 都要确认；只把缺省值写成显式 `local` 不要求确认 | 集成 |
| R10 | 首次接入分支确认后可以 submit，sync 导入沿用确认 | 集成 |
| R11 | 本地模式下 sync 快进 | 集成 |
| R12 | `install --version` 只装版本目录，项目文件不变 | 集成 |
| R13 | doctor 的远程模式检查 | 集成 |
| R14 | 托管块与规则文本断言 | 集成 |
| R15 | init 生成的配置含 `delivery.mode: local`；已有配置的项目 init 与 upgrade 后没有 `delivery` 段 | 集成 |
| R16 | 开启远程交付的分支确认后 submit 推送并建 MR，确认摘要列出授权范围；sync 导入后 merge 拒绝 | 集成 |
| R17 | 关闭远程交付的分支在远程模式下 submit，sync 导入后 merge 恢复 | 集成 |
| X1 | 核对完成后分支前进时拒绝，不推送 | 集成 |
| X2 | 远程同名分支分叉时拒绝，不强推 | 集成 |
| X3 | 源为主分支、远程跟踪引用、提交号时拒绝 | 集成 |
| X4 | 本地主分支落后或领先远程时 `base_stale` | 集成 |
| X5 | 本地主分支有未推送提交时 sync 拒绝 | 集成 |
| X7 | 主 Worktree 不洁净或持有合并锁时 sync 拒绝 | 集成 |
| X8 | 假命令收到的参数和环境里没有 harness 设置的令牌 | 集成 |
| X9 | 假命令记录的调用里没有合并子命令 | 集成 |
| X10 | 本地模式下没有开启远程交付的分支 submit 以 `delivery_local` 拒绝；开启的分支确认前拒绝，均不推送 | 集成 |
| F1 | 平台命令缺失或认证失败时不推送 | 集成 |
| F2 | 远程不可达时拒绝 | 集成 |
| F3 | 推送后创建 MR 失败，重跑只补 MR | 集成 |
| F4 | 目标锁定的版本没装时 sync 拒绝 | 集成 |
| F5 | sync 后置命令失败时报告主分支已更新 | 集成 |

## 实现顺序

| 步骤 | 改动 | 验证方式 | 状态 |
| --- | --- | --- | --- |
| 1 | 写出上表测试与夹具（裸仓库远程、假 `gh` 与 `glab`），逐个运行，确认因为行为未实现而失败 | 命令与失败输出 | 完成，32 条用例，未实现时 30 条失败 |
| 2 | `delivery` 配置的解析、规范化与校验，配置写错时给出明确报错；`init` 默认写入 `mode: local` | 单元、R15 | 完成，`src/lib/config.mjs` 的 `deliverySettings` 等 |
| 3 | 把 `mergeTask` 里的门禁核对抽成共用函数，`merge` 改用它，行为不变 | R1 全量回归 | 完成，`checkGates`、`advanceMain`、`afterMainUpdate` |
| 4 | 交付设置变化强制要求确认，确认摘要列出交付设置变化与授权范围，先覆盖 `merge` | R9 的 merge 用例 | 完成，R9、R16 |
| 5 | `install --version`；`sync`：取得远程主分支、祖先检查、按旧配置判门禁、确认、锁、令牌写入、文件同步、刷新安装、后置命令 | R7、R8、R10、R11、R12、X5、X6、X7、F2、F4、F5 | 完成，`src/delivery/sync.mjs` |
| 6 | `submit`：源分支校验、C 等于 B、共用核对、平台命令预检、推送 H、创建或更新 MR/PR、`submit` 记录与重试；开启远程交付的分支按确认后的分支提议运行 | R3 到 R5、R10、R16、R17、X1 到 X4、X8 到 X10、F1 到 F3 | 完成，`src/delivery/submit.mjs` 与 `platform.mjs` |
| 7 | 远程模式下 `merge` 拒绝；`status`、`doctor` 适配 | R2、R6、R13 | 完成 |
| 8 | 托管块、`core.md`、`harness.md`、`git-safety` 提示、参考手册、教程、README、变更记录；版本 0.9.0 | R14 与全量回归 | 完成，231 项全量回归通过 |
| 9 | 真实平台实测，需要你提供条件，见“环境与依赖” | 实测记录 | 未开始，等环境 |

## 交付前检查

- `npm test` 全量通过，新增用例逐条对应验收清单。
- 文档没有长破折号，每句单独一行。
- 用 codex 评审最终 diff，方式与这次方案评审相同。
- 汇报区分“假命令验证”和“真实平台实测”。

## 环境与依赖

- 本机有 `gh` 2.94，`gh pr list`、`gh pr create`、`gh pr edit` 需要的参数已在本机帮助里核对；认证状态未检查。
- 本机没有 `glab`，`glab mr` 的参数没有验证。
  对公司 GitLab（`code.geelib.qihoo.net`）实测，需要你安装 `glab` 并登录该主机。
- 对 GitHub 实测需要一个测试仓库，以及你对推送与建 PR 的明确授权。
- 测试夹具只用本地裸仓库，不联网。

## 复用

- `src/merge/merge.mjs` 的合并锁、`ensureMainReady`、令牌写入与 `read-tree` 回退、入口刷新与后置命令。
- `src/confirm/confirm.mjs` 按 tree 绑定的确认，`confirm --branch <远程>/<主分支>` 直接用于同步确认。
- `src/lib/store.mjs` 的签名记录。
- `src/review/review.mjs` 解析外部命令输出的做法。
- `test/helpers.mjs` 的 `fakeCodex` 夹具做法。

## 恢复

- 远程模式默认关闭。
  出问题时把 `delivery.mode` 改回 `local`，这是门禁改动，确认后合入即恢复现有流程。
- 所有拒绝都不改远程和本地主分支。

## 执行记录

- 前置修复已完成：证据复用比较检查定义、主分支在评审后改了同一批文件时 `review_stale` 拒绝，提交 `1a3fcdd` 已合入本地 main，199 项回归通过。
- 已确认：远程交付默认关闭，`init` 显式写入 `mode: local`；开启路径按首次接入的做法处理，关闭走普通提交流程。
- 用户已授权实施，按上表第 1 到第 8 步完成：交付配置、共用门禁核对、`install --version`、`sync`、`submit`、`status` 与 `doctor` 适配、文档与 0.9.0 版本号。

## 执行记录（续）

- 门禁：`npm test` 231 项通过（原有 199 项加新增 32 项），新增用例全部对应验收清单条目。
- 伪造验证的范围：远程用本地裸仓库，平台命令用假的 `gh` 与 `glab`，参数形状按本机 `gh 2.94` 帮助核对。
  `glab` 的参数没有在本机实测，真实平台实测（第 9 步）未开始。
- 交接说明：`submit` 的描述区块、`sync` 的确认与版本检查都在 `src/delivery/` 下，`merge` 的共用部分在 `src/merge/merge.mjs`。
- 用 codex 评审了提交 `9541e2a` 的 diff，9 条发现逐条核对后处理，提交 `d17d08f`：
  平台调用绑定获授权仓库（`--repo`）并排除 fork 的同名分支 PR、`glab` 查询要求 JSON 与 `opened` 状态、
  重试改查远程真实顶端、`sync` 与 `submit` 的配置与基线取自同一提交、`.harness/VERSION` 纳入门禁与版本一致性检查、
  首次接入的远程可用 `--remote` 指定、诊断信息脱敏。
  每一条都补了回归测试，其中“主分支在同步过程中被推进”的用例在旧写法下确实失败。
  回归从 231 项增至 239 项，全部通过。
- 仍未验证：真实 GitHub/GitLab 仓库上的 `gh pr`、`glab mr` 行为（第 9 步）。
