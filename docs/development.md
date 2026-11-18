# 开发与发布

本文面向 harness 维护者。
首次接入和日常使用请从 [README](../README.md) 开始，具体命令与配置见[参考手册](reference.md)。

## 运行测试

需要 Node.js 20 及以上。

```bash
npm test
```

测试在临时仓库中执行，使用隔离的数据、密钥和版本目录，不会修改本机已有的 harness 安装。

## 文档站

文档正文维护在 `docs/content/`，共享样式和交互位于 `docs/assets/`。
页面结构、导航、分页、旧锚点映射和搜索索引由 `docs/build.mjs` 统一管理。
修改内容源或构建脚本后运行 `npm run docs:build`，不要直接编辑生成的 HTML 和 `docs/assets/search-index.json`。
提交前运行 `npm run docs:check`，确认生成结果与源文件一致。

本地预览可在仓库根目录运行 `python3 -m http.server 8000`，再访问 `http://127.0.0.1:8000/docs/`。

## 开发与交付

每个开发任务使用独立的 Git worktree 和任务分支，主工作区保持在 `main` 且洁净。
分支采用 `<type>/<task>`，按变更类型使用 `feature`、`fix`、`docs`、`refactor`、`test`、`chore` 等通用前缀；任务描述使用简短的小写 kebab-case。
分支前缀不得使用 Codex、Claude、dsh、Kimi 等客户端名称。

```bash
git worktree add -b feature/add-policy-check ../harness-worktrees/add-policy-check main
```

任务完成且必要验证通过后，自动提交当前任务改动、合并到 `main`，再普通推送 `origin main`，无需逐次确认。
这项授权只覆盖开发交付，不包含强推、远程 PR/MR、部署或发版。
提交和合并仅包含当前任务改动，不混入其他分支尚未交付的变更。
合并成功后用 `git branch -d` 删除已合并的本地任务分支。

## 版本管理与发版授权

版本号只维护在 `package.json` 中。
普通开发不自动更新发版版本号或 `CHANGELOG.md`；修改分发目录也不构成发版授权。
用户未主动要求发版时，不得打 tag、执行真实本地 `publish` 或创建 GitHub Release。
用户主动要求发版后，先评估上次发布以来的变更，主动给出建议版本号及对应的 `v<版本>` tag，说明依据并征求同意。
得到用户对版本的明确同意后，才执行以下发布流程。

已安装的同一版本内容保持不可变，`publish` 和 `install` 会拒绝用不同的分发内容覆盖同版本目录。
开发源码可以暂时与当前已发布版本不同，但不能将其覆盖进该版本的安装目录；完成发版确认后再升版并发布。

## 发布流程

1. 按用户已确认的版本更新 `package.json` 和 `CHANGELOG.md`。
2. 完成必要验证，包括 `npm test` 和 `npm run docs:check`；文档源有变化时先运行 `npm run docs:build`。
3. 提交并合并到 `main`，普通推送发布提交，核对本地与远程 `main` 一致。
4. 在该发布提交上运行 `node bin/harness.mjs publish`，将相同版本的分发内容发布到本机版本目录。
5. 手动触发 `.github/workflows/release.yml`，传入已确认的版本号，创建 tag 和 GitHub Release；随后同步本地 tag 并核对结果。

手动触发示例：`gh workflow run release.yml --ref main -f version=<已确认版本号>`，版本号不含 `v` 前缀。
工作流只允许从 `main` 发布，并校验输入版本与 `package.json` 一致、CHANGELOG 条目非空、测试及文档检查通过。
`scripts/release.mjs ensure` 对身份与正文一致的已有 Release 直接审计通过，不重复创建；有匹配 tag 但缺 Release 时允许补建，tag 指向其他提交、Release 正文不一致或查询失败时停止，不覆盖既有内容。
发布后的 `audit` 只读核对 tag、目标提交、Release 正文及正式发布状态；工作流再从远端 tag 全新克隆，使用隔离版本目录执行 `install --version` 并校验安装内容。

可用下面的命令单独执行只读审计，发布说明文件必须与该版本 CHANGELOG 正文一致：

```bash
node scripts/release.mjs audit --tag v<版本> --commit <发布提交完整SHA> \
  --notes-file <该版本发布说明文件> --repository windvalley/harness
```

普通 merge、push 或 `package.json` 变更不会自动触发发布工作流。
发布后确认 package 版本、CHANGELOG 和本机分发内容一致，tag 与 GitHub Release 指向同一个发布提交。

其他机器执行 `install --local` 时，会按项目锁定的版本从对应标签安装代码。
标签指向的分发内容应与本机同版本安装内容一致，否则不同机器的门禁代码可能不一致。

项目级安装、升级与本机版本目录见[参考手册的安装说明](reference.md#安装)和[升级说明](reference.md#升级)。
