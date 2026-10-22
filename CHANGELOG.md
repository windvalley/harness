# 变更记录

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号遵循语义化版本。

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
