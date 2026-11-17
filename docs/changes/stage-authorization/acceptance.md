# 多阶段方案授权与阶段续跑验收

## 范围

阶段文件、方案级授权与派生授权、授权后材料变化的运行时失效、阶段合并后的续跑欠项与 status 方案进度。
不自动建分支、授权或合并，不改变验收清单按分支名定位的约定，不出现项目专属名称。

## 兼容性

- 没有阶段文件时，`approve`、`status`、`merge` 与收尾检查不执行任何阶段逻辑，阶段相关输出不出现。
- 不带 `--stages` 与 `--from-stages` 的 `approve` 行为与输出不变。

## 授权命令

- `approve --stages` 记录用户原话、阶段文件哈希、各阶段验收清单哈希与当前分支对应的阶段。
- `approve --stages` 在阶段 `id` 重复、阶段文件或任一阶段验收清单未在分支上提交时拒绝，并说明原因。
- 建议分支名不符合当前 `branch-name` 规则时，`approve --stages` 只提示不拒绝。
- `approve --stages` 的方案级记录按阶段文件路径做键，重新授权覆盖当前记录，账本保留每次授权事件。
- `approve --from-stages` 不接受 `--note`，写入的普通授权记录照搬原话并注明阶段文件路径与阶段 `id`。
- `approve --from-stages` 在主分支阶段文件与方案级记录不一致、新分支验收清单与该阶段哈希不一致、前序阶段未合入时拒绝。
- 阶段分支改用合规的新名字后，`approve --from-stages` 成功，无需用户重新授权。

## 授权失效

- `approve --stages` 之后，携带分支上的阶段文件改动，`status`、`merge`、`review` 与收尾检查一致判为未授权。
- `approve --stages` 之后，携带分支上任一阶段验收清单改动，上述入口一致判为未授权。
- `approve --from-stages` 之后，派生分支的验收清单改动，上述入口一致判为未授权。
- 来源记录缺失或验签失败时，派生授权在上述入口一致判为未授权。
- 顺序用例：v1 授权并派生两个阶段，重新授权只修改其中一个阶段，被修改阶段的派生授权失效，未修改阶段的派生授权仍然通过。
- 被修改阶段改回授权过的原内容并重新授权后，该阶段的派生授权恢复有效。
- 修订后的方案在另一分支重新授权后，旧携带分支判为未授权。
- 派生授权的有效性不依赖来源记录的授权时间。
- 主分支上其他阶段的材料变化不影响已派生分支的合并，被改动阶段的 `approve --from-stages` 被拒绝。
- `submit` 的授权判定与上述入口一致。

## 收尾检查与 status

- 本会话推进过的阶段分支合入后，下一阶段没有分支时，收尾检查给出包含建议分支名、阶段验收清单与 `approve --from-stages` 命令的欠项。
- 下一阶段已有未交付分支时，提示接着完成该分支；全部阶段合入后不再提示。
- 方案级授权或来源记录失效时，不生成续跑欠项，改为提示需要用户重新授权。
- 单个分支的阶段信息读取失败时记录诊断，其他分支照常检查。
- 阶段分支的 `harness status` 显示已合入阶段数、总数与下一阶段，非阶段分支输出不变。

## 规则与文档

- `assets/rules/harness.md`、`assets/rules/method-design-planning.md` 与文档站说明覆盖阶段文件、两种授权用法、失效规则与“仅在用户明确同意覆盖全部阶段时使用 `--stages`”。
- 规则、代码与文档不含任何具体项目、阶段或分支名称。

## 交付

- 每条行为先有失败用例再实现，记录红灯命令与输出。
- `npm test`、`npm run docs:build`、`npm run docs:check` 与 `git diff --check` 通过。
- 完成独立评审，合并本地 `main` 并推送 `origin main`，删除任务分支。
- 不修改版本号与 CHANGELOG，不打标签。

## 验证记录

- 红灯：`node --test test/stages.test.mjs`，10 个用例中 9 个失败，失败原因是 `approve` 不认识 `--stages`、`--from-stages`，status 与收尾检查没有阶段逻辑；兼容性用例在原实现上通过。
  日志保留在本机 `/tmp/harness-stages-red.log`。
- 绿灯：实现后 `node --test test/stages.test.mjs test/plan.test.mjs test/stop.test.mjs` 54/54 通过。
- 自查补充的红灯：阶段分支删除后只认本地合并记录，远程推送记录不算已合入，新增用例失败；修复后 `test/stages.test.mjs` 11/11 通过。
- 授权失效的各入口：`status`、`merge`、评审读取清单来源与收尾检查由 `test/stages.test.mjs` 直接覆盖；`submit` 与 `merge` 共用 `checkGates` 里的同一次 `approvalState` 判定（`src/merge/merge.mjs`），没有单独的 `submit` 用例。
- “单个分支的阶段信息读取失败”：方案级授权缺失、被改动或主分支阶段文件不一致时，该分支只生成要用户处理的提示，与其他分支的欠项一起列出，用例覆盖；读取中抛出的异常沿用收尾检查已有的按分支隔离，记 `stop.error`。
- 独立评审补充的红灯：分支删除后的续跑、全部合入后误报、提示去重不清除、`status` 读取出错整体失败，4 个用例先失败；修复后 `node --test test/stages.test.mjs test/stop.test.mjs test/plan.test.mjs` 59/59 通过。
- 全量：评审修改前 `npm test` 672/672 通过；最终结果见下一条。
- 全量：评审修改后 `npm test` 677/677 通过，无跳过；`npm run docs:check` 与 `git diff --check` 通过。
