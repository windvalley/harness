# 变更记录

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号遵循语义化版本。

## [Unreleased]

### 新增

- 通用客户端入口 `harness hook --client generic`：没有内置适配的编码 Agent 只需把工具调用转成统一载荷（`kind` 取 `shell`、`write`、`read`、`search`）就能接上实时拦截，拒绝时退出码 2；载荷不合约定同样按失败处理。
  参考手册新增“接入其他编码 Agent”，说明 git 层、`command` 评审者与通用入口三层各自怎么接，以及限制：只支持拦截，不支持收尾检查，harness 无法验证 Agent 真的因拒绝而不执行。
  手册附 Kimi Code 的接入示例（桥接脚本与 `[[hooks]]` 配置），在 Kimi Code 2.0.2 上实测了 `Bash`、`Write`、`Read` 的拦截；`Edit` 与 `Grep` 的字段映射没有实测。
- 教程页的图不再只列三个客户端：组件关系图写“Claude Code、Codex、DSH 等”，三层防线图第一层写“客户端钩子 / DSH 插件”，表格注明其他 Agent 经通用入口接入。
- 本机评审者文件 `~/.config/harness/reviewers.json`，用 `harness reviewer` 管理。
  每个评审者指定客户端（`claude`、`codex` 或任意命令）、模型和推理强度，`claude` 还可以指定第三方端点和 key。
  评审用什么模型是各机器自己的事，换模型不再需要提交，也不触发门禁确认。
- 可以列多个评审者：前一个鉴权失败、限流、超时或输出不合结构就换下一个，给出结论（通过或拒绝）就停，被拒后不会换人重评。
  启动前就能判断不可用的（命令不在 PATH 里、写了端点却没有 key）直接跳过，不花钱。
  全部不可用时逐条列出原因和补救命令。
- 默认优先使用与当前任务会话模型不同的评审者，减少评审和实现共用同一套盲点。
  会话模型取自 Claude Code 的会话记录，按具体模型比较，同模型的评审者排到最后但保留作备选；识别不出时按文件里的顺序。
  评审者的 `model` 写 `sonnet`、`opus` 这类别名时，先按 `ANTHROPIC_DEFAULT_*_MODEL` 解析成具体模型再比较，解析不出时按家族匹配。
  `harness reviewer prefer off` 关闭。
- 推理强度 `effort` 统一取 `low`、`medium`、`high`、`xhigh`、`max`，`claude` 传 `--effort`，`codex` 传 `-c model_reasoning_effort`，`command` 经环境变量 `HARNESS_REVIEW_EFFORT`。
- `harness reviewer test <名称>` 用极小的材料实际跑一次评审者，确认端点、key、模型和结构化输出都能用。
- 评审记录和账本写明由谁完成：评审者名称、客户端、请求的模型和客户端回报的实际模型、推理强度、端点主机、耗时、各次尝试的结果、会话模型与顺序调整。
  `harness review` 的输出、`harness status`、合并输出和 PR/MR 描述都会显示，由备选完成时点出前面的评审者为什么没有完成。
  `status` 和 PR/MR 描述里的摘要含名称、客户端、模型和推理强度；端点域名只在 `status` 等本机输出里显示，PR/MR 描述里只写“自定义端点”或“端点来自环境变量”，内部网关的域名不会发往平台。
- `harness doctor` 逐项列出本机评审者是否可用；`harness init` 结束时说明怎样配置本机评审者。
  没有本机文件时，`harness reviewer list` 与 `init` 读项目里的旧字段说明实际会用谁，不拿默认值去猜。

### 变更

- 教程页的图补上远程交付：三层防线图里第三层标为“交付 merge / submit”，生命周期图在 merge 下方加一条 submit、平台合并、sync 的路径，合并令牌图注明远程交付时由 sync 生成令牌；此前图里只有本地合并，容易让人以为 PR/MR 模式不受门禁约束。
- README、教程页与参考手册里概括门禁的句子不再只列“验证证据和独立评审”两项：交付前还要满足门禁改动的人工确认、大任务的实施授权等条件，缺任何一项都合不进本地主分支，也提交不了 PR/MR；句子用“等”收尾，因为门禁还会拒绝不符合提交格式的提交、缺验收清单等情况，这里不逐一列全。
- README 与教程页开头的定位语改为“让 Agent 高度自动地完成从需求到交付的全过程，质量由门禁把关，你只在关键节点做决定和验收”：去掉多余的“在 git 项目里”（git 是前提条件，不是卖点），突出高度自动化与人少操心。
- 评审预算默认不限：不配 `maxBudgetUsd` 就不传 `--max-budget-usd`。
  此前默认 2 美元，触顶时钱已经花了却拿不到结论；实测里一次大 diff 评审就用掉了上限的七成。
  项目配置里已经写了 `maxBudgetUsd` 的照旧生效。
- `harness init` 生成的项目配置里，`review` 段只留判据 `blockSeverities` 与 `maxDiffChars`，不再写 `backend`、`model`、`maxBudgetUsd`、`codexModel`、`command`。
- 指定了端点的评审者启动前清掉继承来的 `ANTHROPIC_*` 环境变量和 `CLAUDE_CODE_USE_BEDROCK` 这类云提供商开关，key 只通过子进程环境变量交给 `apiKeyHelper`，不出现在命令行参数和 settings 文件里。
  实测里不清的话，配错的 key 照样成功，分不清这次用的是哪一把；会话跑在云提供商上时，不清开关请求不会走指定的端点。
- 评审进程的报错擦掉本机文件里所有评审者的 key 和继承来的令牌，`harness reviewer test` 同样处理；本机文件有 JSON 语法错误时报错不显示原文片段，因为那里可能正是 key 的开头。
- 本机评审者文件里的 `claude` 评审者设置 `CLAUDE_CODE_MAX_RETRIES=2`：此前 key 失效要等四分多钟才报错，回退会被拖住。

### 修复

- 评审进程鉴权失败时，报错不再带 `(success)` 这个误导性的标签。

### 升级说明

- 没有本机评审者文件时，评审按项目配置里的旧字段运行，只有一个评审者，行为不变，不需要做任何事。
- 创建本机文件后，项目里的 `review.backend`、`model`、`maxBudgetUsd`、`codexModel`、`command` 不再起作用，`harness doctor` 会提示可以删掉；
  这些字段在 `.harness/config.json` 里，删除是门禁改动，在任务分支上改，合并前由人确认。
- 已接入的项目，配置里写死的 `"maxBudgetUsd": 2` 不会自动去掉，仍然生效；要改成不限，在任务分支上删掉这个字段。
- 本机评审者文件允许 Agent 通过 `harness reviewer` 修改，key 明文存放在里面。
  评审的强弱因此在本机可调，harness 只负责如实记录，由人在记录、`harness status` 和 PR/MR 描述里核对；详见参考手册“信任模型与已知限制”。
- `upgrade` 会刷新 `.harness/rules/harness.md` 与 `AGENTS.md` 托管块，其中新增了“不要直接读取或改写 reviewers.json、评审失败时不要换更弱的评审者、不要把评审用的端点域名写进提交说明和 PR/MR 描述”的规则，以及“`init` 结束后把评审者提示转述给用户并询问是否现在配置”的规则。

## [0.9.4] - 2026-10-29

这一版新增收尾检查，补上门禁管不到的一环：Agent 做到一半、没有遇到阻塞就自己结束了回复。
Agent 每次结束回复前，harness 核对本会话推进过的任务是否已经交付，没有交付又没有上报阻塞时列出还差的步骤，让它接着做。
同时修正评审失败时的报错：`claude` 的认证来源警告不再盖住真正的原因，超出评审预算时直接说明；验收清单经人确认过时，需求只部分满足也会被评审拒绝。
收尾检查在 Claude Code CLI 上做了端到端实测；Codex 与 DeepSeek Harness 按各自的钩子协议实现，尚未在运行中的客户端里端到端实测。

### 新增

- 收尾检查：Agent 每次结束回复前，核对本会话推进过的任务分支是否已经交付；没有交付又没有上报阻塞时拦下结束，列出每个分支还差什么和下一条命令。
  Claude Code 与 Codex 挂在 `Stop` 钩子上（`harness hook --client <客户端> --event stop`），DeepSeek Harness 插件挂在 `agent/turn-stopping` 上，用 `steer` 让这一轮继续。
  会话经手了哪些分支由实时拦截顺带记录：写文件落在哪个任务 Worktree、在哪个任务分支上提交、运行了哪个分支的 `approve`、`verify`、`review`、`merge`、`submit`；只读命令、预览与引号里提到的命令不算。
  只差人工确认、等用户同意实施，或已对分支开了上报时放行；两次结束之间没有任何进展时也放行，避免困住会话，并在账本记 `stop.unresolved`，`harness status` 与 `harness merge` 会显示出来。
- `harness doctor` 分别报告 Claude Code 与 Codex 的收尾检查钩子是否接入，以及 Codex 的 `Stop` 钩子是否已信任。

### 修复

- 评审进程失败时不再只给出 stderr 末尾：`claude` 在 stderr 打印的认证来源警告曾盖住 stdout 里真正的错误，让 Agent 把评审失败误判成凭据问题。
  现在优先解析 stdout 里的结果，花费超出 `review.maxBudgetUsd` 时说明已花多少并建议拆小分支或调高预算；其他失败同时列出 stdout 与 stderr。
- `harness status` 的验收清单一项改用真实路径 `.harness/acceptance/<分支>.md`，并说明清单有没有；`intent.mode` 为 `required` 时缺清单算作阻塞。
  此前显示的路径少了 `.harness/`，也不说清单在不在，看起来像清单没有接入门禁。

### 变更

- README 与图文教程开头关于“什么时候停下来找你”的说法改准：交付阶段通常只有门禁改动需要你确认、同一个问题连续三轮修不好两种情况。
  0.9.3 把“同意方案、拍板业务、登录平台”也列在没过门禁之后，读起来像实施完还要再批方案、再拍板；前两件发生在实施前或实施中，“登录平台”只在远程交付时本机的 `gh`、`glab` 没装或登录失效才会遇到。
  参考手册的“门禁拒绝时”逐项写明这些少见拒绝的触发条件。
- 验收清单经人确认过（在主分支上，或是记录了实施授权的方案清单）时，评审把需求符合度 `partial` 判为拒绝：清单就是约定的交付范围，要缩小范围先向用户说明并重新取得同意。
  任务分支从主分支继承、没有改过的清单按主分支来源处理；任务分支自带、未经确认的清单评 `partial` 仍不阻断。
- `core.md`、`harness.md` 与 `AGENTS.md` 托管块写明：已授权的任务连续推进到交付，轮次长短、耗时与上下文大小都不是停下的理由；需要停下时先上报，`context.branch` 填任务分支。

### 升级说明

- `upgrade` 会刷新 `.harness/rules/core.md`、`harness.md` 与 `AGENTS.md` 托管块。
- `upgrade` 会在 `.claude/settings.json` 与 `.codex/hooks.json` 里加上 `Stop` 钩子，属于门禁改动，合入前由人确认；其他工具的 `Stop` 钩子保留。
  合入后重启 Claude Code 会话；Codex 要在 `/hooks` 里另外信任一次 `Stop` 钩子。
- DeepSeek Harness 的本机插件由 `install` 或 `install --local` 更新，更新后重启 DeepSeek Harness；项目锁定的版本低于 0.9.4 时插件跳过收尾检查，拦截不受影响。

## [0.9.3] - 2026-10-29

这一版把交付讲成两种方式：默认由 Agent 合入本地主分支，也可以改为由 Agent 提交 PR/MR、在 GitHub 或 GitLab 上合并。
三份文档与随项目分发的规则、托管块、命令提示都按这两种方式改写了，并写明没过门禁时 Agent 修复后重试，只有需要人确认、同意、拍板、登录平台或同一个问题连续三轮修不好时才停下。

### 变更

- README、图文教程与参考手册把交付讲成两种方式：默认由 Agent 合入本地主分支，或者改为由 Agent 提交 PR/MR、在 GitHub 或 GitLab 上合并。
  三份文档都写明两种方式只能选一种、默认是本地交付、接入时怎样直接选 PR/MR，以及已接入项目怎样切换和改回。
  开头与“一个需求怎么交付”同时说明：没过门禁时 Agent 按拒绝原因修复后重新验证和评审，只在需要人确认、同意、拍板、登录平台或同一个问题连续三轮修不好时停下。
- `.harness/rules/harness.md` 的接入与一次任务按交付方式分别说明，新增“交付方式”与“门禁拒绝时”两节，写明哪些拒绝由 Agent 修复重试、哪些必须停下等人。
- `AGENTS.md` 托管块写明两条交付路只能选一种，未配置 `delivery` 时为本地交付。
- 主分支保护拒绝直接写入时，提示按项目的交付方式给出正确做法：远程交付提示 `harness submit` 与 `harness sync`，本地交付仍提示 `harness merge`。
- `init` 的输出先写明当前交付方式；默认本地交付时说明怎样在提交接入改动前改为 PR/MR，下一步里的交付命令随交付方式写成 `merge` 或 `submit`。
- 新项目默认的上报条件“同一方案连续失败两次”改为“同一个问题连续三轮没有解决”，与 `core.md` 的停下条件一致。

### 升级说明

- `upgrade` 会刷新 `.harness/rules/harness.md` 与 `AGENTS.md` 托管块。
- 已有项目的 `escalate.triggers` 写在各自的 `config.json` 里，`upgrade` 不改；需要统一时在任务分支改成“同一个问题连续三轮没有解决”，经人确认后合入。

## [0.9.2] - 2026-10-29

这一版新增远程交付：主分支放在 GitHub 或 GitLab 上的团队，可以用 `harness submit` 把核对过的任务提交推送到远程并创建或更新 PR/MR，由平台合并，合入后用 `harness sync` 把本地主分支快进过去。
远程交付默认关闭，没有配置 `delivery` 的项目行为不变，仍由 `harness merge` 合入本地主分支。
GitHub 已在真实仓库上实测，GitLab 只在模拟命令下验证过。
0.8.2 没有单独发布，它的内容（`secrets` 预设放行开发环境文件、证据复用与评审过期的修复、托管块的授权说明）一并包含在这一版里。

### 新增

- 远程交付模式：`.harness/config.json` 新增 `delivery` 段（`mode`、`remote`、`provider`），主分支在平台上时由 `harness submit` 推送核对过的任务提交并创建或更新 PR/MR，由团队在平台上合并。
  `harness merge` 在远程模式以 `delivery_remote` 拒绝；`harness sync` 把本地主分支快进到远程主分支，核对门禁改动、刷新本机安装并执行 `merge.postMergeCommand`。
  交付设置的变化一律要人工确认，确认摘要单独列出改前改后与由此授予的远程权限。
- `harness install --version <版本>` 只把指定版本装进本机版本目录，不改项目文件。
  `sync` 遇到目标提交锁定的版本本机没装时，在更新主分支之前以 `version_missing` 拒绝并给出这条命令。
- `harness status` 在远程模式显示提交记录与 PR/MR 链接，分支前进后提示记录已过期；`harness doctor` 检查远程与平台命令；`init` 生成带 `"delivery": { "mode": "local" }` 的配置。

### 变更

- `AGENTS.md` 托管块的任务分级条目写明：方案交付后用户表达开始实施的意思才算授权，最初提出需求或回答澄清问题都不算。
  0.8.1 删掉的协作说明里含有这条，它仍写在 `core.md` 与 `harness.md`，但托管块是 Agent 每次必读的部分，补回这半句，避免把提需求的原话当作授权记录。
- `core.md` 的“协作分工”去掉描述用户可以怎样提需求的半句，保留 Agent 主动补齐验收标准、确认业务歧义的要求。
- `secrets` 预设不再限制开发环境的环境文件：`.env`、`.env.local`、`.env.dev-infra`、`.env.test-infra` 的读取与写入放行，命令里出现这些文件名也不再拦。
  预设现在只保护私钥、凭据与门禁证据密钥：`**/*.pem`、`**/*.key`、`**/id_rsa*`、`**/credentials*.json` 与 `~/.local/share/harness/evidence.key`。
  这样 Agent 可以按需求更新本机环境配置，不必每次由人代改；代价是这些文件的内容会进入 Agent 上下文，只适合确实不值得保护的开发环境凭据。
- `harness worktree clean` 的本机文件清单改为固定清单与项目读取保护规则的并集：`.env` 与私钥、凭据始终算本机文件，读取规则放宽不会让清理 Worktree 时连带删掉未提交的配置。

### 修复

- 远程交付的平台调用改为显式绑定获授权远程的仓库标识（`--repo`），不再依赖本地 remote 或 `GH_REPO` 的推断；识别不出时以 `platform_repo_unknown` 拒绝。
  只认本仓库自己开的 PR/MR，别人从 fork 提交的同名分支 PR 不会被写入门禁结论。
- `glab` 查询显式要求 JSON 输出，并按 `opened` 识别已有 MR，避免正常登录也在推送前失败。
- 重试判断“是否已推送”改为直接查询远程真实顶端；此前读本地跟踪引用，远程分支被改写后会把没推上去的提交当成已推送。
- `sync` 的配置与基线取自同一个本地主分支提交；读配置后主分支被推进时以 `main_moved` 拒绝，不再用旧配置判断新基线。`submit` 同样处理。
- `sync` 的目标版本检查不再用进程版本号当“已安装”；`.harness/VERSION` 与入口 shim 不一致时以 `version_mismatch` 拒绝，该文件同时纳入门禁文件与入口刷新范围。
- 首次接入时 `sync` 的远程可由 `--remote` 指定并与接入提交里的配置核对，不再写死 `origin/main`。
- 报错与诊断里的远程地址会去掉用户信息与令牌类查询参数。
- 首次接入的确认摘要补上“由此授予”一行，写明 `harness submit` 获得的推送与创建 PR/MR 的权限；此前只有交付方式变化时才写。
- PR/MR 描述里的“门禁文件改动”按门禁路径列出，与确认摘要同一份清单；此前列的是 `.harness/` 下的全部改动，混进了模板，漏掉了 `.claude/settings.json` 与 `.codex/hooks.json`。
- `harness submit` 的日志前缀改为 `[submit]`，不再沿用 `[merge]`。
- `harness submit` 因门禁改动未确认被拒时说“需要人在提交前确认一次”，并给出重跑的 `harness submit --branch <分支>`；远程交付下 `harness status` 的门禁一项同样说“提交前”。此前沿用了合并的说法。
- `harness status` 在首次接入的分支上同样显示提交记录与 PR/MR 链接；已提交且分支顶端没变时，最后一行说明等平台合并、合入后运行 `harness sync`，不再提示“可以提交”。
- 主分支改了检查配置后，已有证据的分支仍按旧结果合并：改了命令的检查不重跑，新增的检查也不补跑。
  证据现在记录检查配置的指纹，配置变化时合并按当前配置重新验证；每项检查也记录定义指纹，定义或实际命令变了就不再沿用旧结果。
- 主分支在评审之后改了本分支也改过的文件时，旧评审仍然放行，合并结果里这些文件的内容没有经过评审。
  这种情况下合并以 `review_stale` 拒绝，`status` 同样报出；在任务分支上合并主分支后重新验证与评审。
  原来已计算这个条件，但没有用在放行判断里。

### 升级说明

- `upgrade` 会刷新 `.harness/rules/core.md`、`.harness/rules/harness.md` 与 `AGENTS.md` 托管块。
- `upgrade` 不改 `config.json`：没有 `delivery` 段时按本地交付处理，行为与之前一致；要用远程交付，在任务分支加上这一段，经人确认后合入。
- `.harness/VERSION` 现在是门禁文件，改它（包括 `upgrade` 改版本号）合并前要人确认；`upgrade` 本来就会改入口，确认次数不变。
- 0.9.0 与 0.9.1 只在本机试装过，没有发布标签；锁定这两个版本的项目直接升级到 0.9.2，其他机器按 0.9.2 安装。
- 升级前生成的证据没有检查配置指纹，合并时会按当前配置重新验证一次，没变的检查结果按定义指纹判断，同样需要重跑一次；评审不受影响。
- 升级到该版本后 `secrets` 预设按新口径执行，项目不需要改 `.harness/policy.json`；仍要保留严格保护的，在 `rules` 里写同 id 规则覆盖。
- 项目里的 `.harness/golden/tasks.json` 若还是起始内容，`g01` 到 `g03` 对 `.env` 的期望会失败。
  把这几步换成私钥路径（例如 `config/server.pem`）后再运行 `harness golden`，否则改动 `.harness/**` 的任务会被 `harness-golden` 检查拦住。

## [0.8.1] - 2026-10-28

### 变更

- `AGENTS.md` 托管块去掉 0.7.3 与 0.8.0 加入的两条协作说明：日常语言描述需求、不要求固定话术，以及 Agent 连续完成实现到合并、不要求用户逐条运行命令。
  托管块只放每次任务都要遵守的硬性要求；这两条描述的是产品使用方式，对 Agent 没有可执行的约束，还会在每个项目里重复 `core.md` 的“协作分工”与“任务分级”，也容易被读成对项目自己合并、推送授权的放宽。
  这些职责仍写在 `.harness/rules/core.md` 与 `harness.md`，行为不变，任务开始前本来就要读它们。

### 升级说明

- `upgrade` 会重写 `AGENTS.md` 托管块，上述两条随之消失；块外内容不动。

## [0.8.0] - 2026-10-28

DeepSeek Harness 插件原来生成在每个项目里，注册时绑定某个项目的路径，导入的也是那个项目锁定的版本。
接入多个项目时一个 profile 只能留下一份，那个项目被移走后 DSH 会静默跳过插件，所有项目的实时拦截一起失效。
这一版把插件改为本机共用一份，每个 profile 注册一次，按会话所在项目锁定的版本执行门禁。
同时包含需求协作说明的调整。

### 变更

- 需求表达改为普通语言示例，分别展示企业隔离与成员权限的大需求，以及列表空状态的小需求。
  大需求先讨论和整理方案，交付后等待实施授权；小需求核实范围后可以直接实施。
- 需求理解、验收标准整理、方案衔接和交付汇报明确为 Agent 职责，不要求用户记固定提示词、宣布澄清结束或逐次提醒交付要求。
- 基础规范、澄清方法、门禁授权说明与 `AGENTS.md` 托管块区分初始需求、澄清答复和对已交付方案的实施授权。
- 接入示例和初始化提示简化为目标表达，相关流程与交付要求放回 Agent 职责说明。
- DeepSeek Harness 插件生成在 `~/.local/share/harness/dsh-plugin/`，与版本目录同级，本机所有项目共用。
  项目里不再生成 `.harness/dsh-plugin/`，`install` 也不再往 `.gitignore` 里加这一行。
- 插件按会话所在仓库的入口锁定的版本导入那个版本的门禁代码，与 Claude Code、Codex 经入口执行的版本一致；项目升级 harness 版本后不用重新注册，也不用重启 DSH。
- 项目锁定的版本没有安装时，DSH 里的工具调用一律被拒绝并提示 `install --local`，与 Claude Code、Codex 一致。
- 没有入口的仓库用本机最新的版本判定：未接入 harness 的放行，主分支已有配置的照常拦截。
- 插件由 `install` 与 `install --local` 维护，输出里给出插件位置；已由更新的版本生成时保持不变，旧版本的 install 不会把它换回旧代码。
- `harness doctor` 读取 DSH 的 `desktop` 与 `web` profile，报告是否注册了本机插件；注册的是旧版生成在项目里的插件或别的目录时报 `[!!]`，并给出改注册的命令。
- 首次接入，或合并改了入口而 DSH 还没注册本机插件时，接入与合并结束时列出注册命令。
- 桌面版的注册命令改用 App 自带的命令行：独立安装的 `dsh` 会拒绝管理 `desktop` profile。

### 修复

- 注册插件的项目被移走或删除后，DSH 静默跳过插件，所有项目的实时拦截悄悄失效。
- 多个项目生成同名插件，后注册的顶掉先注册的，所有项目实际都按被注册的那个项目锁定的版本判定。
- `dsh` 不在 PATH 里时首次接入不显示注册提示，桌面版用户看不到这一步。

### 升级说明

- `upgrade` 会刷新基础规范、澄清方法、门禁流程与 `AGENTS.md` 托管块。
  需求协作部分只调整说明和 Agent 协作规则，保留小任务直接实施与现有门禁判定机制。
- 项目升级到 0.8.0 并合入后，合并会自动生成本机插件；也可以由人在任意项目运行 `node <harness 仓库>/bin/harness.mjs install --local` 生成。
  然后每台机器为用到的 profile 重新注册一次，命令见参考手册“客户端那一侧”；同名的旧注册会被替换。
  桌面版先完全退出再运行注册命令，注册后重启。
- 项目里旧的 `.harness/dsh-plugin/` 不再使用，可以删除，`harness uninstall` 也会删除它；`.gitignore` 里的那一行可以保留。

## [0.7.3] - 2026-10-28

### 变更

- README、图文教程和参考手册以自然语言协作为默认入口，覆盖接入、首个任务、清理、升级、新机器和排障。
  接入工作环境由 Agent 按项目规则准备，不要求用户先手工创建 Worktree。
- 基础规范、门禁流程与 `AGENTS.md` 托管块明确 Agent 的执行职责，以及人工确认、客户端操作和交付证据要求。
- `init` 的下一步提示区分 Agent 执行与用户亲自操作，并提醒核对真实检查命令、起始占位和未验证项。

### 修复

- 首次接入的教程和手册不再引导合并后立即删除任务 Worktree，统一为保留工作区、用户发起并确认后清理。
- 使用说明区分配置就位与当前客户端实际调用已验证，新机器工具调用被拦截时保留人工安装的兜底路径。

### 升级说明

- `upgrade` 会刷新 `.harness/rules/core.md`、`.harness/rules/harness.md` 与 `AGENTS.md` 托管块。
- `upgrade` 不改 `config.json`：没有 `delivery` 段时按本地交付处理，行为与之前一致；要用远程交付，在任务分支加上这一段，经人确认后合入。
- `.harness/VERSION` 现在是门禁文件，改它（包括 `upgrade` 改版本号）合并前要人确认；`upgrade` 本来就会改入口，确认次数不变。
- 0.9.0 与 0.9.1 只在本机试装过，没有发布标签；锁定这两个版本的项目直接升级到 0.9.2，其他机器按 0.9.2 安装。
  现有配置与门禁判定机制保持原有行为。

## [0.7.2] - 2026-10-27

### 新增

- `.harness/config.json` 的 `review` 段新增 `maxDiffChars`，调整单次评审能接受的 diff 字符数，默认 300000。
  配置从主分支读取，任务分支自己调高不生效，属于门禁改动，合并前由人确认。
- 独立评审的材料增加合并基线之后的提交说明（不含合并提交）和每个文件的增删行数，评审能对照改动意图，也会把提交说明与 diff 不符的地方报成发现。
  提交说明标明是实现方自述，不能作为满足验收的证据。

### 变更

- 评审的 diff 上限从写死的 180000 字符改为可配置，默认调高到 300000；超限的报错写明可以调的配置项，并提醒同步调高 `review.maxBudgetUsd`。
- `harness doctor` 检查 `review.maxDiffChars` 是否为正整数。
- 找不到评审后端时，报错改为指向参考手册里“独立评审的后端”一节。

### 修复

- DeepSeek Harness 会话位于非 Git 目录时不再误拒所有工具，未接入的 Git 仓库继续放行，工作目录无法确定或已接入项目配置异常时仍按失败关闭处理。

### 升级说明

- `upgrade` 不改 `config.json`：不加 `maxDiffChars` 时按默认值 300000 生效；需要更大的上限时在 `review` 段里加上，合并前由人确认。
- `upgrade` 会重写 `.harness/rules/harness.md`，补上评审核对提交说明的说明。

## [0.7.1] - 2026-10-27

### 修复

- `harness worktree clean --yes` 处理上百个 Worktree 时一行输出都没有，每个又要好几秒，看起来像卡死；现在逐个输出进度与用时，预览开始时也说明正在检查多少个。
- 中途按 Ctrl-C 会把正在运行的清理命令或 `git worktree remove` 一起打断，可能留下停了一半的服务或删了一半的目录；现在子进程在独立的进程组里运行，第一次 Ctrl-C 处理完当前 Worktree 再停，退出码 130，第二次立即退出。
- `AGENTS.md` 托管块里一行写了两句话，改为一句。

## [0.7.0] - 2026-10-27

规则只在 `AGENTS.md` 里指路、且明确“不新增审批节点”，Agent 常常不读 `core.md`，读了也不会停下等授权，大任务直接动手。
这一版把任务分级、先方案后实施与先红后绿写成默认规则，并让其中可以机械判定的部分由门禁执行。

### 新增

- 任务分级：小优化、小迭代，不改库表与接口契约，代码改动少于 500 行的直接实施；其余先探索、逐个澄清、写方案，交出方案后停下等授权。
  阈值与判定范围在 `.harness/config.json` 的 `intent.plan` 里配置。
- 预设 `plan-first`，`init` 默认启用：任务分支写了实施方案、还没有实施授权记录时，Agent 只能写方案与验收清单；写了方案、改了库表相关文件或代码改动超过阈值的分支，合并前必须有授权记录。
- 用户在对话里表达开始实施的意思就是授权，Agent 运行 `harness approve --branch <分支> --yes --note "<用户原话>"` 记录后连续实施到完成，用户不需要执行命令。
  `--note` 必填并照录原话，合并输出、`status` 与摘要都会显示；授权绑定验收清单的内容，清单再改要重新取得同意。
- 独立评审把有授权记录的验收清单标注为用户同意过的需求。
- 验收清单模板 `templates/acceptance.md`；行为说明与实施方案模板按“问题、验收、失败时、这次不做、待确认”与“验收到测试的对应、实现顺序、环境、复用”重写。
- 起始黄金任务 `g17-plan-first`，只在启用这个预设时重放。
- `harness worktree clean` 预览可以清理的 Linked Worktree：检出的提交已在主分支上、不是建好不到 24 小时的新任务、没有未提交文件、没有进程停在里面、没有锁定；分离头指针的 Worktree 同样适用。
  `--yes` 删除 Worktree 与分支，Worktree 不加 `--force`，分支用 `-d`；含 `.env` 这类本机文件的默认跳过，`--with-local-files` 才删。
- `.harness/config.json` 新增 `worktree.cleanup`：删除前在 Worktree 里依次运行的命令，例如停服务、删隔离数据库，失败就保留那个 Worktree。
- 合并后保留任务 Worktree，合并输出与 `doctor` 报告已合并但还没清理的 Worktree 数量；规则与 `AGENTS.md` 托管块写明不自行删除，清理由用户发起。

### 变更

- `core.md` 改为默认先红后绿，直接实施的任务同样适用，并要求交付前按验收清单逐条给出证据；需求澄清改为一次一个问题、给出推荐答案、“待定”原样记录。
- 去掉方案“不新增审批节点”的说法。
- `git-safety` 的 `git-discard-changes` 拦截 `git worktree remove --force`，它和 `git reset --hard` 一样会丢掉未提交的改动；起始黄金任务 `g05` 补上对应用例。
- `AGENTS.md` 托管块写明任务分级、先红后绿等硬性要求，不再只指向 `core.md`；`upgrade` 会刷新托管块。
- 同一个版本号已经装了不同的代码时，`publish`、`install` 直接报错，不再替换版本目录并重写清单；被就地改动的版本目录按原内容恢复。

### 修复

- DSH 守卫插件补齐 `workingDirectory` 服务依赖，避免桌面版在 profile 目录加载门禁时把所有工具误拒为“不是 Git 仓库”。

### 升级说明

- 需要在清理 Worktree 前停服务、删数据库的项目，在 `config.json` 里加 `worktree.cleanup`，不加时只删 Worktree 与分支。
- 已接入项目的 `golden/tasks.json` 不会自动更新，`g05` 新增的两步需要时从 `assets/golden/starter.json` 复制。
- `upgrade` 不改 `config.json` 与 `policy.json`：要启用实施授权，在 `policy.json` 的 `presets` 里加 `plan-first`，需要时在 `config.json` 的 `intent` 里加 `plan`（不加按默认值）；起始黄金任务 `g17-plan-first` 从 `assets/golden/starter.json` 复制。
- 本机 `~/.local/share/harness/versions/0.6.0` 若装过 0.6.0 发布后的代码，内容会与标签 `v0.6.0` 不一致；升级到 0.7.0 后可以用 `harness prune` 清理。

## [0.6.0] - 2026-10-26

钩子目录可以由 harness 接管，不再挂在某个子项目的工具上；所有 Worktree，包括停在旧分支的，都执行主分支上确认过的同一份钩子。

### 新增

- `.harness/config.json` 新增 `git.hooksDir` 与 `git.projectHooks`。`hooksDir` 里的钩子整份由 harness 生成，目录里已有其他工具的钩子时拒绝覆盖；`projectHooks` 放项目自己的检查，harness 检查通过后调用，在当前 Worktree 的检出里执行。
- 项目钩子改了暂存区或提交信息时，按最终内容再做一次 harness 检查；项目钩子存在但不可执行时拒绝提交。
- `install`、`install --local`、`upgrade` 让 `core.hooksPath` 指向主 Worktree 里的钩子目录；主 Worktree 里还没有生成的钩子时不切换，合入后由 `harness merge` 完成切换。
- `doctor` 检查 `core.hooksPath` 是否指向主 Worktree 的钩子目录，以及项目钩子是否可执行。
- 合并改变了钩子目录时，提醒其他机器各自运行一次 `install --local`。
- `harness merge` 在更新主分支前检查 `core.hooksPath`，被旧分支里的工具（例如 husky 的 `prepare`）改走时改回来。
- `uninstall` 在接管模式下删除生成的钩子并撤销 `core.hooksPath`。

### 修复

- `commit-msg` 按 git 的清理规则判定提交信息：用编辑器写提交信息时，钩子拿到的文件还带着注释行与剪刀线以下的 diff，原先会被带 `$` 的规则误拒。
- `core.hooksPath` 是指向主 Worktree 的绝对路径时，在 Linked Worktree 里运行 `install` 会改写主 Worktree 的入库文件；现在定位到当前 Worktree 自己的检出。
- 合并改动了 `.harness/config.json` 时同样在主 Worktree 刷新本机钩子。
- `gate-self` 的命令行入口保护只认带斜杠的路径，对整个目录的 `git rm -r`、`mv`、`cp -r` 拦不住；现在目录本身同样受保护，同名前缀的其他目录（例如 `.githooks-backup`）不受影响。

## [0.5.0] - 2026-10-23

多个会话并行时，主 Worktree 一旦切走分支或留下改动，所有任务的合并都会被挡住，而且要到合并时才发现。
新增可选预设把主 Worktree 限定为合并站，并让 `status`、`doctor` 提前报告它是否就绪。

### 新增

- 可选预设 `main-worktree`，`init` 不启用：Agent 不能改主 Worktree 里未被忽略的文件、不能在主 Worktree 里切离主分支；`pre-commit` 拒绝主 Worktree 里的提交，对所有客户端和人都生效，可以在 `disabled` 里单独关掉。
- 路径规则支持 `when` 条件与 `allowIgnored`；新增规则种类 `commit-forbid`，由 `pre-commit` 判定。
- `status` 与 `doctor` 检查主 Worktree 是否停在主分支、洁净、没有进行中的 git 操作。
- `check --kind commit` 与 `--ignored`。
- 起始黄金任务 `g16-main-worktree-merge-only`；黄金任务可以用 `presets` 声明只在某个预设启用时重放，未启用时记为跳过。
- 多 Worktree 的项目在 `init --dry-run` 里提示可以启用 `main-worktree`。

### 变更

- 实时拦截按调用实际落在哪个 Worktree 判定：会话停在主 Worktree 时，改 Linked Worktree 里的文件按那个 Worktree 的上下文与相对路径判定。落在本仓库所有 Worktree 之外的调用不受带 `when` 的规则约束。
- 命令按段判定所在目录：跟着前面的 `cd`、`pushd` 推算，`git -C` 叠加，括号子 shell、`bash -c` 与命令替换里的 `cd` 不外溢。目录无法静态确定的段按最严格处理，带条件的规则都适用。
- 黄金任务的步骤没写位置时一律按 Linked Worktree、不在主分支判定，结果不再取决于在哪个 Worktree 里运行 `harness golden`。

### 修复

- DSH 插件的注册提示写明 profile 只能是 `desktop` 或 `web`，用自定义名称注册的插件两端都不会加载。

## [0.4.0] - 2026-10-23

接入已有项目不再需要人工清单：一条命令调查现状，首次接入走和日常任务相同的流程，人只在合并前确认一次。

### 新增

- `init --dry-run` 只调查不写入：列出钩子目录与原有脚本、原有的主分支保护与 Agent 拦截、`AGENTS.md` 里其他工具的托管块、会被忽略的入口、被占用的数据目录、可退役的目录，以及将写入的文件和转换建议。
- `init --take-over` 接管原有的主分支保护与 Agent 拦截；`pre-commit`、`commit-msg` 里原有的脚本始终保留。只做通用处理，不识别、不转换原有工具的配置格式。
- 首次接入走 `verify`、`review`、`confirm`、`merge`：主分支还没有门禁配置时，按接入分支提议的配置执行，强制人工确认，确认后快进合入成为主分支的信任根。被原有主分支保护拒绝时，主 Worktree 恢复原样并提示加 `--take-over`。
- 合并改动了入口或钩子时，用新入口在主 Worktree 刷新本机钩子，并列出客户端那一侧需要人做的事（重启 Claude Code 会话、在 Codex 里信任钩子、注册 DSH 插件）。
- `install --local` 只刷新本机：按项目锁定的版本安装代码（不是当前版本时从 harness 仓库的对应标签导出），刷新共用钩子与插件目录，不改动入库文件。用于新成员或新机器。
- `gate-self` 新增 `confirm-human-only`：带 `--yes` 的确认只能由人执行。
- `check` 支持 `--on-main`、`--linked-worktree`。

### 变更

- 入口找不到锁定的版本时，Claude Code 与 Codex 的实时拦截一律拒绝，并提示安装命令。原先退出码 3 被 Claude Code 当成非阻塞错误，等于放行。git 提交检查仍是提示后放行，主分支保护仍拒绝。
- 起始检查里的通用 `lint` 改为 `extended` 占位，配置真实命令前记入未执行项，不再以 `true` 冒充通过。
- `.git/harness` 已被其他工具占用时，数据改放 `.git/harness.d`；目录里写归属标记，0.3 及以前留下、能被本机密钥校验的数据继续沿用。
- 规则文档只描述实际启用的规则；入口与钩子由 `harness install`、`init`、`upgrade` 生成，Agent 可以在任务分支运行它们，合并前由人确认。
- `publish` 不再接受与当前代码不同的版本号。
- `doctor`、`golden`、`conformance` 在首次接入阶段按工作区配置运行。

### 修复

- `git-safety` 把主分支上的 `git merge-base`、`git merge-tree` 误判成合并。
- `core.hooksPath` 为绝对路径时钩子目录拼接错误。
- `.codex/hooks.json` 里其他工具的钩子在重装时被整份覆盖。
- 本机生成的 `.harness/dsh-plugin/` 在首次接入时让主 Worktree 被判成不洁净。

## [0.3.0] - 2026-10-23

在多 Worktree 项目（opsagent）上演练迁移时发现的问题，涉及钩子接入方式，已接入的项目需要重新运行 `harness install` 并提交入口。

### 变更

- 入口 `.harness/bin/harness` 改为入库。原先它被忽略，新建的 Linked Worktree 里没有入口：Claude 钩子报错但不阻断，等于实时拦截静默失效。
- Claude 与 Codex 的钩子命令直接调用入口（`hook --client`），不再生成带本机绝对路径的 `claude-hook.mjs`、`codex-hook.mjs`。
- git 钩子块插到原有脚本之前，并带结束标记。原先追加在末尾，遇到 husky 这类“没有前端改动就 exit 0”的 `pre-commit` 时永远执行不到；`reference-transaction` 里原有脚本读完标准输入后，追加的块也拿不到输入。
- git 钩子调用主 Worktree 的入口，只在主分支已有 `.harness/config.json` 时生效；没有接入 harness 的仓库共用同一份钩子时不受影响。
- 入口在本机找不到锁定的版本时退出码固定为 3：`pre-commit` 与 `commit-msg` 提示后放行，主分支引用保护仍然拒绝。钩子随仓库分发后，没装 harness 的机器也能正常提交。
- `install` 自动维护 `.gitignore`：加入 `.harness/dsh-plugin/`，去掉旧版要求的 `.harness/bin/`；项目用全局 `bin/` 规则时自动放行 `.harness/bin/`，并在仍被忽略时直接报错。

### 新增

- `harness golden --worktree` 按工作区配置重放；起始验证配置新增 `harness-golden` 检查，改坏规则的分支在验证阶段就被拦下。
- `harness verify --plan` 只列出会执行的检查、未执行项与提示，不执行也不写证据，替代原项目里的 `verify.plan` 目标。
- `doctor` 检查入口是否入库。
- 评审遇到整目录退役这类大量删除时，删除的文件只列路径与行数，不再因为旧内容撑爆 diff 上限而拒绝评审；评审记录里注明哪些删除只看了路径。

### 修复

- `gate-self` 补上 `HARNESS_MAIN_BYPASS`、`HARNESS_STORE`、`HARNESS_VERSION`：后两个能把入口指向别处的代码，等于整体绕过门禁。
- `gate-self` 的执行器入口保护补上 `.husky/**` 与子目录里的 `.husky/`。
- 门禁文件范围加入执行器入口：入口版本号、客户端钩子配置与钩子目录的改动在合并前同样需要人工确认。

## [0.2.0] - 2026-10-22

### 新增

- 独立评审后端可配置：`auto` 按 `claude`、`codex` 顺序取本机可用的，`command` 用任意命令接入其他工具；`codex` 与 `command` 在临时空目录里运行，并提供严格模式的 JSON Schema 与结果文件占位符。
- 起始检查按项目技术栈生成：`go.mod` 出 go test 与 build，`frontend/package.json` 出前端类型检查，`Cargo.toml`（含 `rust/Cargo.toml`）出 cargo test，声明了 pytest 的 Python 项目出 pytest。
- `harness key status` 与 `harness key rotate`：查看密钥指纹、权限与本仓库记录的可校验情况；轮换时旧密钥移入 `retired/`，已有记录全部作废。
- 记录写入密钥指纹，失效原因区分密钥已轮换、密钥丢失、内容被改动，并给出该重跑的命令。
- `doctor` 检查密钥是否存在、格式是否正确、是否仅本人可读。
- `gate-self` 新增 `key-rotate-human-only`：Agent 只能预览轮换，不能执行。

### 修复

- 密钥文件为空或被截断时不再静默用它签名，直接报错并给出恢复方式。
- 轮换下来的旧密钥同样受读取保护。
- 在没有提交的 `main` 仓库上 `init` 不再把主分支写成 `master`；配置里的主分支名与仓库实际不符时给出明确提示，而不是后续每一步都报 rev-parse 失败。
- 找不到评审后端时说明该改哪里，不再抛 `spawn claude ENOENT`。
- 确认摘要改为比较生效规则，只改 `disabled` 关掉预设规则时也会点名；规则内容被覆盖时单独列出。
- cargo 检查不再要求 `target` 目录先存在，否则全新克隆上这项必过检查永远被跳过。
- 起始黄金任务补密钥轮换与旧密钥读取的用例，改规则后能发现这两类退化。
- 检查命令不存在时单独提示“未找到命令”，不再混在检查失败的输出里；证据里记下 `spawnError`。

## [0.1.0] - 2026-10-22

首个可用版本。门禁全部在本机判定，不依赖云端 CI。

### 新增

- 策略拦截：预设 `secrets`、`git-safety`、`gate-self`，项目可关闭或覆盖单条规则；每条规则必须带 `reason` 与 `fix`。
- 客户端适配：Claude Code、Codex、DeepSeek Harness 归一到 shell/write/read/search 四类调用。
- git 层：`pre-commit`、`commit-msg`、`reference-transaction` 三个钩子，任何客户端都会经过。
- 验证：按改动路径选择检查；检查分 `gate`、`extended`、`advisory` 三档；在固定检出目录执行以复用增量缓存。
- 证据复用：证据按分支提交索引，主分支前进时只重跑触发范围与新增改动有交集的检查。
- 受控合并：`merge` 是更新主分支的唯一入口，核对证据与评审；门禁配置改动需人工确认一次。
- 独立评审：无实现上下文的进程评审需求符合度与工程质量；验收清单可随分支提交并标注来源。
- 例外上报、黄金任务、按周度量、L3 判据自检（`conformance`）。
- 接入生命周期：`init`、`install`、`upgrade`、`uninstall`、`doctor`、`status`。
- 内置 14 个起始黄金任务，接入即有规则回归保护。

### 已知限制

- Codex 的实时拦截需要先在客户端里信任钩子（`/hooks`），未信任时命令不会经过门禁，只有 git 层生效。
- DeepSeek Harness 插件需要用户在 DSH 里注册，尚未在运行中的宿主里实测。
- Claude 桌面版仅做静态确认（应用内包含钩子实现），未做端到端实测。
- 证据签名密钥存放在用户目录，能防误操作与提示注入，无法防住拥有本机权限的人。
