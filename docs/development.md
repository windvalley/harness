# 开发与发布

本文面向 harness 维护者。首次接入和日常使用请从 [README](../README.md) 开始，具体命令与配置见[参考手册](reference.md)。

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

## 版本管理

- 版本号只维护在 `package.json` 中。
- 修改会随版本分发的 `src/`、`assets/`、`bin/` 或 `package.json` 时，需要更新版本号。
- 只修改 README、CHANGELOG 或测试等不分发文件时，无需更新版本号。
- 已安装的同一版本如果分发内容发生变化，`publish` 和 `install` 会拒绝继续；不要用相同版本号覆盖不同的门禁代码。

## 发布流程

1. 分发内容变化时，在 `package.json` 中更新版本号。
2. 更新 `CHANGELOG.md`，记录本次变更。
3. 确认将要打标签的提交与本机安装的同版本分发内容一致。
4. 为该提交创建 `v<版本>` 标签并推送。

其他机器执行 `install --local` 时，会按项目锁定的版本从对应标签安装代码。标签指向的分发内容应与本机同版本安装内容一致，否则不同机器的门禁代码可能不一致。

项目级安装、升级与本机版本目录见[参考手册的安装说明](reference.md#安装)和[升级说明](reference.md#升级)。
