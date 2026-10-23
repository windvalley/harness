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

拦截信息里带 `正确做法`，按它改道，不要尝试绕过。常见项：

- 生成文件：改真实源文件后运行生成器。
- 基线、归档与迁移账本：新增迁移，不改历史。
- 密钥文件：只读同名 `.example`。
- 不可逆命令：列出具体对象请用户确认。

## 门禁改动

`.harness/config.json`、`policy.json`、`verify.json`、`rules/**` 允许直接修改，改动会被记录并在合并前要求人工确认（`harness confirm --branch <分支>`）。
`.harness/bin/**` 是执行器入口，只由 `harness install` 生成；它决定跑哪一份门禁代码，因此改动同样在合并前要求确认，不要手改。

`.husky/**`、`.githooks/**`、`.claude/settings.json`、`.codex/hooks.json` 是客户端与 git 钩子的入口，Agent 不能改写；需要重装时由用户运行 `harness install`。

## 多个 Worktree

入口 `.harness/bin/harness` 随仓库提交，Linked Worktree 检出后即可用。git 钩子调用主 Worktree 的入口，任务分支改不了门禁代码自己的行为。

## 例外上报

需要人决定时用 `harness escalate open` 提交，内容包含现象、已尝试、阻塞点和至少两个选项。
人用 `harness escalate answer --id <编号> --choice <选项>` 答复，续跑前用 `harness escalate resume --id <编号>` 读取决定。

## 度量

`harness metrics` 输出按周统计：合并次数、验证首过率、复用检查数、评审拒绝率、策略拦截、门禁确认和黄金任务通过率。
`harness conformance` 逐项判定 L3 判据，样本不足的项标 `PEND`，不计为完成。
