# harness

本地闭环的研发门禁。所有判定在本机完成，结果写入账本，不依赖云端 CI。

适用于任何 git 项目与任何编码工具：git 钩子对所有客户端生效；Claude Code、Codex、DeepSeek Harness 另有实时拦截适配。

仓库托管在 <https://github.com/windvalley/harness>。

## 安装

需要 Node.js 20 及以上和 git，没有其他依赖。

```bash
git clone https://github.com/windvalley/harness.git ~/github/harness
```

harness 不需要全局安装。下面的命令都用 `node ~/github/harness/bin/harness.mjs` 执行；项目接入后，日常命令改用项目里的入口 `.harness/bin/harness`。
克隆到别的目录也可以，把命令里的路径换掉即可。

## 接入一个项目

接入在任务分支里完成，走一次和日常任务相同的流程，合并前由人确认一次。

```bash
cd <项目>
git switch -c chore/harness-onboard

# 1. 预览：调查现状，列出会写入的文件、会冲突的原有工具和处理建议，不写任何文件
node ~/github/harness/bin/harness.mjs init --dry-run

# 2. 写入。项目里已有其他门禁时加 --take-over，由 harness 接管主分支保护与 Agent 拦截
node ~/github/harness/bin/harness.mjs init

# 3. 除 .harness/dsh-plugin/ 外全部提交，包括入口 .harness/bin/harness
git add -A && git commit

# 4. 验证、独立评审、人工确认、合并
.harness/bin/harness verify  --branch chore/harness-onboard
.harness/bin/harness review  --branch chore/harness-onboard
.harness/bin/harness confirm --branch chore/harness-onboard          # 看摘要
.harness/bin/harness confirm --branch chore/harness-onboard --yes    # 由人执行
.harness/bin/harness merge   --branch chore/harness-onboard
```

第 1 到第 4 步都可以交给 Agent 做，只有带 `--yes` 的确认必须由人执行，Agent 运行它会被拦截。
在 Claude Code 里，可以在输入框用 `!` 前缀直接执行这一条。

合并时，主分支上还没有门禁配置，harness 按接入分支提议的配置完成验证，确认后以快进方式合入，这份配置从此成为主分支的信任根。
合并结束会列出客户端那一侧需要人做的事，例如重启正在运行的 Claude Code 会话、在 Codex 里信任钩子。

没有其他门禁、也不需要评审的小项目，可以直接在主分支上运行 `init` 并提交，提交后即生效。

### 已有其他门禁的项目

`init --dry-run` 会列出原有工具留下的东西，并按下面的方式处理：

| 发现 | 默认 | 加 `--take-over` |
| --- | --- | --- |
| git 钩子里原有的脚本（lint、提交信息校验等） | 保留，harness 的检查插在最前面 | 同左 |
| `reference-transaction` 里原有的主分支保护 | 保留；合并时若被它拒绝，提示加 `--take-over` 重来 | 移除，由 harness 接管 |
| `.claude/settings.json`、`.codex/hooks.json` 里原有的 Agent 拦截 | 保留，两套拦截同时生效 | 移除，由 harness 接管 |
| `.gitignore` 会连带忽略入口（例如全局的 `bin/`） | 自动放行入口 | 同左 |
| `.git/harness` 已被其他工具占用 | harness 的数据改放 `.git/harness.d`，原有数据不动 | 同左 |
| 被钩子或 `AGENTS.md` 托管块引用的目录 | 列为可退役，不自动删除 | 同左 |

harness 不认识原有工具的配置格式，也不自动转换。
原有工具里仍需要的规则，改写进 `.harness/policy.json`（禁令）、`.harness/verify.json`（检查映射）和 `.harness/golden/tasks.json`（回归用例）。
这些文件 Agent 可以直接改，建议与接入放在同一个分支，人工确认时一起过目；否则接管之后、补上规则之前，那些规则不再生效。
原有工具的代码与配置在接入合入后另开任务删除。

钩子目录入库的项目（例如 husky），钩子改动随分支走，合入主分支后才生效；用默认 `.git/hooks` 的项目，钩子写入后立即对所有 Worktree 生效，只是在主分支有门禁配置之前不做任何检查。

### init 写了什么

1. `.harness/`：`config.json`、`policy.json`、`verify.json`、`golden/tasks.json`、`rules/`、`templates/`、`acceptance/`。起始检查按技术栈生成（`go.mod`、`frontend/package.json`、`Cargo.toml`、pytest 配置），通用的 `lint` 是占位，在配置真实命令前记入未执行项，不会冒充通过。
2. 当前版本的代码装进 `~/.local/share/harness/versions/<版本>/`，并写入内容哈希清单。
3. 入口 `.harness/bin/harness`，锁定版本号。入口入库，每个 Linked Worktree 检出即可用。
4. `pre-commit`、`commit-msg`、`reference-transaction` 三个 git 钩子。harness 的块插在最前面，调用主 Worktree 的入口，只在主分支上已有 `.harness/config.json` 时生效。配置了 `git.hooksDir` 时改为整份生成在那个目录，见“由 harness 接管 git 钩子目录”。
5. `.claude/settings.json` 与 `.codex/hooks.json` 的拦截配置，其他设置原样保留。
6. `AGENTS.md` 里的托管块，`.gitignore` 里的 `.harness/dsh-plugin/`，以及本机的 DSH 插件目录。

DeepSeek Harness 需要在你自己的终端注册一次插件：

```bash
dsh plugin --profile <desktop|web> add <项目路径>/.harness/dsh-plugin
```

`--profile` 的值必须与你实际使用的 DeepSeek Harness 一致：桌面版用 `desktop`，浏览器版用 `web`。
插件只装进指定的 profile，用别的名称会新建一个独立 profile，桌面版和浏览器版都不会加载它。

## 新成员或新机器

项目接入后，入口和钩子随仓库分发，但门禁代码装在各自的用户目录里。克隆项目后运行一次：

```bash
cd <项目>
node ~/github/harness/bin/harness.mjs install --local
```

它读取项目锁定的版本，从 harness 仓库对应的标签（例如 `v0.4.0`）安装这一版代码，刷新本机共用的钩子与插件目录，不改动任何入库文件。
找不到标签时先在 harness 仓库运行 `git fetch --tags`。

装好之前：

- Claude Code 与 Codex 的实时拦截拒绝一切操作，并提示上面这条命令。没有门禁的 Agent 不应该能动这个项目，因此这里不放行。
- git 提交照常进行，只打印提示；主分支保护照常拒绝。

## 升级

```bash
git -C ~/github/harness pull --tags
cd <项目> && git switch -c chore/harness-upgrade
node ~/github/harness/bin/harness.mjs upgrade
git add -A && git commit
```

然后按日常任务流程 verify、review、confirm、merge。
`upgrade` 安装新版本、改写入口锁定的版本、重写 `rules/` 与 `templates/`，保留 `config.json`、`policy.json`、`verify.json`。
入口版本属于门禁改动，合并前需要人确认；合并后 harness 用新入口自动刷新主 Worktree 的本机钩子，并列出客户端需要做的事。
其他成员拉到新的主分支后，各自运行一次 `install --local`。

## 客户端支持

git 层（`pre-commit`、`commit-msg`、`reference-transaction`）对所有客户端生效，因此即使实时拦截没接上，提交与主分支保护仍然有效。

| 客户端 | 实时拦截 | 状态 |
| --- | --- | --- |
| Claude Code（CLI） | `PreToolUse`，拒绝时退出码 2 | 已实测 |
| Claude 桌面版 | 同一套钩子实现 | 仅静态确认，未端到端实测 |
| Codex CLI | `.codex/hooks.json` 的 `PreToolUse` | 已实测；需先信任钩子 |
| Codex 桌面版（ChatGPT.app 内置引擎） | 同上 | 已实测；需先信任钩子 |
| DeepSeek Harness | Cordis 插件 `tools/pre-execute` | 插件已生成，需自行注册，未在运行中的宿主实测 |

**Codex 需要先信任钩子。** 未信任时命令不会经过门禁，只有 git 层生效。在 Codex 里运行 `/hooks`，进入 `Review hooks` 后按 `t` 信任。信任记录写进 `config.toml` 的 `[hooks.state."<项目>/.codex/hooks.json:pre_tool_use:0:0"]`，绑定钩子内容哈希：重新安装或改动了钩子命令，需要再批准一次。

## 一次任务

```bash
.harness/bin/harness verify --branch <任务分支>   # 选检查、在固定检出里执行、写签名证据
.harness/bin/harness review --branch <任务分支>   # 独立评审，需求符合度与工程质量两个维度
.harness/bin/harness merge  --branch <任务分支>   # 核对证据与评审，更新主分支
```

主分支前进后再合并，没有被新改动波及的检查会直接复用，不必整轮重跑。改动涉及门禁配置时，合并前需要 `harness confirm --branch <分支> --yes` 由人确认一次。

## 配置

| 文件 | 内容 |
| --- | --- |
| `.harness/config.json` | 主分支、合并与评审参数、验收清单模式、门禁确认、上报触发条件 |
| `.harness/policy.json` | 启用的预设与项目自有规则；`disabled` 按规则 id 关闭预设规则 |
| `.harness/verify.json` | 路径到检查的映射，`tier` 取 `gate`、`extended`、`advisory` |
| `.harness/golden/tasks.json` | 对规则本身的回归用例 |

预设在 `assets/presets/`：

| 预设 | 内容 |
| --- | --- |
| `secrets` | 禁止读取、写入或用命令外发密钥与凭据文件 |
| `git-safety` | 拦截丢弃改动、强推、stash、`--no-verify`，以及绕过合并工具更新主分支 |
| `gate-self` | 保护执行器入口与绕过开关；规则与配置本身允许修改，合并前由人确认 |
| `main-worktree` | 可选，`init` 不启用：主 Worktree 只用来合并，改动、切分支与提交都放在 Linked Worktree |

`secrets`、`git-safety`、`gate-self` 由 `init` 写进 `presets`。

### 多个会话并行时：main-worktree

`harness merge` 在主 Worktree 里更新主分支，要求它停在主分支且洁净。
只要有一个 Agent 在主 Worktree 里切走分支或留下改动，所有任务的合并都会被挡住。
多个 Agent 或会话并行的项目，建议在 `.harness/policy.json` 的 `presets` 里加上 `main-worktree`：

- `main-worktree-edit`：Agent 不能改主 Worktree 里的文件，被 `.gitignore` 忽略的本机文件除外。
- `main-worktree-leave-main`：Agent 不能在主 Worktree 里 `git switch`、`git checkout` 到主分支以外。
- `main-worktree-commit`：git 的 `pre-commit` 拒绝主 Worktree 里的提交，对所有客户端和人都生效，Codex 没有信任钩子时也能兜底。

判定按调用实际落在哪个 Worktree：会话停在主 Worktree 时，改 Linked Worktree 里的文件（包括建在主 Worktree 目录下的，例如 `.claude/worktrees/`）按那个 Worktree 算。
命令按段判定，每段在哪个目录执行跟着前面的 `cd`、`pushd` 推算，`git -C <目录>` 再叠加上去；括号子 shell、`bash -c` 和命令替换里的 `cd` 不影响后面的段。
目录无法静态确定的段（`cd "$变量"`、`cd -`、`popd`、管道里的 `cd`、`GIT_DIR` 与 `--git-dir`）按最严格处理，带条件的规则都适用。
`harness merge` 用 `commit-tree` 和快进更新主分支，不经过 `pre-commit`，不受影响。
需要由人在主 Worktree 手工提交的项目，在 `disabled` 里关掉 `main-worktree-commit`，其余两条照常。
用命令写文件（例如 `echo > 文件`、构建产物）不在拦截范围内，靠 `harness status` 与 `harness doctor` 提前提示主 Worktree 不洁净来兜底。
起始黄金任务里的 `g16-main-worktree-merge-only` 只在启用这个预设时重放，未启用时记为跳过。

### 由 harness 接管 git 钩子目录：git.hooksDir

默认情况下 harness 把检查块插进现有钩子的最前面：`core.hooksPath` 指向哪里就写哪里，没设置时写 `.git/hooks`。
钩子目录是某个子项目的工具装上的（例如 `frontend/package.json` 里的 husky）时，整个仓库的门禁就挂在那个子项目上：没装它的依赖就没有钩子，重装依赖又会把 `core.hooksPath` 改回去。
入库的相对路径还有一个问题：每个 Worktree 执行的是自己分支上的那份钩子，停在旧分支的 Worktree 不经过新门禁。

在 `.harness/config.json` 里加上 `git` 段，由 harness 接管钩子目录：

```json
{ "git": { "hooksDir": ".githooks", "projectHooks": "scripts/git-hooks" } }
```

- `hooksDir`：harness 生成的钩子目录，入库，整份由 `harness install`、`init`、`upgrade` 生成，不手改。目录里已有其他工具的钩子时拒绝覆盖，提示把它们移到 `projectHooks`。
- `core.hooksPath` 指向主 Worktree 里这个目录的绝对路径，写在公共配置里。所有 Worktree，包括停在旧分支、检出里还没有这个目录的，都执行主分支上确认过的同一份钩子。
- `projectHooks`：项目自己的检查（lint、格式化等），与钩子同名的可执行脚本。harness 检查通过后调用，在当前 Worktree 的检出里执行，跟着分支走，Agent 可以维护。
  项目钩子改了暂存区或提交信息时，按最终内容再做一次 harness 检查。脚本存在但没有执行权限时拒绝提交，不会像 git 那样静默跳过。
- 推荐用 `.githooks`：它在 `gate-self` 的执行器入口保护范围内，Agent 不能直接改写。换成其他目录时，改动仍算门禁文件、合并前需要人确认，但没有实时写保护。

切换在任务分支里完成：改配置后运行 `harness install`（或 `upgrade`）生成钩子并提交。
主 Worktree 里还没有生成的钩子时不切换 `core.hooksPath`，否则指向不存在的目录，git 会静默跳过钩子，主分支保护也随之失效。
合入后 `harness merge` 在主 Worktree 运行 `install --local` 完成切换，并提醒其他机器拉到新的主分支后各自运行一次 `install --local`：`core.hooksPath` 在各自的 `.git/config` 里，不随仓库分发。
`harness doctor` 检查 `core.hooksPath` 是否指向主 Worktree 的钩子目录，以及项目钩子是否可执行。主 Worktree 换了位置时重新运行 `install --local` 即可。
原来的钩子目录与安装它的工具配置（例如 husky 的 `prepare` 脚本）在同一个分支里删掉，否则下次安装依赖又会改回 `core.hooksPath`。
还没合入这次改动的旧分支里仍有那些配置，在它们的 Worktree 里安装依赖同样会改走 `core.hooksPath`；`harness merge` 在更新主分支前会改回来，平时用 `harness doctor` 检查。

检查的三个档位：

- `gate`：必过，失败就不能合并。
- `extended`：不自动执行，写进证据的未执行清单并附补验方式。
- `advisory`：只提示，不计入未执行，适合需要人看一眼的视觉类检查。

## 独立评审的后端

评审是一个不了解实现过程的独立进程，只读验收清单、变更 diff 与验证证据。`review.backend` 决定用哪个工具：

| 取值 | 行为 |
| --- | --- |
| `auto`（默认） | 按 `claude`、`codex` 的顺序用本机第一个可用的；都没有时直接报错并提示改用 `command` |
| `claude` | 固定用 Claude Code CLI |
| `codex` | 固定用 `codex exec`，模型由 `review.codexModel` 指定 |
| `command` | 用 `review.command` 给出的命令，接入任何其他工具 |

`command` 后端的约定：提示从 stdin 读入，结果写在 stdout，或者用 `{output}` 占位符指定一个文件路径。以下占位符会被替换成临时文件路径，可以直接传给命令：

- `{schema}`：评审结果要满足的 JSON Schema，严格模式，可直接用于支持结构化输出的工具。
- `{system}`：评审的系统提示词。
- `{output}`：期望命令把结果写到这里，存在时优先读它。

输出既可以是 `{"verdict": ..., "requirementFit": ..., "engineeringQuality": ..., "findings": [...]}`，也可以是带 `structured_output` 字段的包装对象；允许包在 Markdown 代码块里。示例：

```json
{ "command": ["my-reviewer", "--json-schema", "{schema}", "--out", "{output}"] }
```

`codex` 与 `command` 都在临时空目录里运行，读不到项目文件，也不会被项目里的钩子拦住；`claude` 使用只读工具白名单运行在仓库里。

## 信任模型

- 门禁的配置一律从主分支的 git 对象读取，代码从按版本安装的目录执行；任务分支里改过的门禁不能决定自己是否放行。
- 门禁改动的人工确认会按“生效规则”列出增删，包括关掉某条预设规则这种只改 `disabled` 的情况。
- 证据与评审绑定被验证的分支提交并做 HMAC 签名，密钥在 `~/.local/share/harness/evidence.key`。
- 主分支只能由 `harness merge` 更新：`reference-transaction` 钩子校验只有合并工具能生成的令牌。
- 门禁配置改动的人工确认绑定合并结果的 tree，内容再变确认即失效。
- 签名密钥在你的用户目录里，能防误操作和提示注入，防不了拥有本机权限的人。
- 每条记录带密钥指纹。记录失效时会区分“密钥已轮换”“密钥丢失”“内容被改动”，并给出该重跑的命令。
- 密钥损坏或怀疑泄露时，由人在自己的终端运行 `harness key rotate --yes`：旧密钥移入 `retired/`，已有记录全部作废，进行中的分支重新 verify 与 review 即可。Agent 只能运行不带 `--yes` 的预览。

## 命令

运行 `harness help` 查看全部命令。常用的体检命令：

- `harness status --branch <分支>`：只读汇总，指出还差哪几步才能合并。
- `harness doctor`：安装与接入自检，未实测的客户端标 `[?]`。
- `harness key status`：证据密钥的指纹与权限，以及本仓库有多少记录能被当前密钥校验。
- `harness conformance`：逐项判定 L3 判据，样本不足的项标 `PEND`。
- `harness metrics`：按周度量。
- `harness golden`：重放黄金任务。接入时自带 16 个用例，针对可选预设的用例在预设未启用时跳过；步骤没写位置时按 Linked Worktree、不在主分支判定；默认按主分支配置，`--worktree` 按工作区配置。起始验证配置里的 `harness-golden` 检查会在任务分支的检出里用 `--worktree` 重放，改坏规则的分支在验证阶段就被拦下。
- `harness rules`：列出解析后的规则。

## 卸载与版本

```bash
harness uninstall --dry-run   # 先看会删什么
harness uninstall             # 删除生成物，保留 .harness/ 下的配置与用例
harness uninstall --purge     # 连 .harness/ 一起删
harness versions              # 列出已安装的版本
harness prune --dry-run       # 清理旧版本，默认只保留当前版本
```

卸载不会删除全局的版本目录，其他接入的项目不受影响。

## 开发

```bash
npm test
```

自测在临时仓库里跑，使用隔离的数据、密钥与版本目录，不碰本机已有的 harness 安装。
