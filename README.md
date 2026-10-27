# harness

harness 是跑在本机的研发门禁，面向“Agent 写代码、人把关”的 git 项目。
它在 Agent 调用工具时拦下危险操作，在合并前要求验证证据与独立评审，并让主分支只接受它的合并命令写入。
所有判定都在本机完成，记录签名后存进仓库自己的 git 目录，不依赖云端 CI。

git 钩子对所有编码工具和人都生效；Claude Code、Codex、DeepSeek Harness 另有工具调用级的实时拦截。

仓库托管在 <https://github.com/windvalley/harness>，MIT 许可。

## 工作原理

### 三层防线

```text
Agent 调用工具 ----> [1] 实时拦截：读写文件、执行命令之前按规则判定
      |
  git commit ------> [2] git 钩子：pre-commit 查暂存内容，commit-msg 查提交信息
      |
  任务分支 --> verify --> review --> confirm --> merge --> 主分支
               签名证据   独立评审    人工确认     [3] 受控合并
                                    (仅门禁改动)  reference-transaction 拒绝其他写入
```

| 层 | 何时生效 | 管什么 | 覆盖谁 |
| --- | --- | --- | --- |
| 实时拦截 | Agent 每次调用工具之前 | 读取密钥、改写门禁入口、不可逆的 git 操作、绕过开关 | Claude Code、Codex、DeepSeek Harness |
| git 钩子 | 每次提交与引用更新 | 提交信息、暂存的密钥文件、主分支的写入 | 所有客户端和人 |
| 受控合并 | 合并到主分支时 | 验证证据、独立评审、门禁改动的人工确认 | 所有客户端和人 |

前两层负责当场纠正：拦截信息里带着原因和正确做法，Agent 照着改道即可。
第三层负责结果把关：即使某个客户端没有接上实时拦截，没有证据和评审的改动也进不了主分支。

### 合并前要满足什么

1. `verify`：在固定的独立检出里，按改动路径选出要跑的检查并执行，结果写成绑定分支提交的签名证据。
   它只验证已提交的内容，工作区里未提交的改动不在其中。
2. `review`：启动一个不了解实现过程的评审进程，只给它验收清单、diff 和证据摘要，从需求符合度与工程质量两个维度给出结论。
3. `confirm`：改动涉及门禁本身（配置、规则、入口、钩子）时，由人看过摘要后确认一次。
   Agent 执行带 `--yes` 的确认会被拦截。
   启用 `plan-first` 时，大改动还要有你同意实施的记录，见“任务分级与实施授权”。
4. `merge`：核对上面的记录仍然有效，再更新主分支。
   `reference-transaction` 钩子只放行带合并令牌的写入，令牌由证据密钥对“旧提交、新提交”签名得到，只有 `harness merge` 能生成。

证据和评审按分支提交索引，分支上再提交或改写提交后，需要重新 verify 和 review。
主分支前进后再合并时，只有触发范围被主分支新改动波及的检查会重跑，其余直接复用。

### 任务分支放宽不了自己的门禁

- 配置一律从主分支的 git 对象读取：任务分支里改过的规则与检查不影响它自己的判定，合入主分支后才生效。
- 代码不放在项目里：项目只入库一个入口 `.harness/bin/harness`，它锁定版本号并转发到 `~/.local/share/harness/versions/<版本>/`。
  版本目录带内容哈希清单，`harness doctor` 会校验它没有被就地改写。
- 改配置、规则、入口或钩子的分支，合并前必须由人确认；确认绑定合并结果的 tree，内容一变就要重新确认。
- 证据、评审与确认都用本机密钥做 HMAC 签名，记录被改动、密钥已轮换或丢失都能识别出来，并提示该重跑哪一步。

首次接入时主分支上还没有配置，没有信任根可用。
这时 harness 按接入分支提议的配置执行，不论改了什么都要求人工确认，确认后以快进方式合入，这份配置从此成为主分支的信任根。

### 文件放在哪

| 位置 | 内容 | 入库 |
| --- | --- | --- |
| `.harness/config.json`、`policy.json`、`verify.json` | 项目参数、拦截规则、检查映射 | 是 |
| `.harness/golden/tasks.json` | 对规则本身的回归用例（黄金任务） | 是 |
| `.harness/rules/`、`.harness/templates/` | 给 Agent 读的研发规范，以及验收清单、行为说明、实施方案模板，`upgrade` 会整份重写 | 是 |
| `.harness/acceptance/` | 验收清单 | 是 |
| `.harness/bin/harness`、`.harness/VERSION` | 入口与锁定的版本号 | 是 |
| `.claude/settings.json`、`.codex/hooks.json` | 客户端的实时拦截配置 | 是 |
| `AGENTS.md` 里的托管块 | Agent 每次都会加载的硬性要求：先读规范、任务分级、先红后绿、按门禁流程合并 | 是 |
| `.harness/dsh-plugin/` | DeepSeek Harness 插件，含本机绝对路径 | 否 |
| `.git/hooks/` 或 `core.hooksPath` 指向的目录 | `pre-commit`、`commit-msg`、`reference-transaction` 三个钩子 | 默认不入库 |
| `.git/harness/` | 证据、评审、确认、实施授权、上报记录与账本 `ledger.jsonl`，所有 Worktree 共用；被其他工具占用时改用 `.git/harness.d/` | 否 |
| `~/.local/share/harness/versions/<版本>/` | 按版本安装的门禁代码，本机所有项目共用 | 否 |
| `~/.local/share/harness/evidence.key` | 签名密钥，权限 600 | 否 |
| `~/.cache/harness/checkouts/<哈希>/work` | verify 的固定检出，以分离头指针的 Linked Worktree 出现在 `git worktree list` 里 | 否 |

## 安装

需要：

- macOS 或 Linux，Node.js 20 及以上，git 2.38 及以上（合并用到 `git merge-tree --write-tree`）。
- 一个独立评审的后端：本机已登录的 `claude`（Claude Code CLI）或 `codex`。
  两者都没有时可以接入任意命令，见“独立评审的后端”。

```bash
git clone https://github.com/windvalley/harness.git ~/github/harness
```

harness 没有 npm 依赖，也不需要全局安装。
接入项目之前用 `node ~/github/harness/bin/harness.mjs <命令>` 运行；接入之后用项目里的入口 `.harness/bin/harness <命令>`，它随仓库分发，每个 Linked Worktree 检出即可用。
克隆到别的目录也可以，把命令里的路径换掉即可。

下文写作 `harness <命令>` 的地方，都指项目里的入口 `.harness/bin/harness <命令>`。
示例里的主分支叫 `main`，叫 `master` 的项目相应替换。

## 接入一个项目

### 首次接入

接入本身也走一遍日常任务的流程：在任务分支里写入，验证、评审，由人确认后合并。
建议在 Linked Worktree 里做，让主 Worktree 一直停在主分支且洁净，`harness merge` 要在那里更新主分支。

```bash
cd <项目>        # 主 Worktree，停在 main 且洁净
git worktree add -b chore/harness-onboard ../<项目>-onboard main
cd ../<项目>-onboard

# 1. 预览：调查现状，列出将写入的文件、与原有工具的冲突和处理建议，不写任何文件
node ~/github/harness/bin/harness.mjs init --dry-run

# 2. 写入；项目里已有其他门禁时，按预览结果决定是否加 --take-over
node ~/github/harness/bin/harness.mjs init

# 3. 提交；.harness/dsh-plugin/ 已加进 .gitignore，其余全部入库，包括入口 .harness/bin/harness
git add -A
git commit -m "chore(harness): 接入门禁" -m "- 写入门禁配置、规则与入口
- 接入 git 钩子与客户端拦截"

# 4. 验证、评审、确认、合并
.harness/bin/harness verify  --branch chore/harness-onboard
.harness/bin/harness review  --branch chore/harness-onboard
.harness/bin/harness confirm --branch chore/harness-onboard          # 只读摘要
.harness/bin/harness confirm --branch chore/harness-onboard --yes    # 由人执行
.harness/bin/harness merge   --branch chore/harness-onboard

# 5. 收尾
cd ../<项目>
git worktree remove ../<项目>-onboard
git branch -d chore/harness-onboard
```

第 1 到第 4 步都可以交给 Agent，只有带 `--yes` 的确认必须由人执行。
在 Claude Code 里，可以在输入框用 `!` 前缀直接执行这一条。

提交信息要符合默认的提交规范：标题之后空一行，每行一条 `- ` 开头的要点。
接入期间钩子还没有生效，格式不对的提交要到合并时才被拒绝，见“提交信息”。

合并结束会列出客户端那一侧需要人做的事，见“客户端那一侧”。

也可以在主 Worktree 里直接切到接入分支，但合并前要先切回主分支，并改用 `node ~/github/harness/bin/harness.mjs merge`，因为主分支上还没有入口。

### init 写了什么

1. `.harness/` 下的 `config.json`、`policy.json`、`verify.json`、`golden/tasks.json`、`rules/`、`templates/`、`VERSION` 和空的 `acceptance/`。
   已存在的 `config.json`、`policy.json`、`verify.json` 保持不动，加 `--force` 才覆盖；已有的黄金任务始终保留。
2. 起始检查按技术栈生成：`go.mod` 对应 `go test` 与 `go build`，`frontend/package.json` 对应前端类型检查，`Cargo.toml` 或 `rust/Cargo.toml` 对应 `cargo test`，声明了 pytest 配置的项目对应 `pytest`。
   另外还有通用的 `lint` 占位、`harness-golden` 规则回归检查和两个示例检查，见“verify.json：检查映射”。
3. 把当前版本的代码装进 `~/.local/share/harness/versions/<版本>/` 并写入内容哈希清单；本机还没有签名密钥时生成一把。
4. 入口 `.harness/bin/harness`，锁定版本号。
5. `pre-commit`、`commit-msg`、`reference-transaction` 三个 git 钩子。
   harness 的块插在原有脚本之前，调用主 Worktree 的入口，只在主分支上已有 `.harness/config.json` 时生效。
   配置了 `git.hooksDir` 时改为整份生成在那个目录，见“由 harness 接管 git 钩子目录”。
6. `.claude/settings.json` 与 `.codex/hooks.json` 里的 `PreToolUse` 拦截，文件里的其他设置原样保留。
   `policy.json` 启用 `secrets`、`git-safety`、`gate-self` 与 `plan-first` 四个预设。
7. `AGENTS.md` 里的托管块，以及 `.gitignore` 里的 `.harness/dsh-plugin/`；项目全局忽略 `bin/` 时自动放行入口。
8. 本机的 DSH 插件目录 `.harness/dsh-plugin/`。

### 已有其他门禁的项目

`init --dry-run` 会列出原有工具留下的东西，处理方式如下：

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
原有工具的代码与配置，在接入合入后另开任务删除。

钩子目录入库的项目（例如 husky），钩子改动随分支走，合入主分支后才生效。
用默认 `.git/hooks` 的项目，钩子写入后立即对所有 Worktree 生效，只是在主分支有门禁配置之前不做任何检查。
钩子目录由某个子项目的工具管理时，可以改由 harness 接管，见“由 harness 接管 git 钩子目录”。

### 小项目直接在主分支接入

没有其他门禁、也不需要评审的小项目，可以在主分支上直接运行 `init` 并提交。
这次提交时主分支上还没有配置，钩子不做检查；提交之后主分支立即受保护，再有改动就要走任务分支和 `harness merge`。

### 客户端那一侧

有几件事 harness 没法代劳，接入或合并结束时会列出来：

- Claude Code：钩子在会话启动时读入，接入后或客户端配置改动后，重启正在运行的会话。
- Codex：钩子要先被信任才会执行，未信任时命令不经过实时拦截，只有 git 层生效。
  在 Codex 里运行 `/hooks`，进入 `Review hooks` 后按 `t` 信任。
  信任按路径记录并绑定钩子内容的哈希：每个 Worktree 首次使用时各信任一次，钩子命令变化后要重新信任。
- DeepSeek Harness：在自己的终端注册一次插件。

```bash
dsh plugin --profile <desktop|web> add <主 Worktree 路径>/.harness/dsh-plugin
```

`--profile` 必须与实际使用的 DeepSeek Harness 一致：桌面版用 `desktop`，浏览器版用 `web`。
用别的名称会新建一个独立的 profile，桌面版和浏览器版都不会加载它。

| 客户端 | 实时拦截 | 状态 |
| --- | --- | --- |
| Claude Code（CLI） | `PreToolUse`，拒绝时退出码 2 | 已实测 |
| Claude 桌面版 | 同一套钩子实现 | 仅静态确认，未端到端实测 |
| Codex CLI | `.codex/hooks.json` 的 `PreToolUse` | 已实测；需先信任钩子 |
| Codex 桌面版（ChatGPT.app 内置引擎） | 同上 | 已实测；需先信任钩子 |
| DeepSeek Harness | Cordis 插件 `tools/pre-execute` | 需自行注册插件，尚未完成端到端实测 |

git 层对所有客户端生效，实时拦截没接上时，提交检查与主分支保护仍然有效。
`harness doctor` 逐项报告接入状态，`[!!]` 表示需要处理，`[?]` 表示文件已就位但客户端是否真正调用尚未实测。

## 日常使用

### 任务分级与实施授权

Agent 开始任务前先判断分级，规则写在 `.harness/rules/core.md`，要点同时写进了 `AGENTS.md` 的托管块：

- 直接实施：小优化、小迭代或缺陷修复，不改库表与迁移，不改接口契约、权限与数据兼容性，代码改动少于 `intent.plan.maxLines`（默认 500 行，测试、文档与锁文件不计）。
- 先方案后实施：其余任务，以及拿不准的任务。

先方案后实施的节奏：

1. 探索：Agent 先读仓库，说明需求涉及的能力现在做到哪一步、相关定义在哪、有没有半成品，每条结论附 `文件:行号`。
2. 澄清：一次问一个问题，每个问题给出推荐答案；你说“待定”的问题会原样列进方案，不会被替你填上。
3. 方案：验收清单 `.harness/acceptance/<分支名>.md`、行为说明 `docs/changes/<change-id>/spec.md` 与实施方案 `docs/changes/<change-id>/plan.md`，提交到任务分支后停下。
4. 授权：你在对话里说“开始实施”“按方案做”之类的话就够了，不需要执行任何命令。
5. 实施：Agent 连续做到完成，先把每条验收写成测试并确认全部失败，再实现到全部通过，最后按验收清单逐条给出结果与证据；中途只在缺权限、需要业务拍板、范围明显超出方案或同一个问题连续三轮没解决时停下。

改变行为的实施默认先红后绿，直接实施的任务同样如此。
你在对话里给出不同的节奏时，Agent 按你说的做。

`plan-first` 预设给“停下等授权”加了兜底，不再只靠 Agent 自觉：

- 任务分支写了实施方案（默认 `docs/changes/*/plan.md`，包括还没提交的）、还没有授权记录时，Agent 只能写 `docs/changes/` 与 `.harness/acceptance/` 下的文件，写测试和代码会被拦截。
- 你表达开始实施的意思后，Agent 运行 `harness approve --branch <分支> --yes --note "<你的原话>"` 记下授权，再开始写测试和代码。
  `--note` 必须照录你的原话，不写不予记录。
- 合并时，写了实施方案、改了库表相关文件或代码改动超过阈值的分支，必须有授权记录，否则报 `plan_unapproved`；没写方案就直接做了大改动的分支在这里被拦下。
- 合并输出、`harness status` 与 `harness approve --branch <分支>` 的摘要都会显示记录下来的原话，你可以随时核对 Agent 是否真的得到了你的同意。
- 授权绑定验收清单的内容：之后要改清单，Agent 要先向你说明并重新取得同意；实施方案里的进度记录可以随时更新。
- 有授权记录后，独立评审把这份清单当作你同意过的需求来核对。

### 配合使用的提示词

规则已经写进项目，提示词只需要说明这次的任务和节奏，不必每次重复流程：

```text
需求：<描述>
按 harness 规则先判断任务分级并说明依据。属于先方案后实施的，先探索仓库再逐个问我，方案提交后停下等我说开始。
```

```text
问题问完了，写验收清单、spec 和 plan，提交到任务分支后给我看。
```

```text
可以，开始实施。
```

最后一句就是授权，Agent 会记下原话，然后按 plan 先红后绿连续做到完成。

### 一次任务

```bash
cd <项目>
git worktree add -b feat/login ../<项目>-login main
cd ../<项目>-login
# 可选：写验收清单 .harness/acceptance/feat-login.md
# 实现并提交
harness verify --branch feat/login   # 选检查，在固定检出里执行，写签名证据
harness review --branch feat/login   # 独立评审
harness status --branch feat/login   # 只读：还差哪几步才能合并
harness merge  --branch feat/login   # 核对证据与评审，更新主分支
```

- `harness verify --plan --branch <分支>` 只列出会执行、记为未执行和仅提示的检查，不执行也不写证据。
- 分支上有新提交或改写过提交后，证据与评审随之失效，重新 verify、review。
- `merge` 发现没有证据，或者主分支的新改动波及了某些检查时，会自己重跑这些检查；评审不会自动重做，没有通过的评审直接拒绝合并。
- `merge --dry-run` 只做核对，不更新主分支。
- `merge` 在哪个 Worktree 里运行都可以，但主 Worktree 必须停在主分支、洁净、没有进行中的 merge、rebase 或 cherry-pick。
  只用一个目录工作时，合并前先切回主分支。
- 合并有冲突时，在任务分支上 `git merge main` 解决冲突并提交，再重新 verify、review。
- 合并成功后，Agent 按 `.harness/rules/harness.md` 的“收尾”删掉这个 Linked Worktree 和任务分支：不加 `--force`、不用 `-D`。
  Worktree 里有未提交的文件、本机服务或数据库还没清理、Worktree 不是这次任务创建的，Agent 会停下报告，不会强删。

### 验收清单

清单放在 `.harness/acceptance/<分支名>.md`，分支名里字母、数字、`.`、`_`、`-` 以外的字符换成 `-`，例如 `feat/login` 对应 `.harness/acceptance/feat-login.md`。
每条写成能用测试或命令验证的结果。
清单可以随任务分支提交，评审会标注它“尚未经人工确认”；也可以先合入主分支。

- 有清单时评审必须逐条核对，需求符合度评成 `unknown` 或 `unmet` 都会被拒绝。
- 没有清单时需求符合度记为 `unknown`，评审只评工程质量，合并时打印提示。
- `config.json` 的 `intent.mode` 设为 `required` 时，没有清单不能合并；设为 `off` 时不再提示。

### 评审结论

- 有 `high` 或 `critical` 级别的发现时拒绝，阻断级别可以用 `review.blockSeverities` 调整；没有阻断级发现时，评审进程即使写了 reject 也按通过处理。
- 评审前必须有通过的验证证据。
- diff 上限是 180000 字符：超出时整文件删除改为只列路径和行数，仍然超出就拒绝评审，并按顶层目录给出拆分建议。

### 提交信息

`init` 生成的提交规范分两处检查：

| 位置 | 何时检查 | 默认要求 |
| --- | --- | --- |
| `policy.json` 的 `commit-message` 规则 | `commit-msg` 钩子，每次提交 | 标题是 `类型: 说明` 或 `类型(范围): 说明`，类型为小写字母；不得出现 `Co-Authored-By:` 行 |
| `config.json` 的 `merge.commitMessagePattern` 与 `forbidMessagePatterns` | `harness merge`，检查分支上每个非合并提交 | 标题之后空一行，其余每行都是 `- ` 开头的要点，要点之间不能有空行 |

```bash
git commit -m "feat(login): 支持短信验证码登录" -m "- 新增验证码发送与校验接口
- 登录页增加验证码输入"
```

每个 `-m` 是一段，段与段之间有空行，因此多条要点要写在同一个 `-m` 里换行，或者用编辑器写。
只有标题的提交能通过 `commit-msg`，但合并时会报 `bad_commit_message`。
这时在任务分支上改写提交信息（`git commit --amend` 或变基），再重新 verify、review。
两处规则都可以按项目规范修改，保持一致即可；把 `merge.commitMessagePattern` 设为 `null` 可以取消合并时的格式检查。

### 被拦截时

拦截信息包含原因、对象、正确做法和规则 id，例如：

```text
[harness] 已拦截: stash 栈在所有 Worktree 间共享，静默 pop 会丢别人的未提交改动
对象: git stash
正确做法: 用临时 WIP 提交暂存: git add <具体文件> && git commit -m 'wip: 暂存'
规则: git-stash
```

Agent 按“正确做法”改道即可，实时拦截每次都会记进账本。
`harness rules` 列出当前生效的全部规则，`harness check --kind shell --command "<命令>"` 可以手工判定一条命令。
确实不需要某条预设规则时，把它的 id 写进 `policy.json` 的 `disabled`；这属于门禁改动，合并前由人确认。

### 门禁改动与人工确认

以下文件属于门禁，改动它们的分支合并前要由人确认：

- `.harness/config.json`、`policy.json`、`verify.json`、`golden/**`、`rules/**`、`bin/**`。
- `.claude/settings.json`、`.codex/hooks.json`、`.githooks/**`、`.husky/**`（包括子目录里的 `.husky/`）、配置的 `git.hooksDir`。
- `governance.gatePaths` 里追加的路径。

配置、规则与用例，Agent 可以直接改。
入口与钩子（`.harness/bin/`、客户端配置、钩子目录）Agent 不能手改，只能在任务分支运行 `harness install`、`init` 或 `upgrade` 重新生成。

`harness confirm --branch <分支>` 输出只读摘要：涉及哪些门禁文件、生效规则的增删与改动（包括只改 `disabled` 关掉某条预设规则）、检查项的增删。
人确认无误后运行带 `--yes` 的同一条命令，可以加 `--note <说明>`。
确认绑定合并结果的 tree：分支再提交，或者主分支前进让合并结果变了，都要重新确认。

### 与远端同步

harness 只管本地主分支，推送与拉取不经过它。

- 推送：Agent 推送主分支会被拦截，由人推送；Agent 可以推送任务分支，但不能强推。
- 拉取：本地主分支受保护，在主分支上 `git pull` 会被 `reference-transaction` 拒绝。
  快进拉取被拒时 git 已经把远端的文件检出到工作区，主 Worktree 会留下这些改动。
  拉取前主 Worktree 是洁净的，残留的就只是远端改动，由人运行 `git reset --hard HEAD` 恢复。

同步远端主分支有两种做法。
做法一是把远端主分支当作任务分支，走一遍本机门禁：

```bash
git fetch origin
harness verify --branch origin/main
harness review --branch origin/main
harness merge  --branch origin/main   # 远端改了门禁文件时，先由人 confirm
```

本地主分支有未推送的提交时，这样会生成一个三方合并提交。
远端的提交同样要符合本地的提交规范，diff 也受评审上限约束，一次同步大量提交时不适用。

做法二是由人决定直接信任远端，在自己的终端快进：

```bash
git fetch origin
HARNESS_MAIN_BYPASS=1 git merge --ff-only origin/main
```

它跳过证据、评审与确认，只能快进。
`HARNESS_MAIN_BYPASS` 是绕过开关，Agent 设置它会被拦截。
用这种方式拿到的改动里有入口或钩子变化时（例如远端升级了 harness），再运行一次 `node ~/github/harness/bin/harness.mjs install --local`。

### 例外上报

遇到需要人拍板的情况（需求有歧义、必要验证被既有问题阻塞、要推送或部署、同一方案连续失败），Agent 用上报把决定交给人：

```bash
harness escalate open --file esc.json      # 不带 --file 时从标准输入读
harness escalate list --status open
harness escalate answer --id esc-1a2b3c4d --choice b --note "先跳过"
harness escalate resume --id esc-1a2b3c4d  # 续跑前读取人的决定
```

`esc.json` 必须包含 `situation`、`attempted`、`blocker`、`defaultAction` 和至少两个 `options`（每个有 `id` 与 `summary`），可选 `trigger`、`resumeHint`、`context`。
`defaultAction` 必须是某个选项的 `id`。

## 新成员或新机器

项目接入后，入口与客户端配置随仓库分发，门禁代码与 git 钩子留在各自的机器上。
克隆项目后运行一次：

```bash
cd <项目>
node ~/github/harness/bin/harness.mjs install --local
harness doctor
```

`install --local` 读取项目锁定的版本：harness 仓库当前就是这个版本时直接安装，否则从对应的标签（例如 `v0.6.0`）导出那一版安装。
然后写入本机的 git 钩子和 DSH 插件目录，不改动任何入库文件。
找不到标签时先运行 `git -C ~/github/harness fetch --tags`。

装好之前：

- Claude Code 与 Codex 的实时拦截拒绝一切调用，并提示上面这条命令：没有门禁的 Agent 不应该能动这个项目。
- 默认的 `.git/hooks` 和 `core.hooksPath` 设置都不随克隆分发，本机没有 git 层保护。
  钩子目录入库、且 `core.hooksPath` 已经指向它时（例如安装依赖时由 husky 设置），提交照常进行、只打印提示，写主分支一律被拒绝。

Codex 的钩子信任按路径记录，新机器上同样要在 Codex 里信任一次。

## 升级

```bash
git -C ~/github/harness pull --tags
cd <项目>
git worktree add -b chore/harness-upgrade ../<项目>-upgrade main
cd ../<项目>-upgrade
node ~/github/harness/bin/harness.mjs upgrade
git add -A
git commit -m "chore(harness): 升级到 <版本>" -m "- 更新入口锁定的版本与规则文档"
```

然后按日常任务的流程 verify、review、confirm、merge。
`upgrade` 安装新版本、改写入口锁定的版本、重新生成钩子与客户端配置，并整份重写 `rules/` 与 `templates/`。
`AGENTS.md` 里的托管块也会刷新，块外的内容保持不动。
`config.json`、`policy.json`、`verify.json`、`golden/tasks.json` 保持不动，新版本带来的可选预设与配置要自己加，见 `CHANGELOG.md` 的升级说明。
项目自己的研发规范不要写在 `.harness/rules/` 里，下次升级会被覆盖，写在 `AGENTS.md` 托管块之外即可。
新版本新增的起始黄金任务不会自动加进项目，需要时对照 harness 仓库的 `assets/golden/starter.json` 补上。
合并后 harness 用新入口刷新主 Worktree 的本机钩子，并列出客户端需要做的事。

其他成员拿到这次升级：

```bash
git -C ~/github/harness pull --tags
git fetch origin
HARNESS_MAIN_BYPASS=1 git merge --ff-only origin/main   # 由人在自己的终端执行
node ~/github/harness/bin/harness.mjs install --local   # 按新锁定的版本安装并刷新钩子
```

想让这次同步也走本机门禁（“与远端同步”的做法一），要先装好新版本：verify 里的 `harness-golden` 检查会用远端分支的入口运行，本机没有它锁定的版本时这项检查失败。
`node ~/github/harness/bin/harness.mjs version` 与 `git show origin/main:.harness/VERSION` 一致时，运行 `node ~/github/harness/bin/harness.mjs publish` 装好新版本，再按做法一合入。

## 配置

### config.json

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mainBranch` | 按仓库检测 | 主分支名，只能是 `main` 或 `master` |
| `verify.timeoutSeconds` | `1800` | 单项检查的超时秒数 |
| `verify.failFast` | `true` | 一项检查失败后不再执行后面的检查 |
| `merge.requireEvidence` | `true` | 合并要求验证证据；设为 `false` 时连评审也不再要求 |
| `merge.requireReview` | `true` | 合并要求通过的独立评审 |
| `merge.commitMessagePattern` | 见“提交信息” | 合并时每个提交的完整格式，`null` 表示不检查 |
| `merge.forbidMessagePatterns` | `Co-Authored-By` 行 | 提交信息里不允许出现的内容 |
| `merge.subjectPrefix` | `"Merge: "` | 三方合并时生成的合并提交的标题前缀 |
| `merge.postMergeCommand` | `null` | 合并后在主 Worktree 执行的命令数组；失败时 `merge` 退出码为 3 |
| `review.*` | | 评审后端、模型与阻断级别，见“独立评审的后端” |
| `intent.mode` | `checklist` | 验收清单：`checklist` 有则核对，`required` 没有不能合并，`off` 不提示 |
| `intent.dir` | `acceptance` | 清单目录，位于 `.harness/` 下 |
| `intent.plan.maxLines` | `500` | 直接实施的代码改动上限，按新增加删除的行数算 |
| `intent.plan.markers` | `docs/changes/*/plan.md` | 实施方案文件；分支里出现它就按先方案后实施处理 |
| `intent.plan.triggers` | `**/migrations/**`、`**/*.sql` | 库表相关文件，改了就需要实施授权 |
| `intent.plan.exclude` | 测试、文档、锁文件与 `.harness/` | 不计入代码改动行数的文件；写了这一项会整个替换默认列表 |
| `governance.confirmOnGateChange` | `true` | 门禁改动是否要人工确认；首次接入不受这个开关影响 |
| `governance.gatePaths` | `[]` | 追加的门禁文件 glob |
| `escalate.triggers` | 四条 | 建议上报的情形，写给 Agent 看，harness 不据此自动触发 |
| `env` | `{}` | 执行检查时附加的环境变量 |
| `git.hooksDir`、`git.projectHooks` | 不设置 | 由 harness 接管 git 钩子目录，见下文 |

### verify.json：检查映射

```json
{
  "docOnly": { "match": ["docs/**", "**/*.md"], "exclude": [] },
  "checks": [
    { "id": "lint", "tier": "gate", "when": ["src/**", "**/*.ts"], "cmd": ["npm", "run", "lint"] },
    {
      "id": "web-typecheck",
      "tier": "gate",
      "when": ["web/src/**", "web/package.json"],
      "cwd": "web",
      "cmd": ["pnpm", "typecheck"],
      "requires": ["web/node_modules"]
    },
    { "id": "e2e", "tier": "extended", "when": ["web/src/**"], "reason": "需要真实浏览器", "howToVerify": "pnpm -C web e2e" },
    { "id": "visual", "tier": "advisory", "when": ["web/src/**/*.vue"], "hint": "界面改动建议人工过一眼" }
  ],
  "fullSuiteTriggers": { "paths": [] }
}
```

分支相对合并基线改动的路径（包括删除的）只要命中某项检查的 `when`，这项检查就被选中。
检查在固定检出里执行：verify 时检出分支提交，合并时需要重跑则检出合并结果。

| 字段 | 说明 |
| --- | --- |
| `id` | 检查名，证据、复用与黄金任务都按它引用 |
| `tier` | `gate` 必过，失败就不能合并；`extended` 不自动执行，记入证据的未执行清单并附补验方式；`advisory` 只提示，不计入未执行 |
| `when` | 触发路径的 glob，支持 `*`、`**` 与 `{a,b}` |
| `cmd` | 参数数组，直接执行而不经过 shell；需要管道等写法时用 `["sh", "-c", "..."]` |
| `cwd` | 相对仓库根的执行目录 |
| `requires` | 依赖目录（例如 `node_modules`），从主 Worktree 软链接进检出；主 Worktree 里也没有时记为未执行，证据状态为 `incomplete`，不能评审与合并 |
| `selector` | `go-packages` 只测改动涉及的 Go 包，`sharedPrefixes` 下的公共包连同依赖方一起测，超过 `maxPackages`（默认 40）扩大为全量；`vitest` 只跑与改动源文件同名或同目录的测试 |
| `reason`、`howToVerify`、`hint` | 给人看的说明 |

`docOnly` 只用来在证据里标注“仅文档”，检查是否执行仍由各自的 `when` 决定。
`fullSuiteTriggers.paths` 命中时，`go-packages` 扩大为 `./...`。
命令不存在时证据里单独标出“未找到命令”，说明要装工具，不是代码有问题。

`init` 生成的起始检查：

- `lint` 是 `extended` 占位，配置真实命令之前记入未执行项，不会冒充通过。
  把 `cmd` 改成项目实际的 lint 命令，`tier` 改为 `gate`。
- `harness-golden`：`.harness/**` 有改动时，在任务分支的检出里按它自己的配置重放黄金任务，改坏规则的分支在验证阶段就被拦下。
- `manual-check`、`visual-hint` 是 `extended` 与 `advisory` 的示例，按项目实际替换或删除。

改了这几项后，要同步修改 `golden/tasks.json` 里引用它们的起始用例 `g11` 到 `g14`，否则 `harness-golden` 检查失败。
例如 `lint` 配成真实命令后，把 `g11`、`g13`、`g14` 里 `expectNotExecuted` 中的 `lint` 移到 `expectChecks`；删掉两个示例检查时，去掉 `g12`，并从 `g11` 的 `expectNotExecuted` 里去掉 `manual-check`。

### policy.json：拦截规则

```json
{
  "presets": ["secrets", "git-safety", "gate-self"],
  "disabled": [],
  "rules": [
    {
      "id": "migration-baseline",
      "kind": "write-protect",
      "paths": ["db/migrations/0001_*.sql"],
      "reason": "迁移基线已经上线，改它会让已部署的库与代码不一致",
      "fix": "新增一个迁移文件，不要改已有的基线"
    }
  ]
}
```

示例只列出新增的一条规则，`init` 生成的 `commit-message` 规则照常留在 `rules` 里。
预设规则在前，项目规则在后；项目规则与预设规则同 id 时覆盖预设。
`disabled` 按 id 关闭规则，写了不存在的 id 时 `harness doctor` 会指出来。
每条规则都要写 `reason` 和 `fix`，拦截时原样展示给 Agent。

| kind | 判定什么 | 主要字段 | 在哪一层 |
| --- | --- | --- | --- |
| `read-protect` | 读取、搜索的路径 | `paths`、`allow` | 实时拦截 |
| `write-protect` | 写入的路径 | `paths`、`allow`、`allowIgnored` | 实时拦截；没有 `layer: "agent"` 时 `pre-commit` 也按暂存的路径判定 |
| `content-forbid` | 写入的内容 | `paths`、`patterns` | 实时拦截；没有 `layer: "agent"` 时 `pre-commit` 也按新增行判定 |
| `generated-header` | 文件头带生成标记的文件不许手改 | `paths`、`headerPatterns` | 实时拦截 |
| `shell-forbid` | 命令 | `patterns`、`scope` | 实时拦截 |
| `shell-secret-access` | 命令里出现密钥文件 | `patterns`、`allowVerbs` | 实时拦截 |
| `commit-message` | 提交信息 | `pattern`、`forbidPatterns` | `commit-msg` |
| `commit-forbid` | 能否在当前位置提交 | `when` | `pre-commit` |

- 路径字段是相对仓库根的 glob；`patterns`、`pattern` 是 JavaScript 正则，写在 JSON 里反斜杠要写两次。
- `when` 取 `main-worktree`、`linked-worktree`、`on-main` 或 `not-on-main`，只在条件成立时适用。
- `layer: "agent"` 表示只约束 Agent 的实时调用。
  git 层看不出是谁写的，入口由 `harness install` 生成后要能提交，所以 `protect-executor-entry` 带这个标记。
- `shell-forbid` 默认逐段判定，引号里的文字不参与匹配，提交信息里提到被禁命令不会误拦；`scope: "whole"` 对整条命令的原文判定。
- `write-protect` 只约束写文件类的工具调用，用 shell 命令写同一个文件不经过它；需要时再配一条 `shell-forbid`。

规则改动在任务分支上不生效：git 钩子与实时拦截读的都是主分支的配置，合入后才生效。
合入之前用 `harness golden --worktree` 按工作区的配置重放，确认新规则的判定符合预期。

### golden/tasks.json：黄金任务

黄金任务是对规则本身的回归用例，`harness golden` 重放。
`init` 自带 16 个起始用例，覆盖预设规则与起始检查；只针对可选预设的用例（例如 `g16`）在预设未启用时跳过。

给上面的规则加一个用例：

```json
{
  "id": "p01-migration-baseline",
  "title": "迁移基线不能改，新增迁移放行",
  "kind": "policy",
  "steps": [
    { "kind": "write", "path": "db/migrations/0001_init.sql", "content": "x", "expect": "deny", "rule": "migration-baseline" },
    { "kind": "write", "path": "db/migrations/0002_add_user.sql", "content": "x", "expect": "allow" }
  ]
}
```

- `policy` 用例：每步给出一次调用和期望结果。
  调用的 `kind` 取 `shell`、`write`、`read`、`search` 或 `commit`，配 `command` 或 `path`、`content`；期望写在 `expect`，可选 `rule`。
  步骤没写位置时按 Linked Worktree、不在主分支判定，可以用 `linkedWorktree`、`onMainBranch`、`ignored` 指定。
  被拒绝的步骤还要求规则带 `fix`。
- `verify-plan` 用例：给出 `changed` 路径，断言 `expectChecks`、`forbidChecks`、`expectNotExecuted`、`expectAdvisory`、`expectDocOnly`；`deleted` 或 `deletedPaths` 模拟删除。
- `presets`：声明用例只在这些预设启用时重放。

`harness golden` 默认按主分支的配置重放；`--worktree` 按当前工作区的配置，`harness-golden` 检查用的就是它。

### 预设

| 预设 | 内容 |
| --- | --- |
| `secrets` | 禁止读取、写入或用命令外发 `.env`、私钥、凭据文件与证据密钥，同名 `.example` 文件放行 |
| `git-safety` | 拦截递归删除、丢弃改动、强制删除 Worktree、删除分支、强推、`stash`、`--no-verify`，以及在主分支上合并、变基、重置和绕过合并工具写主分支 |
| `gate-self` | 保护执行器入口与绕过开关，轮换密钥与人工确认只能由人执行；规则与配置本身允许修改，合并前由人确认 |
| `plan-first` | 先方案后实施：没有实施授权记录时 Agent 只能写方案文件，大改动合并前必须有授权记录；你在对话里同意后由 Agent 照录原话记录 |
| `main-worktree` | 可选，`init` 不启用：主 Worktree 只用来合并，改动、切分支与提交都放在 Linked Worktree |

`secrets`、`git-safety`、`gate-self`、`plan-first` 由 `init` 写进 `presets`。
项目约定了别的方案目录时，同时修改 `intent.plan.markers` 和 `plan-before-code` 规则的 `allow`（在 `rules` 里写一条同 id 的规则覆盖预设）。
每条规则的细节见 `assets/presets/`，或在项目里运行 `harness rules`。

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

- `hooksDir`：harness 生成的钩子目录，入库，整份由 `harness install`、`init`、`upgrade` 生成，不手改。
  目录里已有其他工具的钩子时拒绝覆盖，提示把它们移到 `projectHooks`。
- `core.hooksPath` 指向主 Worktree 里这个目录的绝对路径，写在公共配置里。
  所有 Worktree，包括停在旧分支、检出里还没有这个目录的，都执行主分支上确认过的同一份钩子。
- `projectHooks`：项目自己的检查（lint、格式化等），与钩子同名的可执行脚本。
  harness 检查通过后调用，在当前 Worktree 的检出里执行，跟着分支走，Agent 可以维护。
  项目钩子改了暂存区或提交信息时，按最终内容再做一次 harness 检查。
  脚本存在但没有执行权限时拒绝提交，不会像 git 那样静默跳过。
- 推荐用 `.githooks`：它在 `gate-self` 的执行器入口保护范围内，Agent 不能直接改写。
  换成其他目录时，改动仍算门禁文件、合并前需要人确认，但没有实时写保护。

切换在任务分支里完成：改配置后运行 `harness install`（或 `upgrade`）生成钩子并提交。
主 Worktree 里还没有生成的钩子时不切换 `core.hooksPath`，否则它会指向不存在的目录，git 静默跳过钩子，主分支保护也随之失效。
合入后 `harness merge` 在主 Worktree 运行 `install --local` 完成切换，并提醒其他机器拉到新的主分支后各自运行一次 `install --local`：`core.hooksPath` 在各自的 `.git/config` 里，不随仓库分发。
`harness doctor` 检查 `core.hooksPath` 是否指向主 Worktree 的钩子目录，以及项目钩子是否可执行。
主 Worktree 换了位置时，重新运行 `install --local` 即可。
原来的钩子目录与安装它的工具配置（例如 husky 的 `prepare` 脚本）在同一个分支里删掉，否则下次安装依赖又会改回 `core.hooksPath`。
还没合入这次改动的旧分支里仍有那些配置，在它们的 Worktree 里安装依赖同样会改走 `core.hooksPath`；`harness merge` 在更新主分支前会改回来，平时用 `harness doctor` 检查。

## 独立评审的后端

评审进程不了解实现过程，只读验收清单、变更 diff 与验证证据摘要。
`.harness/config.json` 的 `review` 段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `backend` | `auto` | `auto` 按 `claude`、`codex` 的顺序用本机第一个可用的，都没有时报错并提示改用 `command`；也可以固定为 `claude`、`codex` 或 `command` |
| `model` | `sonnet` | `claude` 后端用的模型 |
| `maxBudgetUsd` | `2` | `claude` 后端单次评审的花费上限，单位美元 |
| `codexModel` | `null` | `codex` 后端用的模型，不填时用 Codex 的默认值 |
| `command` | `null` | `command` 后端的命令数组 |
| `blockSeverities` | `["high", "critical"]` | 哪些级别的发现阻断合并 |

- `claude`：在仓库目录里运行 `claude -p`，不开放任何工具，不加载项目设置，只带上你自己的 `~/.claude/settings.json`。
- `codex`：在空的临时目录里以只读沙箱运行 `codex exec`，读不到项目文件，也不会被项目里的钩子拦住。
- `command`：同样在空的临时目录里运行。

单次评审的超时是 20 分钟。

`command` 后端的约定：提示从 stdin 读入，结果写在 stdout，或者写到 `{output}` 指定的文件。
命令数组里的以下占位符会被替换成临时文件路径：

- `{schema}`：评审结果要满足的 JSON Schema，严格模式，可以直接交给支持结构化输出的工具。
- `{system}`：评审的系统提示词。
- `{output}`：期望命令把结果写到这里，文件存在时优先读它。

输出可以是 `{"verdict": ..., "requirementFit": ..., "engineeringQuality": ..., "findings": [...]}`，也可以是带 `structured_output` 字段的包装对象，允许包在 Markdown 代码块里。

```json
{ "review": { "backend": "command", "command": ["my-reviewer", "--json-schema", "{schema}", "--out", "{output}"] } }
```

## 命令速查

运行 `harness help` 查看全部命令与参数。

| 命令 | 用途 |
| --- | --- |
| `verify --branch <分支> [--plan] [--no-reuse]` | 验证并写签名证据；`--plan` 只列计划，`--no-reuse` 不复用已有结果 |
| `review --branch <分支>` | 独立评审 |
| `status [--branch <分支>]` | 只读汇总还差哪几步才能合并，默认看当前分支 |
| `confirm --branch <分支> [--yes] [--note <说明>]` | 查看门禁改动摘要；带 `--yes` 由人记录确认 |
| `approve --branch <分支> [--yes --note <原话>]` | 查看任务方案与授权状态；用户同意实施后由 Agent 带 `--yes` 照录原话记录授权 |
| `merge --branch <分支> [--dry-run]` | 受控合并到主分支 |
| `doctor` | 安装与接入自检 |
| `rules` | 列出解析后的生效规则 |
| `check --kind <shell\|write\|read\|search\|commit> ...` | 手工判定一次调用，可加 `--on-main`、`--linked-worktree`、`--ignored` 指定位置 |
| `golden [--worktree]` | 重放黄金任务 |
| `metrics [--days <n>]` | 按周统计合并次数、验证首过率、复用检查数、评审拒绝率、策略拦截、门禁确认与黄金任务通过率 |
| `conformance` | 逐项判定 L3 判据，样本不足的项标 `PEND`，不计为完成 |
| `key status`、`key rotate [--yes]` | 查看证据密钥；轮换由人执行 |
| `escalate <open\|list\|show\|answer\|resume>` | 例外上报 |
| `init [--dry-run] [--take-over] [--force]` | 接入当前项目，`--dry-run` 只预览 |
| `install [--take-over]`、`install --local` | 重新生成入口、钩子与客户端配置；`--local` 只刷新本机，不改入库文件 |
| `upgrade` | 把项目升级到运行它的 harness 版本 |
| `uninstall [--dry-run] [--purge]` | 解除接入 |
| `versions`、`prune [--keep <v,...>] [--dry-run]` | 列出、清理本机安装的版本 |
| `publish`、`version` | 把当前代码装进版本目录；打印版本号 |

`githook` 与 `hook` 由 git 钩子和客户端钩子调用，不需要手工运行。

## 信任模型与已知限制

harness 防的是 Agent 的误操作，以及被提示注入后常见的绕过写法，不防拥有本机权限、有意破坏的人或进程。

- 签名密钥在你的用户目录里，能读到它的进程就能伪造记录。
  `harness key status` 查看密钥指纹、权限，以及本仓库有多少记录能被当前密钥校验。
  密钥损坏或怀疑泄露时，由人在自己的终端运行 `harness key rotate --yes`：旧密钥移入 `retired/`，已有记录全部作废，进行中的分支重新 verify 与 review，涉及门禁的重新 confirm。
  Agent 只能运行不带 `--yes` 的预览。
- `HARNESS_MAIN_BYPASS`、`HARNESS_STORE`、`HARNESS_VERSION` 等环境变量与 `core.hooksPath` 设置能让门禁失效，只能由人在自己的终端使用，Agent 设置或读取它们会被拦截。
- 默认的 `.git/hooks` 不入库，目前没有规则阻止 Agent 直接改写或删除其中的钩子，也没有拦截 `harness uninstall`。
  钩子被删除或摘掉 harness 的块时，`harness doctor` 会报出来。
- 路径规则只约束写文件、读文件类的工具调用，用 shell 命令读写同一个文件要靠 `shell-forbid` 一类的命令规则覆盖。
- Codex 没有信任钩子时没有实时拦截；DeepSeek Harness 插件尚未完成端到端实测；Claude 桌面版只做了静态确认。
- 任务分级与先红后绿的判断仍由 Agent 做出，门禁只兜底可以机械判定的部分：
  写了方案的任务在记录授权前改不了代码，超过阈值或改了库表的分支没有授权记录合不进去。
  授权记录由 Agent 写入，门禁能保证它存在、照录了原话并且清单没有再改，但无法核实你是否真的说过这句话，要靠你在合并输出或 `harness status` 里核对。
  Agent 把大任务误判成直接实施时，要到合并才会被拦下；测试是否先于实现失败过，门禁无法证明，靠评审与你抽查。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `合并被拒绝(bad_commit_message)` | 分支上有提交不符合合并时的提交格式；在任务分支改写提交信息，再重新 verify、review |
| `主 Worktree 当前不在 main 分支` 或 `存在未提交或未跟踪文件` | 把主 Worktree 切回主分支并处理掉改动；`harness status` 与 `harness doctor` 会提前报出 |
| `本机没有安装门禁锁定的版本` | 在项目目录运行 `node ~/github/harness/bin/harness.mjs install --local` |
| `gate_change_unconfirmed` | 由人运行 `harness confirm --branch <分支>` 看过摘要，再加 `--yes` |
| `plan_unapproved` | 大改动没有实施授权记录，或授权后验收清单又改了；补齐方案并提交，向用户说明，用户同意后照录原话运行 `harness approve --branch <分支> --yes --note "<原话>"` |
| 写代码时被 `plan-before-code` 拦截 | 任务分支里有实施方案但还没有授权记录；用户还没同意就停下等，已经同意就按上一条记录；只是借用了 `docs/changes/` 下的旧方案时，把它移出这次改动 |
| `review_missing` 或 `review_blocked` | 运行 `harness review`；被拒时按发现修复，提交后重新 verify、review |
| 验证结果是 `incomplete` | `requires` 里的依赖目录在主 Worktree 里不存在，安装依赖后重跑 |
| 验证提示“未找到命令” | 本机没装检查用到的工具，装好后重跑 |
| 评审报 diff 超过上限 | 按输出的目录分组，把改动拆成几个分支分别合并 |
| `conflict` | 在任务分支上 `git merge main` 解决冲突，再重新验证与评审 |
| `main_moved` | 合并过程中主分支前进了，重新运行 `harness merge`，已有证据会复用 |
| `bootstrap_not_fast_forward` | 首次接入的分支落后于主分支，先在分支上 `git merge main` |
| `bootstrap_update_refused` | 原有的主分支保护拒绝了这次合并；在接入分支重新运行 `init --take-over`，提交后重新验证、确认并合并 |
| `post_merge_failed`，退出码 3 | 主分支已经更新，但 `postMergeCommand` 失败了；修好后手工补跑，不要当作合并完成 |
| `拒绝直接更新 refs/heads/main` | 主分支只接受 `harness merge`；拉取远端见“与远端同步” |
| `另一个合并正在进行` | 等那个合并结束后重试 |
| Codex 里的命令没被拦截 | 钩子还没信任，在 Codex 里运行 `/hooks` 信任 |
| `git worktree remove --force` 被 `git-discard-changes` 拦截 | 强删会丢掉 Worktree 里未提交的改动；先看 `git -C <Worktree> status`，需要的提交，确认不要时由你在自己的终端删除 |

## 卸载与版本管理

```bash
harness uninstall --dry-run   # 先看会删什么
harness uninstall             # 删除生成物，保留 .harness/ 下的配置、规则、用例与验收清单
harness uninstall --purge     # 连 .harness/ 一起删
harness versions              # 列出本机已安装的版本
harness prune --dry-run       # 预览清理旧版本，默认只保留当前版本
```

卸载由人在主 Worktree 里执行：共用的 git 钩子立即摘除，主分支保护随之解除，然后像普通仓库一样提交删除的文件。
卸载不删除版本目录，其他接入的项目不受影响。
版本目录被本机所有项目共用，清理前确认没有其他项目锁定着要删的版本，需要保留的用 `--keep` 列出。

## 开发

```bash
npm test
```

自测在临时仓库里运行，使用隔离的数据、密钥与版本目录，不碰本机已有的 harness 安装。
版本号只写在 `package.json` 里。
发版时更新 `CHANGELOG.md`，打 `v<版本>` 标签并推送：其他机器的 `install --local` 按项目锁定的版本从这个标签安装代码。
