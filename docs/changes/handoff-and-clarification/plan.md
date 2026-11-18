# 实施方案

- 行为说明：同目录的 spec.md。
- 验收清单：`.harness/acceptance/feature-handoff-and-clarification.md`。

## 验收与测试

| 验收条目 | 测试（文件与名称） | 层级 |
| --- | --- | --- |
| 交接视图汇总真实任务状态 | `test/handoff.test.mjs` 的完整交接、缺失状态与已合入场景 | 集成 |
| CLI 参数、退出语义与只读性 | `test/handoff.test.mjs`、`test/cli-help.test.mjs` | E2E |
| 动态正文脱敏 | `test/handoff.test.mjs` 的授权与上报凭据场景 | 集成 |
| 有契约时减少无效澄清且不扩大授权 | `test/hooks.test.mjs` 的规则内容契约 | 单元 |

## 实现顺序

| 步骤 | 改动 | 验证方式 | 状态 |
| --- | --- | --- | --- |
| 1 | 先写交接 CLI 与规则内容测试并运行，确认因参数和规则尚未实现而失败 | 定向 `node --test` 红灯输出 | 完成：86 项中 80 通过、6 项按目标失败 |
| 2 | 在 `src/status.mjs` 汇总现有状态，在 `src/cli.mjs` 接入 `--handoff` | 交接定向测试转绿 | 完成：实际新增 `src/handoff.mjs`，15 项 CLI 测试通过 |
| 3 | 收窄 `core.md` 与 `method-requirements.md` 的澄清边界 | 规则内容测试转绿 | 完成：定向规则测试通过 |
| 4 | 更新参考手册、文档站正文和命令速查，再生成文档 | `npm run docs:build` 与 `docs:check` | 完成：10 个页面与搜索索引核对通过 |
| 5 | 自审实际 diff，运行相关测试、全量测试与文档检查 | 最终命令输出 | 完成：全量 701 项通过，文档检查通过 |

## 交付前检查

- `node --test test/handoff.test.mjs test/cli-help.test.mjs test/hooks.test.mjs`
- `npm test`
- `npm run docs:check`
- 使用临时仓库真实执行 `status --handoff`，核对输出与已有签名记录一致。

## 环境与依赖

- 使用现有 Node.js、Git 和 `test/helpers.mjs` 临时仓库，不增加依赖，不调用在线模型或真实平台。

## 复用

- 复用 `branchStatus`、`planSummary`、`worktreeEntries`、`statusShort`、`listEscalations` 和 `redact`。
- 复用现有命令分派、退出码与文档生成器。

## 恢复

- 新功能由 `--handoff` 显式触发，普通 `status` 保持原行为；如有问题可移除新分支提交，不影响已有证据与项目配置。

## 执行记录

- 已完成与验证证据：有效 Red 为 86 项中 80 通过、6 项目标失败；实现后交接与帮助 16 项通过，最终 `npm test` 为 701 项全部通过，`npm run docs:check` 核对 10 个页面与搜索索引通过，`git diff --check` 通过。
- 第一轮全量测试的方案评审取消时序用例在并发负载下未等到 PID 文件，单独重跑通过；第二轮全量测试全部通过，未修改该无关模块。
- 剩余事项、阻塞与下一步：无剩余实现项；提交当前任务改动，合并到本地 `main` 并普通推送。
