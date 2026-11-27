# 实施方案

- 行为说明：同目录的 spec.md
- 核心契约：同目录的 contract.md
- 验收清单：`.harness/acceptance/feature-post-approval-revisions.md`

## 验收与测试

| 验收条目 | 测试（文件与名称） | 层级 |
| --- | --- | --- |
| 首次授权缺契约被拒绝，不写记录与账本 | `test/plan.test.mjs` 新增“首次授权缺少核心契约时拒绝” | E2E（CLI） |
| 多阶段授权任一阶段缺契约被拒绝 | `test/stages.test.mjs` 新增“方案级授权要求每个阶段有核心契约” | E2E（CLI） |
| 契约任务修订清单、spec、plan 后授权仍有效 | `test/plan.test.mjs` 扩展“已授权任务更换实现路径”，覆盖 status、verify、merge、写入门禁；`test/stop.test.mjs` 覆盖收尾检查 | 集成 |
| 契约变化仍需人工确认 | `test/plan.test.mjs` 现有契约重确认用例保持通过 | 集成 |
| 旧记录语义不变 | `test/plan.test.mjs` 现有清单失效用例改用旧记录夹具后保持通过 | 集成 |
| 修订摘要内容、无修订、基线不可还原、脱敏 | `test/plan.test.mjs` 新增修订摘要用例；`src/lib/acceptance.mjs` 章节原文差异的单元用例 | 单元、集成 |
| 摘要出现在 status、交接视图、merge、PR/MR 描述 | `test/plan.test.mjs`、`test/handoff.test.mjs`、`test/merge.test.mjs`、`test/delivery.test.mjs` | E2E（CLI） |
| 评审提示含契约、修订条目、来源标签与判定说明 | `test/review.test.mjs` 的 `buildPrompt` 与 `readAcceptance` 用例 | 单元 |
| 规则、模板、托管块文本 | `test/hooks.test.mjs` 的规则内容契约 | 单元 |
| 文档与生成结果一致 | `npm run docs:check`、`test/docs.test.mjs` | 集成 |

## 实现顺序

| 步骤 | 改动 | 验证方式 | 状态 |
| --- | --- | --- | --- |
| 1 | 测试夹具：`test/helpers.mjs` 新增写入旧记录的辅助函数（直接用 `src/lib/store.mjs` 写入与旧版字段一致的签名记录），新增默认带 `contract.md` 的方案提交辅助；把依赖“没有契约也能授权”的用例迁到这两个辅助上 | 迁移后的现有测试全部通过 | 待开始 |
| 2 | 按上表先写新测试并运行，确认因功能未实现而失败 | 定向 `node --test` 红灯 | 待开始 |
| 3 | `src/plan/plan.mjs`：`planApprovalPreflight` 与 `approvePlan` 在没有已有记录时要求核心契约；`src/plan/stages.mjs` 的 `prepareGrant` 要求每个阶段有 `contract` | 步骤 2 的授权用例转绿 | 待开始 |
| 4 | `src/lib/acceptance.mjs` 新增按章节计算删除与新增原文条目的函数；`src/plan/plan.mjs` 新增 `revisionSummary`，从授权记录的 `branchCommit` 还原基线，汇总清单、spec、plan 变化与“授权后修订”章节，输出经 `redact` | 摘要单元与集成用例转绿 | 待开始 |
| 5 | 接入输出：`src/status.mjs` 计数行、`src/handoff.mjs` 完整摘要、`src/merge/merge.mjs` 成功日志、`src/delivery/submit.mjs` PR/MR 描述 | 对应 CLI 用例转绿 | 待开始 |
| 6 | `src/review/review.mjs`：`readAcceptance` 区分“已授权且授权后有修订”的来源标签，`buildPrompt` 附契约原文与修订条目，评审说明补充判定要求 | 评审用例转绿 | 待开始 |
| 7 | 规则与模板：`core.md`、`harness.md`、`method-design-planning.md` 写明分界并消除冲突；`templates/contract.md` 移出内部技术方案；`templates/plan.md` 新增“授权后修订”章节；`src/install/managed.mjs` 托管块加一句 | 规则内容用例转绿 | 待开始 |
| 8 | 文档：`docs/reference.md`、`docs/content/` 中授权相关段落与原理图标签，运行 `npm run docs:build` 并审查生成差异；按需更新 `assets/golden/builtin.json` | `npm run docs:check` | 待开始 |
| 9 | 自审 diff，运行全量测试与文档检查，在临时仓库真实走一遍：缺契约被拒、授权、改清单、status、merge 输出摘要 | 命令输出 | 待开始 |

## 交付前检查

- `node --test test/plan.test.mjs test/stages.test.mjs test/review.test.mjs test/merge.test.mjs test/delivery.test.mjs test/handoff.test.mjs test/hooks.test.mjs`
- `npm test`
- `npm run docs:check`
- `git diff --check`

## 环境与依赖

- 使用现有 Node.js、Git 与 `test/helpers.mjs` 临时仓库，不新增依赖，不调用在线模型或真实平台。

## 复用

- 基线还原复用 `restoreAcceptance` 的思路与 `showBlob`；章节切分复用 `src/lib/acceptance.mjs` 的 `sections` 与 `splitAcceptance`。
- 凭据遮盖复用 `redact`；输出复用现有 `status`、交接视图、`merge` 日志与 `submit` 描述构造。
- 契约失效判定、`--confirm-contract` 与人工专用拦截规则保持原样。

## 风险与备选

- 测试夹具改动面大：约 100 处 `approve` 调用分布在 14 个测试文件。
  优先在 `test/helpers.mjs` 集中提供带契约的方案提交辅助，单个用例只改一行；专门验证旧语义的用例改用旧记录辅助。
- 已经装了 harness 的项目里，正在进行、尚未授权的任务升级后需要补写契约。
  `approve` 的拒绝信息直接给出模板路径，补写成本是几行文字；这一点写进 CHANGELOG 提示（发版时再写，本任务不改版本号）。
- 评审判断“放宽”依赖模型理解，可能漏判。
  契约仍是硬底线，评审只是补充；修订摘要始终交给用户，最终由用户判断。

## 授权后修订

<!-- 授权后对验收清单或方案的每次修订记一行：改动、类型（细化 / 加严 / 新增 / 删除 / 放宽 / 实现调整）、理由、证据。 -->

- 暂无。

## 恢复

- 改动集中在授权判定、摘要输出与规则文本；出现问题时回退本分支提交即可，旧记录与已有授权不受影响。

## 执行记录

- 方案已写好，等待用户确认。
