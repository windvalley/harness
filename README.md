# harness

harness 是跑在本机的研发门禁，面向“Agent 写代码、人把关”的 git 项目。
它在 Agent 调用工具时拦下危险操作，在合并前要求验证证据与独立评审，并让主分支只接受它的合并命令写入。
所有判定都在本机完成，不依赖云端 CI，也没有 npm 依赖。

**[阅读图文使用教程](https://windvalley.github.io/harness/)**：架构图、核心原理和上手步骤都在这里。
配置项与命令的完整说明见[参考手册](docs/reference.md)。

## 它管什么

| 层 | 何时生效 | 管什么 | 覆盖谁 |
| --- | --- | --- | --- |
| 实时拦截 | Agent 每次调用工具之前 | 读取密钥、改写门禁入口、不可逆的 git 操作、绕过开关 | Claude Code、Codex、DeepSeek Harness |
| git 钩子 | 每次提交与引用更新 | 提交信息、暂存的密钥文件、主分支的写入 | 所有客户端和人 |
| 受控合并 | 合并到主分支时 | 验证证据、独立评审、门禁改动的人工确认 | 所有客户端和人 |

前两层负责当场纠正，拦截信息里带着原因和正确做法，Agent 照着改道即可。
第三层负责结果把关：即使某个客户端没有接上实时拦截，没有证据和评审的改动也进不了主分支。

## 快速开始

需要：

- macOS 或 Linux，Node.js 20 及以上，git 2.38 及以上。
- 本机已登录的 `claude`（Claude Code CLI）或 `codex`，用来做独立评审；两者都没有时见[独立评审的后端](docs/reference.md#独立评审的后端)。

### 1. 获取 harness

```bash
git clone https://github.com/windvalley/harness.git ~/github/harness
```

不需要全局安装。
克隆到别的目录也可以，把下文命令里的路径换掉即可。

### 2. 接入项目

接入本身也走一遍门禁流程：在任务分支里写入，验证、评审，由人确认后合并。

```bash
cd <项目>        # 主 Worktree，停在 main 且洁净
git worktree add -b chore/harness-onboard ../<项目>-onboard main
cd ../<项目>-onboard

node ~/github/harness/bin/harness.mjs init --dry-run   # 预览将写入的文件，不落盘
node ~/github/harness/bin/harness.mjs init
git add -A
git commit -m "chore(harness): 接入门禁" -m "- 写入门禁配置、规则与入口"

.harness/bin/harness verify  --branch chore/harness-onboard
.harness/bin/harness review  --branch chore/harness-onboard
.harness/bin/harness confirm --branch chore/harness-onboard          # 查看门禁改动摘要
.harness/bin/harness confirm --branch chore/harness-onboard --yes    # 由人执行
.harness/bin/harness merge   --branch chore/harness-onboard
```

只有带 `--yes` 的确认必须由人执行，其余步骤都可以交给 Agent。
提交信息默认要求标题之后空一行，每行一条 `- ` 开头的要点，见[提交信息](docs/reference.md#提交信息)。
项目里已有 husky、自定义钩子等其他门禁时，先看 `--dry-run` 的结果，见[已有其他门禁的项目](docs/reference.md#已有其他门禁的项目)。

### 3. 让客户端用上实时拦截

- Claude Code：重启正在运行的会话。
- Codex：在 Codex 里运行 `/hooks`，进入 `Review hooks` 后按 `t` 信任。
- DeepSeek Harness：注册一次插件，命令见[客户端那一侧](docs/reference.md#客户端那一侧)。

然后运行 `.harness/bin/harness doctor` 检查接入状态，`[!!]` 表示还需要处理。

### 4. 完成第一个任务

每个任务一个分支、一个 Linked Worktree：

```bash
cd <项目>
git worktree add -b feat/login ../<项目>-login main
cd ../<项目>-login
# 把需求交给 Agent，它按 AGENTS.md 里的规则实现并提交
.harness/bin/harness verify --branch feat/login   # 按改动选出检查并执行，写签名证据
.harness/bin/harness review --branch feat/login   # 独立评审
.harness/bin/harness status --branch feat/login   # 只读：还差哪几步才能合并
.harness/bin/harness merge  --branch feat/login   # 核对证据与评审，更新主分支
```

这几步同样可以交给 Agent。
`merge` 要求主 Worktree 停在 main 且洁净。
在 main 上直接提交会被拒绝，这是预期行为：主分支只接受 `harness merge` 写入。
合并后的任务 Worktree 用 `.harness/bin/harness worktree clean` 预览后清理。

## 文档

- [图文使用教程](https://windvalley.github.io/harness/)：架构、核心原理、上手与日常流程。
- [参考手册](docs/reference.md)：
  - [工作原理](docs/reference.md#工作原理)：三层防线、合并条件、信任根、文件位置。
  - [接入一个项目](docs/reference.md#接入一个项目)：`init` 写了什么、已有门禁的项目、客户端那一侧。
  - [日常使用](docs/reference.md#日常使用)：任务分级、提示词、清理 Worktree、验收清单、被拦截时、与远端同步。
  - [新成员或新机器](docs/reference.md#新成员或新机器)与[升级](docs/reference.md#升级)。
  - [配置](docs/reference.md#配置)：`config.json`、`verify.json`、`policy.json`、黄金任务、预设。
  - [独立评审的后端](docs/reference.md#独立评审的后端)：`claude`、`codex` 与自定义 `command` 后端的约定。
  - [命令速查](docs/reference.md#命令速查)、[常见问题](docs/reference.md#常见问题)、[信任模型与已知限制](docs/reference.md#信任模型与已知限制)、[卸载与版本管理](docs/reference.md#卸载与版本管理)。
- [变更记录](CHANGELOG.md)

## 开发

```bash
npm test
```

自测在临时仓库里运行，使用隔离的数据、密钥与版本目录，不碰本机已有的 harness 安装。
版本号只写在 `package.json` 里。
改了分发的内容（`src`、`assets`、`bin`、`package.json`）就要升版本号：同一个版本号已经装进版本目录、内容又不同时，`publish` 与 `install` 直接报错。
只改 README、CHANGELOG、测试这类不分发的文件，不用升版本号。
发版时更新 `CHANGELOG.md`，打 `v<版本>` 标签并推送：其他机器的 `install --local` 按项目锁定的版本从这个标签安装代码。
标签指向的提交，分发内容要和本机已安装的同版本一致，否则别的机器装出来的门禁和你本机跑的不是同一份。

## 许可

[MIT](LICENSE)
