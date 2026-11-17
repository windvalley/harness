# Repository Guidelines

## 项目结构与模块组织

harness 是本地研发流程与交付门禁 CLI，使用 Node.js 原生 ESM，无第三方依赖。

- `bin/harness.mjs` 是命令入口，`src/cli.mjs` 负责命令分发。
- `src/` 按职责划分为 `adapters/`、`policy/`、`verify/`、`review/`、`delivery/` 等模块；通用工具放在 `src/lib/`。
- `assets/` 保存规则、预设、模板和黄金任务数据。
- `test/` 保存单元与集成测试，`test/helpers.mjs` 提供临时仓库夹具。
- `docs/content/` 保存文档站正文，`docs/assets/` 保存共享样式和脚本；维护说明见 `docs/development.md`。

## 构建、测试与本地开发

使用 Node.js 20 及以上、Git 2.38 及以上；CI 使用 Node.js 22。

| 命令 | 用途 |
| --- | --- |
| `node bin/harness.mjs --help` | 查看本地 CLI 用法 |
| `npm test` | 运行全部单元与集成测试 |
| `node --test test/cli-help.test.mjs` | 运行指定测试文件 |
| `npm run docs:build` | 生成文档页面、导航与搜索索引 |
| `npm run docs:check` | 检查文档生成结果是否与源文件一致 |
| `python3 -m http.server 8000` | 在仓库根目录预览，访问 `/docs/` |

源码由 Node.js 直接执行，未配置独立编译、lint 或格式化命令。
提交前运行 `npm test` 和 `npm run docs:check`。

## 编码风格与命名约定

沿用现有 `.mjs` 风格：两空格缩进、双引号、分号，使用 `import` / `export`。
本地导入保留 `.mjs` 扩展名，Node.js 内置模块使用 `node:` 前缀。
变量和函数使用 camelCase，常量使用 UPPER_SNAKE_CASE，多词文件名使用 kebab-case，例如 `commit-message.mjs`。
注释跟随所在文件的语言，测试描述优先沿用现有中文行为描述。
优先复用标准库与现有工具，新增依赖前说明必要性。

## 测试规范

使用内置 `node:test` 和 `node:assert`，测试文件命名为 `test/<feature>.test.mjs`。
修复缺陷前先复现，再补充覆盖实际行为的回归测试。
涉及 Git、钩子或安装的测试复用 `test/helpers.mjs`，隔离数据、密钥和版本目录，并清理夹具。
不要让测试依赖真实凭据或在线模型服务。
doctor 测试需在 PATH 中找到 `claude` 或 `codex`；离线占位方式见 `.github/workflows/node-tests.yml`。
仓库未设置统一覆盖率门槛，应验证成功路径、拒绝路径及相关边界。

## 文档生成与版本管理

修改文档正文或 `docs/build.mjs` 后运行 `npm run docs:build`，并审查生成差异。
禁止手工编辑生成的 `docs/*.html` 和 `docs/assets/search-index.json`。
修改分发目录 `src/`、`assets/`、`bin/` 或 `package.json` 时更新 `package.json` 版本，并在 `CHANGELOG.md` 记录变更。
仅修改文档或测试无需升版。

## 提交与 Pull Request

在任务分支工作，提交前确认暂存区仅包含当前任务改动。
沿用历史中的 `type(scope): 中文摘要` 格式，scope 可省略，例如 `fix(doctor): 修复工作树信任检查` 或 `docs: 补充贡献指南`。
每个提交只包含一个逻辑变更，提交信息不包含工具署名或 `Co-Authored-By`。
PR 描述应说明问题、行为变化及验证结果，关联相关 issue；文档界面变化附截图。
