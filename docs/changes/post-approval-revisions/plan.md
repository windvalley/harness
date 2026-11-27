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
| 1 | 测试夹具：`test/helpers.mjs` 新增 `legacyPlanRecord`、`legacyStagesGrant`（直接写授权时没有契约的旧记录）与 `patchPlanRecord`；依赖“没有契约也能授权”的用例改为补契约或改用旧记录 | 迁移后的现有测试全部通过 | 完成：plan、stages、risk、stop、handoff 迁移后全部通过 |
| 2 | 先实现缺契约拒绝，运行受影响测试确认按目标失败，再迁移夹具；新功能用例与实现同步补上 | 定向 `node --test` | 完成：首轮 50 余项按目标失败，迁移后转绿 |
| 3 | `planApprovalPreflight`、`approvePlan` 与 CLI 预览在没有已有记录时要求核心契约；`prepareGrant` 首次授权要求每个阶段有 `contract`；`planSummary` 识别只有契约的方案目录与已随前序阶段合入的契约 | 授权用例 | 完成 |
| 4 | `src/lib/acceptance.mjs` 新增 `sectionLineChanges`、`sectionText`；`src/plan/plan.mjs` 新增 `revisionSummary`、`formatRevisionCount`、`formatRevisionSummary` | 摘要用例 | 完成 |
| 5 | 接入 status 计数行、交接视图、merge 成功日志、submit PR/MR 描述；摘要出错时降级为一行说明 | CLI 用例与 `sectionBody` 单元用例 | 完成 |
| 6 | `readAcceptance` 新增 `revised` 来源并附契约原文与修订摘要；`buildPrompt` 增加两节；评审说明补充判定要求；`revised` 计入已确认来源 | `test/review.test.mjs`、`test/stages.test.mjs` | 完成 |
| 7 | 规则、模板与托管块按方案修改，`approve` 帮助文本注明须含 `contract.md` | `test/hooks.test.mjs` 新增规则内容用例 | 完成 |
| 8 | 更新 `docs/reference.md`、`docs/content/daily.html`、`docs/content/principles.html`，生成文档；黄金任务只覆盖写入门禁，无需修改 | `npm run docs:check` | 完成：10 个页面与搜索索引一致 |
| 9 | 自审 diff，全量测试与文档检查，临时仓库真实走一遍 | 命令输出 | 完成：见执行记录 |

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

- 测试夹具不新增“带契约的方案提交辅助”，改为在各用例里直接补 `contract.md`；类型：实现调整；理由：实际只有 5 个测试文件、约 40 处调用需要迁移，远少于预估的 100 处，单独辅助函数收益不大；证据：`test/plan.test.mjs` 等迁移后全部通过。
- 新增“契约可以只出现在方案目录里”与“契约已随前序阶段合入主分支”两种识别；类型：实现调整；理由：原判定只认改过的 `plan.md` 所在目录，补契约或阶段重新授权时找不到契约；只在本分支改过的方案目录里找，不借用主分支上其他任务的契约；证据：`test/plan.test.mjs` 的“首次授权缺少核心契约时拒绝”、`test/stages.test.mjs` 的重新授权用例。
- 已授权且授权后有修订时，评审清单来源记为新的 `revised`，并计入已确认来源；类型：细化；理由：验收要求“来源标签写明授权后有修订”，同时保持已授权清单 `partial` 即拒绝的规则；证据：`test/review.test.mjs`、`test/stages.test.mjs`。
- 多阶段：阶段清单在契约范围内修订不再使方案级授权失效，后续阶段从 `--from-stages` 继承时也只核对契约；类型：细化；理由：这是“授权只绑定核心契约”在多阶段上的直接推论，原有判定代码本就如此，本次补测试锁住；证据：`test/stages.test.mjs` 的携带分支与派生用例。

## 恢复

- 改动集中在授权判定、摘要输出与规则文本；出现问题时回退本分支提交即可，旧记录与已有授权不受影响。

## 执行记录

- 用户在对话中回复“同意”后开始实施。
- 基线 `npm test` 848 项全部通过；实现后 `npm test` 855 项全部通过，`npm run docs:check` 核对 10 个页面与搜索索引通过，`git diff --check` 通过。
- 临时仓库真实走查：缺契约时 `approve` 预览提示补写、`approve --yes` 退出码 1；补契约后记录成功；授权后改清单与方案，`status` 显示 `plan:revisions` 计数且授权仍有效；`merge` 输出列出新增条目、实施方案章节变化与修订理由。
- 剩余事项、阻塞与下一步：无；提交、合并到本地 `main` 并普通推送。
