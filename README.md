# harness

本地闭环的研发门禁。所有判定在本机完成，结果写入账本，不依赖云端 CI。

适用于任何 git 项目与任何编码工具：git 钩子对所有客户端生效；Claude Code、Codex、DeepSeek Harness 另有实时拦截适配。

## 接入一个项目

```bash
node ~/github/harness/bin/harness.mjs init
```

这一步会做四件事：

1. 在项目里写出 `.harness/`：`config.json`、`policy.json`、`verify.json`、`golden/tasks.json`、`rules/`、`templates/`、`acceptance/`。
2. 把当前版本代码装进 `~/.local/share/harness/versions/<版本>/`，并写入内容哈希清单。
3. 写出入口 `.harness/bin/harness`，接入 `pre-commit`、`commit-msg`、`reference-transaction` 三个 git 钩子。
4. 写出 `.claude/settings.json` 与 `.codex/hooks.json` 的拦截配置，生成 DSH 插件目录 `.harness/dsh-plugin/`，并在 `AGENTS.md` 写入托管块。

把 `.harness/bin/` 与 `.harness/dsh-plugin/` 加进 `.gitignore`，其余 `.harness/` 内容提交。接入后运行 `.harness/bin/harness doctor` 自检。

DeepSeek Harness 需要在你自己的终端注册一次插件：

```bash
dsh plugin --profile <名称> add <项目路径>/.harness/dsh-plugin
```

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

检查的三个档位：

- `gate`：必过，失败就不能合并。
- `extended`：不自动执行，写进证据的未执行清单并附补验方式。
- `advisory`：只提示，不计入未执行，适合需要人看一眼的视觉类检查。

## 信任模型

- 门禁的配置一律从主分支的 git 对象读取，代码从按版本安装的目录执行；任务分支里改过的门禁不能决定自己是否放行。
- 证据与评审绑定被验证的分支提交并做 HMAC 签名，密钥在 `~/.local/share/harness/evidence.key`。
- 主分支只能由 `harness merge` 更新：`reference-transaction` 钩子校验只有合并工具能生成的令牌。
- 门禁配置改动的人工确认绑定合并结果的 tree，内容再变确认即失效。
- 签名密钥在你的用户目录里，能防误操作和提示注入，防不了拥有本机权限的人。

## 升级

```bash
cd ~/github/harness && git pull     # 或修改后提交
cd <项目> && node ~/github/harness/bin/harness.mjs upgrade
```

`upgrade` 安装新版本、重写 `rules/` 与 `templates/`，保留 `config.json`、`policy.json`、`verify.json`。

## 命令

运行 `harness help` 查看全部命令。常用的体检命令：

- `harness status --branch <分支>`：只读汇总，指出还差哪几步才能合并。
- `harness doctor`：安装与接入自检，未实测的客户端标 `[?]`。
- `harness conformance`：逐项判定 L3 判据，样本不足的项标 `PEND`。
- `harness metrics`：按周度量。
- `harness golden`：重放黄金任务。接入时自带 14 个用例，改了规则后运行，原有判定退化会直接失败。
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
