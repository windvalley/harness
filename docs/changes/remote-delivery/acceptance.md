# 验收清单：远程交付模式（M1）

<!-- 对应同目录的 spec.md 与 plan.md。每条写成能用测试或命令判定的结果，实施方案把每条对应到测试。 -->

## 应该发生

- R1 未配置 `delivery` 或 `delivery.mode` 为 `local` 时，`merge`、`status`、`doctor`、`worktree clean` 的行为与 0.8.2 一致，现有回归全部通过。
- R2 主分支配置 `delivery.mode` 为 `remote` 时，`harness merge` 以 `delivery_remote` 拒绝，本地主分支不变，提示改用 `harness submit`。
- R3 `harness submit --branch <任务分支>` 在门禁全部满足时依次完成：取得远程主分支的最新提交；核对与 `merge` 相同的条件（提交信息、门禁改动确认、实施授权、验收清单、验证证据、独立评审与 `review_stale`）；把核对过的提交普通推送到远程同名分支；创建指向主分支的 MR/PR；写入签名的提交记录；输出 MR/PR 链接。
- R4 MR/PR 描述里有一个由 harness 管理的区块，写明任务提交、远程主分支提交、预期合并结果的 tree、验证结果与未执行项、评审结论和实施授权原话。
- R5 同一源分支已有指向主分支的打开 MR/PR 时，`submit` 只替换描述里 harness 管理的区块，保留其他文字，不新建。
- R6 远程模式下 `harness status` 的最后一行提示 `harness submit`；分支已提交且顶端没变时显示 MR/PR 链接与提交时间；顶端变了时提示提交记录已过期、需要重新提交。
- R7 `harness sync` 取得远程主分支后把本地主分支快进过去，主 Worktree 的文件同步更新；改动涉及入口或钩子时刷新本机安装；随后执行 `merge.postMergeCommand`。
- R8 `sync` 按同步前本地主分支上的配置判断门禁改动；有门禁改动时，要求先有绑定目标 tree 的人工确认，确认命令是 `harness confirm --branch <远程>/<主分支>`。
- R9 新增或修改 `delivery` 段的改动，即使 `governance.confirmOnGateChange` 为 `false`，`merge`、`submit`、`sync` 也要求人工确认。
- R10 首次接入时，接入分支可以 `submit`，前提是已有首次接入的人工确认；平台合入后 `sync` 导入配置同样要求确认，目标 tree 不变时沿用同一条确认。
- R11 `sync` 在本地模式下同样可用，替代手册里由人用绕过开关快进的做法。
- R12 `harness install --version <版本>` 只把指定版本装进本机版本目录，不改项目里的任何文件。
- R13 远程模式下 `harness doctor` 检查远程是否存在、平台命令是否在 PATH，主 Worktree 一项改为说明能否接收同步。
- R14 `AGENTS.md` 托管块、`core.md`、`harness.md` 与 `git-safety` 的提示按两种模式说明交付方式；参考手册、教程、README 与变更记录同步。

## 绝对不能发生

- X1 `submit` 推送没有核对过的提交：核对开始后任务分支顶端移动时以 `branch_moved` 拒绝，不推送。
- X2 `submit` 强推：远程同名分支已存在且不是核对过提交的祖先时以 `push_rejected` 拒绝，远程保持不变。
- X3 `submit` 接受主分支、远程跟踪引用或提交号作为源，或者推送到远程主分支。
- X4 本地主分支与远程主分支不一致时 `submit` 继续执行：以 `base_stale` 拒绝并提示先 `sync`。
- X5 `sync` 改写本地主分支的历史：本地主分支有远程没有的提交时以 `not_fast_forward` 拒绝。
- X6 `sync` 按目标提交上的配置决定要不要确认，或者没有确认就导入门禁改动。
- X7 主 Worktree 不洁净、有进行中的 git 操作，或者另一个合并或同步正在进行时，`sync` 更新本地主分支。
- X8 harness 读取、保存或打印平台令牌，或者把令牌放进平台命令的参数。
- X9 harness 在平台上合并 MR/PR。

## 失败时

- F1 平台命令不在 PATH 或认证检查失败时，`submit` 在推送之前拒绝，给出由人安装或登录的命令，远程保持不变。
- F2 取得远程主分支失败时，`submit` 与 `sync` 拒绝，不推送，本地主分支不变。
- F3 推送成功但创建或更新 MR/PR 失败时，退出码非零，提交记录停在“已推送”；重跑 `submit` 时不重复推送，只补 MR/PR。
- F4 `sync` 的目标提交锁定的 harness 版本本机没有安装时，在更新本地主分支之前以 `version_missing` 拒绝，给出由人执行的 `install --version` 命令。
- F5 `sync` 更新本地主分支后，本机安装刷新失败或 `postMergeCommand` 失败时，明确报告主分支已更新、哪一步失败以及补跑方式，退出码与 `merge` 的同类失败一致。
