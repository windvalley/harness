# 变更记录

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号遵循语义化版本。

## [0.6.0] - 2026-10-26

钩子目录可以由 harness 接管，不再挂在某个子项目的工具上；所有 Worktree，包括停在旧分支的，都执行主分支上确认过的同一份钩子。

### 新增

- `.harness/config.json` 新增 `git.hooksDir` 与 `git.projectHooks`。`hooksDir` 里的钩子整份由 harness 生成，目录里已有其他工具的钩子时拒绝覆盖；`projectHooks` 放项目自己的检查，harness 检查通过后调用，在当前 Worktree 的检出里执行。
- 项目钩子改了暂存区或提交信息时，按最终内容再做一次 harness 检查；项目钩子存在但不可执行时拒绝提交。
- `install`、`install --local`、`upgrade` 让 `core.hooksPath` 指向主 Worktree 里的钩子目录；主 Worktree 里还没有生成的钩子时不切换，合入后由 `harness merge` 完成切换。
- `doctor` 检查 `core.hooksPath` 是否指向主 Worktree 的钩子目录，以及项目钩子是否可执行。
- 合并改变了钩子目录时，提醒其他机器各自运行一次 `install --local`。
- `uninstall` 在接管模式下删除生成的钩子并撤销 `core.hooksPath`。

### 修复

- `commit-msg` 按 git 的清理规则判定提交信息：用编辑器写提交信息时，钩子拿到的文件还带着注释行与剪刀线以下的 diff，原先会被带 `$` 的规则误拒。
- `core.hooksPath` 是指向主 Worktree 的绝对路径时，在 Linked Worktree 里运行 `install` 会改写主 Worktree 的入库文件；现在定位到当前 Worktree 自己的检出。
- 合并改动了 `.harness/config.json` 时同样在主 Worktree 刷新本机钩子。

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
