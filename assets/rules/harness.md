# Harness 门禁

本项目的本地门禁由 harness 提供。
所有判定在本机完成，结果写入账本，不依赖云端。
本文的流程与命令由 Agent 执行，标明必须由人的步骤除外。

## 接入项目

- 先阅读 harness 仓库的 README 与参考手册，调查项目规则、Git 状态、已有钩子和真实检查命令，并运行 `init --dry-run` 预览。
- 按项目约束选择接入方式，准备任务分支与需要的 Worktree，不要求用户预先创建。
  接入默认走受控流程，是否新建 Linked Worktree 取决于隔离需要与项目规则。
- 保留已有有效规则和检查，把起始检查对应到项目真实命令，明确占位与未执行项。
- 项目规则、`package.json` 的 `scripts` 和 `Makefile` 里规定的每条验证命令，都在基线提交上试跑一次再决定怎么配。
  能通过的配成带 `cmd` 的 `gate`。
  基线上就失败的不配成 `gate`，也不静默留成 `extended`：把失败原因当作基线问题列给用户，由用户决定先修基线、豁免还是改为手工验收。
  只能手工做的才用 `extended`，写明 `reason` 与 `howToVerify`，并在接入汇报里逐条列出，说明依赖它们的验收没有自动证据。
  接管原有工具或放弃某条规则需要用户决定时，先列出影响与选择。
- 项目有测试命令时，按真实的测试与覆盖率工具配置 `verify.json` 的 `testFirst` 与 `coverage`，`mode` 先写 `observe`，在真实改动上看过误报再改为 `enforce`。
  配置前先在基线上确认 `cmd` 能跑、`report` 真的会生成；推断不出的不要猜，在接入汇报里列为待补。
- 提交接入改动前和用户确定交付方式，见下面的“交付方式”：默认本地交付；主分支在 GitHub 或 GitLab 上、合并走 PR/MR 时，把 `delivery` 改为远程交付，接入分支本身就以 PR/MR 提交。
- `init` 写入结束时会打印“评审者”提示：本机有没有 `~/.config/harness/reviewers.json`，没有时评审实际会用哪个客户端和模型。
  Agent 把这段提示转述给用户，并询问是否现在配置评审者，不要默认跳过，也不要替用户选择模型或端点。
  用户要配置时，按提示里的 `harness reviewer set` 命令操作，key 由用户提供并经 `--api-key-stdin` 从标准输入传入，不写进命令行参数、提交说明或文档。
  用户暂不配置时，按提示里说明的缺省评审者继续，之后随时可以配置。
- 写入并提交接入改动，执行验证和独立评审，展示 `harness confirm --branch <接入分支>` 的摘要。
  带 `--yes` 的确认由人在自己的终端执行，自然语言同意不能替代，Agent 不代为执行。
- 人完成确认后按交付方式继续：本地交付完成已获授权的本地合并；远程交付运行 `harness submit --branch <接入分支>`，平台合入后在主 Worktree 运行 `harness sync`。
  然后列出当前客户端所需的重启、信任或注册操作。
  用户完成后再运行诊断，区分配置就位和当前客户端实际调用已验证，不把初始化成功作为全部接入完成。
- 合并后保留接入分支和任务 Worktree，清理遵循“收尾”。

## 升级项目

- 升级前先读 `CHANGELOG.md` 里从当前版本到目标版本的各段，向用户说明对该项目的影响。
- `upgrade` 只重写规则、模板、入口和钩子，不改 `config.json`、`policy.json`、`verify.json`。
  它结束时会列出“尚未配置的可选项”，Agent 把这段原样转述给用户，不要概括成“都没开”。
- 对列出的每一项，按项目实际情况给出建议，分三类汇报：
  - `risk`、`testFirst`、`coverage` 都有 `observe` 模式，只记录、不拦截。建议在升级任务里一并加上 `observe` 配置，由用户确认；`testFirst` 与 `coverage` 的命令按“接入项目”里同样的方式在基线上试跑，推断不出的列为待补，不要猜。
  - `requiredPaths` 没有 `observe` 模式，配置后无检查覆盖的改动路径会直接拦截。对照项目目录结构提出建议范围，由用户决定，不默认加。
  - `review-plan` 是命令，取决于本机 `reviewers.json`，不是项目配置，不属于未配置项。
- 这些改动是门禁文件改动，要走 `harness confirm` 的人工确认；用户选择暂不启用的，在汇报里写明，不反复追问。

## 一次任务

先按 `core.md` 判断任务分级：直接实施的任务从第 1 步开始；先方案后实施的任务，方案经用户授权后再从第 1 步开始。

1. 按项目规则准备任务分支和工作环境，需要 Worktree 时由 Agent 创建或复用符合隔离要求的目录。
   在任务分支里实现并提交，提交信息按项目规范，`commit-msg` 钩子按 `.harness/policy.json` 的 `commit-message` 规则校验，`verify` 与 `review` 也会在动手前再判一次。
   提交后、`harness verify` 之前按 `method-review.md` 自审，发现问题先改完再提交一次，然后去验证。
   自审改出的新提交会让已有证据与评审作废，所以不放在验证之后。
   自审不是门禁，不写记录，结论也不作为评审材料。
2. `harness verify --branch <任务分支>`：在固定检出目录里按改动路径选择检查集，结果写成绑定该分支提交的签名证据。
   主分支自上次验证后新增的改动若未触及某项检查，且这项检查的定义没有变，它直接复用。
3. `harness review --branch <任务分支>`：独立评审只读验收清单、证据摘要、提交说明、文件统计和 diff，分需求符合度与工程质量两个维度。
   有 high 或 critical 级别的发现会被拒绝。
   提交说明要如实写清改了什么，评审会核对它与 diff 是否一致。
   评审用哪个客户端和模型是本机设置，用 `harness reviewer list` 查看；不要直接读取或改写 `~/.config/harness/reviewers.json`，里面可能存着 key。
   评审报“没有评审者给出结论”时，把原因转告用户，由用户提供 key 或决定换哪个评审者；不要自己找 key，也不要为了通过评审换成更弱的评审者。
   评审用的端点地址和域名可能是内部网关：`harness review`、`status`、合并输出里会显示它们，只用于向用户汇报；提交说明、PR/MR 描述、文档和任何会推送出去的内容里不要写。
4. 按项目的交付方式交付：本地交付在已有合并授权的范围内执行 `harness merge --branch <任务分支>`，核对证据与评审后合并到主分支；远程交付执行 `harness submit --branch <任务分支>`，见“远程交付”。
   改动涉及门禁配置时必须先由人确认。
   主分支在评审之后改了本分支也改过的文件时，以 `review_stale` 拒绝：在任务分支上合并主分支并提交，再重新 verify、review。
5. 交付后任务 Worktree 保留，清理按下面的“收尾”由用户发起。
6. 汇报结果入口、逐条验收证据、验证与评审结论和最终状态：本地交付是已合并、待授权合并或阻塞；远程交付是已提交 PR/MR 待平台合并、平台已合入并已同步或阻塞。
   同时说明任务分支、提交和工作区位置，未执行项不能算作通过。

第 1 到第 4 步连续执行，中途不结束回复。
只差人确认门禁改动或用户同意实施时，说明要人做什么后结束；其他需要停下的情况（缺权限、需要用户拍板、没有合并授权、必要验证被外部问题阻塞、下面列出的其他要人处理的拒绝），先按“例外上报”提交上报，再结束并向用户说明。

### 门禁拒绝时

验证失败、评审拒绝、`review_stale`、合并冲突、`bad_commit_message`、`branch_commit_rule_invalid`、`branch_moved`、`main_moved` 这类拒绝由 Agent 按拒绝原因修改后重新 verify、review，再交付，不需要用户安排。
修复只能改实现、测试或提交本身：任务分支放宽不了门禁，删测试、弱化断言、跳过检查同样不允许。
需要人的拒绝停下来说明对象和做法：`gate_change_unconfirmed`（人确认门禁改动）、`risk_unconfirmed`（人确认高风险改动）、`plan_unapproved`（用户同意实施）、`platform_missing` 与 `platform_failed`（人安装或登录平台命令）、`version_missing`（人安装版本）、`push_rejected` 与 `not_fast_forward`（远程或本地主分支有来源不明的提交，由人判断）。
另外按 `core.md` 的停下条件处理：缺权限、需要业务拍板、改动范围明显超出方案、同一个问题连续三轮没有解决。

## 交付方式

门禁通过后怎样把改动送进主分支，由主分支上 `.harness/config.json` 的 `delivery` 决定。
两种交付方式只能选一种，同一时间只按其中一种交付：

- 本地交付（`"mode": "local"`）：`harness merge` 合入本地主分支，需要时由人推送。
  没有这一段时按本地交付，`init` 也会写出 `{ "mode": "local" }`。
- 远程交付（`"mode": "remote"`，`provider` 填 `github` 或 `gitlab`）：`harness submit` 推送任务分支并创建或更新 PR/MR，由用户或团队在平台上合并，合入后 `harness sync` 快进本地主分支。

本地交付下 `submit` 以 `delivery_local` 拒绝，远程交付下 `merge` 以 `delivery_remote` 拒绝；`sync` 只同步，两种方式下都能用。

从本地交付改为远程交付：

1. 由人在本机安装并登录 `gh` 或 `glab`，并让本地主分支与远程主分支一致（本地有未推送的提交时先由人推送），否则 `submit` 以 `base_stale` 拒绝。
2. Agent 在任务分支把 `delivery` 改为 `{ "mode": "remote", "remote": "origin", "provider": "github" }`，验证、评审后展示 `harness confirm` 摘要；摘要写明由此授予的推送与创建 PR/MR 的权限，由人确认。
3. Agent 运行 `harness submit --branch <任务分支>`，这一步就以 PR/MR 提交；平台合入后运行 `harness sync`，此后改走 PR/MR。

改回本地交付走同样的流程，把 `mode` 改回 `local`，平台合入后 `sync` 导入，此后恢复 `harness merge`。
交付设置的任何变化都要人确认，不受 `governance.confirmOnGateChange` 影响。

## 收尾检查

Claude Code、Codex 与 DeepSeek Harness 每次结束回复前会运行收尾检查：本会话推进过的任务分支（写过文件、提交过，或运行过 `approve`、`verify`、`review`、`merge`、`submit`）还没有交付，又没有上报阻塞时，检查会拦下结束，给出还差哪几步和下一条命令。

- 按提示接着做，直到合并（远程交付到 `submit`），不要换个说法再结束。
- 只差等用户同意实施、门禁改动的人工确认这类要人做的步骤时，检查放行，汇报里写明要人做什么。
- 上报之后分支没有新提交时，检查放行；接着干又提交了，旧的上报不再算数。
- 用户在本轮明确要求暂停时，在回复里照录用户原话说明为什么停下。
- 两次结束之间没有任何进展时检查放行，避免把会话困住，但会在账本记一次未上报的结束，`harness status` 会向用户显示。

## 远程交付

`delivery.mode` 为 `remote` 时，主分支在平台上，合并由团队走 PR/MR 与平台的保护规则。
harness 保证它提交的 PR/MR 通过了本机门禁；平台上最终合入什么，由团队在平台上配置的保护规则把关。
交付路径与本地交付不同：

1. 第 1 到第 3 步与本地交付相同：在任务分支实现、提交、`harness verify`、`harness review`。
2. `harness submit --branch <任务分支>`：核对与 `merge` 相同的条件，把核对过的那个提交普通推送到远程同名分支，并创建或更新指向主分支的 PR/MR。
   描述里 harness 只维护 `<!-- harness:submit:start -->` 与 `<!-- harness:submit:end -->` 之间的区块，团队写在区块外的说明不会被覆盖。
   提交记录分“已推送”与“PR/MR 已就绪”两个阶段；推送之后创建 PR/MR 失败时重跑只会补 PR/MR，不会重复推送。
3. 之后由人在平台上合并。harness 不在平台上合并，也不强推；远程同名分支已分叉时以 `push_rejected` 拒绝。
4. 平台合入后运行 `harness sync`：把本地主分支快进到远程主分支，同步主 Worktree 的文件，需要时刷新本机安装并执行 `merge.postMergeCommand`。
   远程带来的普通代码改动按“信任平台主分支”导入，不在本机重复验证与评审；远程带来的门禁改动、交付设置变化或首次接入仍然要人确认，确认命令是 `harness confirm --branch <远程>/<主分支>`。
5. 汇报时区分“已提交到平台”“平台已合入”“本地已同步”，不把提交成功说成已合并。

- `harness submit` 要求本地主分支等于远程主分支，不一致时先 `harness sync`，否则以 `base_stale` 拒绝。
- `harness submit` 只接受本地任务分支，不接受主分支、远程跟踪引用或提交号。
- 平台命令（`gh`、`glab`）的安装与登录由人完成，harness 不读取、不保存也不传递平台令牌。
- 本地交付下同样可以用 `harness sync` 把主分支快进到远程，取代由人用绕过开关手动快进的做法。

## 收尾：任务 Worktree 由用户发起清理

合并后保留任务 Worktree 和任务分支，不要自行删除：会话常常还停在里面，合并后也可能要回来补改，删除时还会连带删掉被忽略的本机文件。

- `harness merge` 的输出写明任务 Worktree 保留在哪里，以及已合并但还没清理的 Worktree 有几个；汇报时把这两点转告用户。
- 用户要求清理时，先运行 `harness worktree clean` 把预览交给用户：哪些可以删、会连带删掉哪些被忽略的文件，哪些跳过以及原因。
- 用户确认后运行 `harness worktree clean --yes`。
  预览里有含 `.env` 这类本机文件的 Worktree 时，用户明确同意删除这些文件才加 `--with-local-files`。
- 不要绕开这个命令自己删除：`git worktree remove --force` 与 `git branch -D` 会被拦截，它们会丢掉未提交的改动或未合并的提交。
- 不在会话里删除会话所在的 Worktree，`harness worktree clean` 也会跳过命令所在的 Worktree。

## 验收清单

放在 `.harness/acceptance/<任务分支名，/ 换成 ->.md`，按 `.harness/templates/acceptance.md` 写，每条写成能用测试或命令验证的结果。

- 清单可以随任务分支提交，评审会标注来源为“任务分支，尚未经人工确认”。
- 清单也可以先合入主分支，评审标注来源为“主分支已确认”。
- 没有清单时，需求符合度只能记为 `unknown`，评审只评工程质量。

## 方案评审

先方案后实施的任务，方案提交到任务分支后、交给用户之前，可以用另一个模型审一轮方案：

```text
harness review-plan --branch <任务分支> [--all]
```

- 它是建议，不是门禁：不写评审或证据记录，不影响 `approve`、`merge`、`submit`，也不会让已有评审过期；账本只追加一条 `plan.review` 事件，用于统计成本和命中情况。
- 评审者复用本机 `reviewers.json`，与代码评审采用相同的排序和密钥擦除规则。
  没有配置评审者、全部失败或结果不可信时，把原因转告用户并继续交付方案，不要为此换更弱的评审者或自己找 key。
- 命令定期显示评审者、耗时、剩余预算和最近活动。
  默认总时限 360 秒，每位最多 120 秒，并为备选评审者预留时间。
  用 `--timeout-seconds` 和 `--attempt-timeout-seconds` 按次调整。
  单次超时后由命令尝试备选，等待过程中根据进度和剩余预算判断状态。
- 默认只展示 high 及以上的发现，其余只给数量，`--all` 展示全部。
- 所有评审者都在任务分支的 Worktree 里运行，可以读仓库核对已有实现。
  claude 只开 Read、Grep、Glob 和只读的 git 查询，没有写入类工具，`.env`、`.pem`、`.key`、`id_rsa*`、`credentials*` 在工具层被屏蔽。
  codex 用只读沙箱，command 靠约定，两者无法在工具层屏蔽密钥文件，只读由事后比对兜底。
  任务分支没有检出在任何 Worktree 时，所有评审者只看提示里的三份方案文件，输出会写明“没有读仓库”。
- 评审前后会比对 Worktree 的 HEAD 与状态，发现被改动时以报错结束，不采信这次结果。
- Agent 逐条判断采纳与否，记在 `spec.md` 的“方案评审意见与处理”一节，不采纳的写理由；用户仍是唯一的实施授权人。
- 采纳了 high 及以上的意见并实质修改方案后才跑第二轮，最多两轮。

## 实施授权

`.harness/policy.json` 的 `presets` 里有 `plan-first` 时，“先方案后实施”由门禁兜底：

- 任务分支写了实施方案（默认 `docs/changes/*/plan.md`，包括还没提交的）而还没有授权记录时，Agent 只能写 `docs/changes/` 与 `.harness/acceptance/` 下的文件，写测试和代码会被拦截。
- 交出方案时，把验收清单、行为说明与实施方案提交到任务分支，向用户说明方案后停下。
- 方案交付后，用户在对话里明确同意实施该方案，才是这一阶段的实施授权，不要求固定措辞。
  最初提出需求或仅认可某个澄清答案，不能替代对已交付方案的实施授权。
  Agent 运行 `harness approve --branch <任务分支> --yes --note "<用户原话>"` 记录下来，然后连续实施到完成，不需要用户执行任何命令。
- `--note` 必须照录用户表示同意的原话，合并、`status` 与评审都会显示它；用户没有同意时不得记录，也不得改写或编造原话。
- 授权绑定验收清单的内容：之后要改清单，先向用户说明改动并取得同意，再重新记录；实施方案里的进度记录可以随时更新。
- 合并时，写了实施方案、改了库表相关文件（`intent.plan.triggers`）、改了依赖清单（`risk.deps`）或代码改动超过 `intent.plan.maxLines` 行的分支，必须有授权记录；没写方案就直接做了大改动的分支会在这里被拒绝。

## 风险确认

`.harness/config.json` 的 `risk.paths` 列出敏感路径（接入时默认放 CI 与部署文件，项目按需补充），`risk.exclude` 豁免其中的文档与测试夹具；`risk.mode` 为 `observe` 时命中的信号只记录、不拦截，`RISK 观察` 行与 `status` 里的 `risk` 一行照常显示，不需要为它停下或找人确认。
分支改动命中其中任何一个时，合并或提交前必须有人的确认记录，缺少时报 `risk_unconfirmed`，不要求先写方案。

- 提交后运行 `harness verify --plan --branch <任务分支>` 或 `harness verify` 时，输出里的 `RISK` 行会提前告诉你命中了哪些信号；要实施授权的，趁早补方案或把改动拆小，不要等到合并才发现。
- 风险确认排在验证与评审之后：先把验证和评审做完，再运行 `harness confirm --branch <任务分支>` 展示只读摘要，摘要列出命中的风险信号，然后停下，说明要人做什么。
- 合并或提交被拒时，输出会一并列出其他还没满足的人工项，一次告诉用户，不要分多轮追问。
- 带 `--yes` 的确认只能由人在自己的终端执行，Agent 不得执行，也不得用引号、变量等写法拆开命令绕过；对话里的“同意”不能替代。
- 确认绑定合并结果的 tree，分支再提交或主分支前进让结果变了，要重新确认。
- 要授权与要确认的信号各管各的：一次改动同时命中两类时，两个要求都要满足，确认不能替代授权，授权也不能替代确认。
- 判定读主分支的配置；任务分支改了 `risk` 或 `intent.plan` 属于门禁改动，确认摘要会列出改前改后。

## 被拦截时

拦截信息里带 `正确做法`，按它改道，不要尝试绕过。
实际生效的规则以 `.harness/policy.json` 为准，`harness rules` 可以列出全部规则。
预设规则的常见项：

- 密钥文件：只读同名 `.example`。
- 不可逆命令：列出具体对象请用户确认。
- 主分支：本地交付只通过 `harness merge` 更新；远程交付不本地合并，用 `harness submit` 提交、`harness sync` 同步。

项目自己加的规则（例如生成文件、迁移基线）同样按拦截信息里的正确做法处理。

## 门禁改动

`.harness/config.json`、`policy.json`、`verify.json`、`rules/**` 允许直接修改，改动会被记录并在交付前（`merge` 或 `submit`）要求人工确认（`harness confirm --branch <分支>`）。
`.harness/bin/**` 是执行器入口，`.husky/**`、`.githooks/**`、`.claude/settings.json`、`.codex/hooks.json` 是客户端与 git 钩子的入口。
它们只由 `harness install`（或 `init`、`upgrade`）生成，Agent 不能手改，但可以在任务分支运行这些命令重新生成；改动同样在交付前要求人工确认。

## 多个 Worktree

入口 `.harness/bin/harness` 随仓库提交，Linked Worktree 检出后即可用。
git 钩子调用主 Worktree 的入口，任务分支改不了门禁代码自己的行为。
`.harness/config.json` 配置了 `git.hooksDir` 时，钩子整份生成在那个目录，`core.hooksPath` 指向主 Worktree 里的这一份，所有 Worktree 执行同一份钩子。
项目自己的检查写在 `git.projectHooks` 目录下的同名可执行脚本里，harness 检查通过后调用，Agent 可以直接维护；生成的钩子不手改，改配置后运行 `harness install` 重新生成。
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
阻塞的是某个任务分支时，在 `context.branch` 填这个分支名，收尾检查据此放行。
人用 `harness escalate answer --id <编号> --choice <选项>` 答复，续跑前用 `harness escalate resume --id <编号>` 读取决定。

## 度量

`harness metrics` 输出按周统计：合并次数、验证首过率、复用检查数、评审拒绝率、策略拦截、门禁确认和黄金任务通过率。
`harness conformance` 逐项判定 L3 判据，样本不足的项标 `PEND`，不计为完成。
