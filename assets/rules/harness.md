# Harness 门禁

本项目的本地门禁由 harness 提供。所有判定在本机完成，结果写入账本，不依赖云端。

## 一次任务

1. 在任务分支里实现并提交。提交信息按项目规范，`commit-msg` 钩子会校验。
2. `harness verify --branch <任务分支>`：在固定检出目录里按改动路径选择检查集，结果写成绑定该分支提交的签名证据。主分支自上次验证后新增的改动若未触及某项检查，那项检查直接复用。
3. `harness review --branch <任务分支>`：独立评审只读验收清单、证据摘要和 diff，分需求符合度与工程质量两个维度。有 high 或 critical 级别的发现会被拒绝。
4. `harness merge --branch <任务分支>`：核对证据与评审，合并到主分支。改动涉及门禁配置时必须先由人确认。

## 验收清单

放在 `.harness/acceptance/<任务分支名，/ 换成 ->.md`，每条写成能用测试或命令验证的结果。

- 清单可以随任务分支提交，评审会标注来源为“任务分支，尚未经人工确认”。
- 清单也可以先合入主分支，评审标注来源为“主分支已确认”。
- 没有清单时，需求符合度只能记为 `unknown`，评审只评工程质量。

## 被拦截时

拦截信息里带 `正确做法`，按它改道，不要尝试绕过。
实际生效的规则以 `.harness/policy.json` 为准，`harness rules` 可以列出全部规则。预设规则的常见项：

- 密钥文件：只读同名 `.example`。
- 不可逆命令：列出具体对象请用户确认。
- 主分支：只通过 `harness merge` 更新。

项目自己加的规则（例如生成文件、迁移基线）同样按拦截信息里的正确做法处理。

## 门禁改动

`.harness/config.json`、`policy.json`、`verify.json`、`rules/**` 允许直接修改，改动会被记录并在合并前要求人工确认（`harness confirm --branch <分支>`）。
`.harness/bin/**` 是执行器入口，`.husky/**`、`.githooks/**`、`.claude/settings.json`、`.codex/hooks.json` 是客户端与 git 钩子的入口。
它们只由 `harness install`（或 `init`、`upgrade`）生成，Agent 不能手改，但可以在任务分支运行这些命令重新生成；改动同样在合并前要求人工确认。

## 多个 Worktree

入口 `.harness/bin/harness` 随仓库提交，Linked Worktree 检出后即可用。git 钩子调用主 Worktree 的入口，任务分支改不了门禁代码自己的行为。
`harness merge` 在主 Worktree 里更新主分支，要求它停在主分支、洁净、没有进行中的 git 操作；`harness status` 与 `harness doctor` 会提前列出不满足的项。
`.harness/policy.json` 的 `presets` 里有 `main-worktree` 时，主 Worktree 只用来合并：

- Agent 不能改主 Worktree 里被 git 跟踪或未忽略的文件，被 `.gitignore` 忽略的本机文件不受限。
- Agent 不能在主 Worktree 里切离主分支。
- 任何人都不能在主 Worktree 里提交。
- 新任务用 `git worktree add -b <任务分支> <路径> <主分支>` 建 Linked Worktree，在那里修改、提交。
  会话停在主 Worktree 时，改 Linked Worktree 里的文件按那个 Worktree 判定；命令按段跟着前面的 `cd` 与 `git -C` 推算所在目录。
  目录无法确定的段（`cd "$变量"`、`cd -`、管道里的 `cd`、`GIT_DIR`）按最严格处理，要在别的 Worktree 执行就写明绝对路径。

## 例外上报

需要人决定时用 `harness escalate open` 提交，内容包含现象、已尝试、阻塞点和至少两个选项。
人用 `harness escalate answer --id <编号> --choice <选项>` 答复，续跑前用 `harness escalate resume --id <编号>` 读取决定。

## 度量

`harness metrics` 输出按周统计：合并次数、验证首过率、复用检查数、评审拒绝率、策略拦截、门禁确认和黄金任务通过率。
`harness conformance` 逐项判定 L3 判据，样本不足的项标 `PEND`，不计为完成。
