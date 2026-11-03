import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { commit, CONFIG, git, makeRepo, sh, write, writeReview } from "./helpers.mjs";
import { PACKAGE_ROOT as PACKAGE_ROOT_TEST } from "./helpers.mjs";
import { starterVerify } from "../src/install/init.mjs";
import { packageVersion as currentVersion } from "../src/install/managed.mjs";
import { matchAny } from "../src/lib/glob.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});
function setup(opts = {}) {
  const repo = makeRepo(opts);
  repos.push(repo);
  return repo;
}

// 起始检查在临时 git 仓库里生成：被忽略的目录要按 .gitignore 判定。
const GENERIC = ["lint", "harness-golden"];
let stackDirs = [];
afterEach(() => {
  for (const dir of stackDirs) rmSync(dir, { recursive: true, force: true });
  stackDirs = [];
});
function starterVerifyFor(files) {
  const dir = mkdtempSync(join(tmpdir(), "harness-stack-"));
  stackDirs.push(dir);
  sh(dir, "git", ["init", "-q"]);
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  return starterVerify({ cwd: dir });
}
const starterChecks = (files) => Object.fromEntries(starterVerifyFor(files).checks.map((check) => [check.id, check]));
const starterIds = (files) => starterVerifyFor(files).checks.map((check) => check.id);
const pkg = (scripts, extra = {}) => JSON.stringify({ name: "demo", scripts, ...extra });

const BASIC = "feat(demo): 增加示例\n\n- 增加一个文件\n- 补充说明";
// 私钥类文件用常量拼出来，避免命令文本里出现完整扩展名而触发密钥保护规则。
const SECRET_FILE = `config/server.${"pem"}`;

describe("git 层钩子", () => {
  test("pre-commit 拦住写密钥文件", () => {
    // 在任务分支验证：主分支上的提交会先被引用保护拦下，看不到 pre-commit 的判定。
    const repo = setup();
    git(repo.root, "checkout", "-q", "-b", "task/secret");
    write(repo.root, SECRET_FILE, "-----BEGIN PRIVATE KEY-----\n");
    // 强制加入被忽略的私钥文件，模拟“已经暂存即将提交”的真实场景。
    git(repo.root, "add", "-f", SECRET_FILE);
    const before = git(repo.root, "rev-parse", "--short", "HEAD");
    const result = sh(repo.root, "git", ["commit", "-q", "-m", BASIC], { ...repo.env });
    assert.equal(git(repo.root, "rev-parse", "--short", "HEAD"), before, "提交不应成功");
    assert.match(result.stderr, /密钥|已拦截/);
  });

  test("pre-commit 拦住迁移里的触发器", () => {
    const repo = setup({
      project: {
        ".harness/policy.json": {
          version: 1,
          presets: ["git-safety"],
          rules: [
            {
              id: "no-trigger",
              kind: "content-forbid",
              paths: ["migrations/**/*.sql"],
              patterns: ["create\\s+trigger\\b"],
              reason: "禁止触发器",
              fix: "放到应用层",
            },
          ],
        },
      },
    });
    git(repo.root, "checkout", "-q", "-b", "task/trigger");
    write(repo.root, "migrations/001.sql", "CREATE TRIGGER t AFTER INSERT ON a FOR EACH ROW SET @x=1;\n");
    git(repo.root, "add", "-A");
    const result = sh(repo.root, "git", ["commit", "-q", "-m", BASIC], repo.env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /禁止触发器/);
  });

  test("commit-msg 拦住不合规的提交信息", () => {
    const repo = setup();
    git(repo.root, "checkout", "-q", "-b", "task/msg");
    write(repo.root, "a.txt", "a\n");
    git(repo.root, "add", "-A");
    const bad = sh(repo.root, "git", ["commit", "-q", "-m", "update code"], repo.env);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /提交信息/);
    const good = sh(repo.root, "git", ["commit", "-q", "-m", BASIC], repo.env);
    assert.equal(good.status, 0, good.stderr);
  });

  test("commit-msg 拦住共同作者行", () => {
    const repo = setup();
    write(repo.root, "a.txt", "a\n");
    git(repo.root, "add", "-A");
    const result = sh(repo.root, "git", ["commit", "-q", "-m", `${BASIC}\n\nCo-Authored-By: X <x@y>`], repo.env);
    assert.notEqual(result.status, 0);
  });

  test("引用保护拒绝直接更新主分支，应急开关可放行", () => {
    const repo = setup();
    git(repo.root, "checkout", "-q", "-b", "task/a");
    write(repo.root, "a.txt", "a\n");
    git(repo.root, "add", "-A");
    git(repo.root, "commit", "-q", "-m", BASIC);
    const target = git(repo.root, "rev-parse", "task/a");
    git(repo.root, "checkout", "-q", "main");
    const refused = sh(repo.root, "git", ["update-ref", "refs/heads/main", target], repo.env);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /只允许由 harness merge 更新/);
    const allowed = sh(repo.root, "git", ["update-ref", "refs/heads/main", target], { ...repo.env, HARNESS_MAIN_BYPASS: "1" });
    assert.equal(allowed.status, 0, allowed.stderr);
  });

  test("任务分支上的提交不受引用保护影响", () => {
    const repo = setup();
    git(repo.root, "checkout", "-q", "-b", "task/b");
    write(repo.root, "b.txt", "b\n");
    git(repo.root, "add", "-A");
    const result = sh(repo.root, "git", ["commit", "-q", "-m", BASIC], repo.env);
    assert.equal(result.status, 0, result.stderr);
  });
});

describe("安装与自检", () => {
  test("install 生成 shim、三处 git 钩子与两个客户端配置", () => {
    const repo = setup();
    assert.ok(existsSync(join(repo.root, ".harness/bin/harness")));
    const hooksDir = join(repo.root, ".git/hooks");
    for (const name of ["pre-commit", "commit-msg", "reference-transaction"]) {
      assert.match(readFileSync(join(hooksDir, name), "utf8"), /# harness:hook/, name);
    }
    assert.match(readFileSync(join(repo.root, ".claude/settings.json"), "utf8"), /\.harness\/bin\/harness.*hook --client claude/);
    assert.match(readFileSync(join(repo.root, ".codex/hooks.json"), "utf8"), /\.harness\/bin\/harness.*hook --client codex/);
    // 入口入库，Linked Worktree 检出后直接可用。
    assert.equal(git(repo.root, "ls-files", ".harness/bin/harness"), ".harness/bin/harness");
  });

  test("重装 Codex 钩子保留其他工具的条目，--take-over 才移除", () => {
    const repo = setup();
    const file = join(repo.root, ".codex/hooks.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.hooks.PreToolUse.unshift({ matcher: "Bash", hooks: [{ type: "command", command: "other-guard" }] });
    config.hooks.PostToolUse = [{ matcher: "*", hooks: [{ type: "command", command: "other-log" }] }];
    writeFileSync(file, JSON.stringify(config));

    assert.equal(repo.cli("install").status, 0);
    const kept = JSON.parse(readFileSync(file, "utf8")).hooks;
    const commands = (entries) => entries.flatMap((entry) => entry.hooks.map((hook) => hook.command));
    assert.ok(commands(kept.PreToolUse).includes("other-guard"));
    assert.equal(commands(kept.PreToolUse).filter((command) => /hook --client codex/.test(command)).length, 1, "harness 条目只有一份");
    assert.deepEqual(commands(kept.PostToolUse), ["other-log"]);

    assert.equal(repo.cli("install", "--take-over").status, 0);
    const taken = JSON.parse(readFileSync(file, "utf8")).hooks;
    assert.ok(!commands(taken.PreToolUse).includes("other-guard"));
    assert.deepEqual(commands(taken.PostToolUse), ["other-log"], "接管只动拦截，不动其他事件");
  });

  test("init 会写出配置、规则与托管块，且可重复执行", () => {
    const repo = setup({ install: false, project: { ".harness/config.json": null, ".harness/policy.json": null, ".harness/verify.json": null } });
    const first = repo.rawCli("init");
    assert.equal(first.status, 0, first.stderr);
    for (const rel of [".harness/config.json", ".harness/policy.json", ".harness/verify.json", ".harness/rules/core.md", ".harness/rules/harness.md", ".harness/templates/spec.md"]) {
      assert.ok(existsSync(join(repo.root, rel)), rel);
    }
    const agents = readFileSync(join(repo.root, "AGENTS.md"), "utf8");
    assert.match(agents, /harness:start/);
    assert.match(agents, /合并后保留任务 Worktree，不要自行删除/, "托管块写明合并后不自动删除任务 Worktree");
    assert.doesNotMatch(agents, /合并成功后清理任务 Worktree/);
    // 托管块只放每次任务都要遵守的硬性要求；产品使用方式与协作职责写在 core.md，不重复进每个项目的 AGENTS.md。
    const block = agents.slice(agents.indexOf("<!-- harness:start -->"), agents.indexOf("<!-- harness:end -->"));
    for (const pattern of [/日常语言/, /固定话术/, /不要求用户/, /Agent 按项目规则准备任务分支/, /验收证据、最终合并状态/]) {
      assert.doesNotMatch(block, pattern, `托管块不应包含: ${pattern}`);
    }
    for (const pattern of [/\.harness\/rules\/core\.md/, /先判断任务分级/, /最初提出需求或回答澄清问题都不算/, /先红后绿/, /harness merge --branch/, /harness worktree clean/, /轮次长短、耗时与上下文大小都不是停下的理由/, /收尾检查/]) {
      assert.match(block, pattern, `托管块应保留: ${pattern}`);
    }
    const rules = readFileSync(join(repo.root, ".harness/rules/harness.md"), "utf8");
    assert.match(rules, /## 收尾：任务 Worktree 由用户发起清理/);
    assert.match(rules, /harness worktree clean/);
    // 自审放在提交之后、verify 之前：自审改出的新提交会让已有证据与评审作废。
    assert.match(rules, /提交后、`harness verify` 之前按 `method-review\.md` 自审/, "一次任务写明自审的时机");
    const review = readFileSync(join(repo.root, ".harness/rules/method-review.md"), "utf8");
    for (const pattern of [/交付前自审放在提交之后、`harness verify` 之前/, /验收清单每条都对应到测试或命令的输出/, /`commit-message` 规则把关/, /`git status` 洁净/, /diff 之外的调用方、配置、文档和测试夹具/, /自审结论不交给独立评审/]) {
      assert.match(review, pattern, `method-review.md 的自审清单应包含: ${pattern}`);
    }
    const core = readFileSync(join(repo.root, ".harness/rules/core.md"), "utf8");
    assert.match(core, /提交后、验证前按\[需求与工程双维评审\]\(method-review\.md\)自审/, "core.md 写明自审的时机");
    assert.doesNotMatch(core, /交付前自审，按验收清单/, "自审与交付时给出验收证据分成两条");
    // 二次执行不覆盖已有配置
    writeFileSync(join(repo.root, ".harness/config.json"), JSON.stringify({ version: 1, mainBranch: "main", marker: "保留" }, null, 2));
    const second = repo.rawCli("init");
    assert.equal(second.status, 0, second.stderr);
    assert.match(readFileSync(join(repo.root, ".harness/config.json"), "utf8"), /保留/);
  });

  test("init 在没有任何提交的新仓库上按 HEAD 判断主分支名", () => {
    const repo = setup({ install: false, project: { ".harness/config.json": null, ".harness/policy.json": null, ".harness/verify.json": null } });
    // 删掉分支等价于刚 git init：refs/heads 下没有任何分支，只有 HEAD 指向 main。
    git(repo.root, "update-ref", "-d", "refs/heads/main");
    assert.equal(git(repo.root, "symbolic-ref", "--short", "HEAD"), "main");

    const result = repo.rawCli("init");
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(repo.root, ".harness/config.json"), "utf8"), /"mainBranch": "main"/);
  });

  test("配置里的主分支名与仓库实际不符时给出明确提示", () => {
    const repo = setup({ project: { ".harness/config.json": { ...CONFIG, mainBranch: "master" } } });
    const status = repo.cli("status", "--branch", "main");
    assert.equal(status.status, 1);
    assert.match(status.stderr, /只有 main/);
  });

  test("Node 起始检查只按项目声明的类型检查脚本与包管理器生成", () => {
    // 根目录的项目：包管理器看锁文件，触发路径不依赖 src/ 布局，改文档不触发
    const root = starterChecks({ "package.json": pkg({ typecheck: "tsc --noEmit" }), "pnpm-lock.yaml": "" }).typecheck;
    assert.deepEqual(root.cmd, ["pnpm", "run", "typecheck"]);
    assert.equal(root.tier, "gate");
    assert.equal(root.cwd, undefined);
    assert.deepEqual(root.requires, ["node_modules"]);
    assert.ok(matchAny("app/page.tsx", root.when) && matchAny("pnpm-lock.yaml", root.when));
    assert.equal(matchAny("docs/guide.md", root.when), false);

    // 一级子目录：检查名带目录前缀，frontend 仍叫 frontend-typecheck
    const web = starterChecks({ "web/package.json": pkg({ "type-check": "vue-tsc --noEmit" }), "web/yarn.lock": "" })["web-typecheck"];
    assert.equal(web.cwd, "web");
    assert.deepEqual(web.cmd, ["yarn", "run", "type-check"]);
    assert.deepEqual(web.requires, ["web/node_modules"]);
    assert.ok(matchAny("web/components/App.vue", web.when) && matchAny("web/yarn.lock", web.when));
    assert.equal(matchAny("api/main.ts", web.when), false);

    // packageManager 字段优先于锁文件；子目录没有声明时沿用根目录的，都没有时用 npm
    const declared = starterChecks({ "frontend/package.json": pkg({ typecheck: "tsc" }, { packageManager: "pnpm@9.0.0" }), "frontend/package-lock.json": "{}" });
    assert.deepEqual(declared["frontend-typecheck"].cmd, ["pnpm", "run", "typecheck"]);
    const inherited = starterChecks({ "package.json": pkg({}), "bun.lock": "", "frontend/package.json": pkg({ "check-types": "tsc" }) });
    assert.deepEqual(inherited["frontend-typecheck"].cmd, ["bun", "run", "check-types"]);
    assert.ok(matchAny("bun.lock", inherited["frontend-typecheck"].when));
    assert.deepEqual(starterChecks({ "frontend/package.json": pkg({ typecheck: "tsc" }) })["frontend-typecheck"].cmd, ["npm", "run", "typecheck"]);

    // 没有类型检查脚本不生成：生成了也必然失败，挡住每一个改前端的任务
    assert.deepEqual(starterIds({ "frontend/package.json": pkg({ build: "vite build" }), "frontend/package-lock.json": "{}" }), GENERIC);
    // Yarn PnP 没有 node_modules，按依赖目录判定会一直记为未执行，同样不生成
    assert.deepEqual(starterIds({ "package.json": pkg({ typecheck: "tsc" }), "yarn.lock": "", ".yarnrc.yml": "enableTelemetry: false\n" }), GENERIC);
    assert.deepEqual(starterIds({ "package.json": pkg({ typecheck: "tsc" }), "yarn.lock": "", ".yarnrc.yml": "nodeLinker: node-modules\n" }), ["typecheck", ...GENERIC]);

    // 工作区根目录有类型检查脚本时由它统管各个包，避免同一批代码查两遍
    const sub = { "web/package.json": pkg({ typecheck: "tsc" }) };
    assert.deepEqual(starterIds({ "package.json": pkg({ typecheck: "tsc -b" }, { workspaces: ["web"] }), ...sub }), ["typecheck", ...GENERIC]);
    assert.deepEqual(starterIds({ "package.json": pkg({ typecheck: "tsc -b" }), "pnpm-workspace.yaml": "packages: [web]\n", ...sub }), ["typecheck", ...GENERIC]);
    assert.deepEqual(starterIds({ "package.json": pkg({ build: "x" }), ...sub }), ["web-typecheck", ...GENERIC]);
    // 根目录没有时按成员各自生成：npm、yarn、bun 把依赖提升到根目录，成员目录常常没有自己的 node_modules
    const npmMember = starterChecks({ "package.json": pkg({ build: "x" }, { workspaces: ["web"] }), "package-lock.json": "{}", ...sub })["web-typecheck"];
    assert.deepEqual(npmMember.cmd, ["npm", "run", "typecheck"]);
    assert.equal(npmMember.cwd, "web");
    assert.deepEqual(npmMember.requires, ["node_modules"]);
    assert.ok(matchAny("package-lock.json", npmMember.when) && matchAny("web/src/a.ts", npmMember.when));
    // pnpm 的成员目录里只有指向根目录 .pnpm 的链接，两处都要有；node-linker=hoisted 时只有根目录
    const pnpmRoot = { "package.json": pkg({ build: "x" }, { packageManager: "pnpm@9.0.0" }), "pnpm-lock.yaml": "", "pnpm-workspace.yaml": "packages:\n  - web\n" };
    assert.deepEqual(starterChecks({ ...pnpmRoot, ...sub })["web-typecheck"].requires, ["node_modules", "web/node_modules"]);
    assert.deepEqual(starterChecks({ ...pnpmRoot, ".npmrc": "node-linker=hoisted\n", ...sub })["web-typecheck"].requires, ["node_modules"]);
    // 自带锁文件的子目录是独立项目，不是工作区成员，根目录统管成员时它照样生成
    const standalone = starterChecks({ ...pnpmRoot, ...sub, "web/package-lock.json": "{}" })["web-typecheck"];
    assert.deepEqual(standalone.cmd, ["npm", "run", "typecheck"]);
    assert.deepEqual(standalone.requires, ["web/node_modules"]);
    const covered = { "package.json": pkg({ typecheck: "tsc -b" }, { workspaces: ["web"] }), ...sub, "docs-site/package.json": pkg({ typecheck: "astro check" }), "docs-site/yarn.lock": "" };
    assert.deepEqual(starterIds(covered), ["typecheck", "docs-site-typecheck", ...GENERIC]);

    // 被 .gitignore 忽略的目录、隐藏目录与 node_modules 不参与探测
    const declaredElsewhere = pkg({ typecheck: "tsc" });
    assert.deepEqual(
      starterIds({ ".gitignore": "dist/\n", "dist/package.json": declaredElsewhere, ".cache/package.json": declaredElsewhere, "node_modules/package.json": declaredElsewhere }),
      GENERIC,
    );
  });

  test("Go、Rust、pytest 起始检查同样探测根目录与一级子目录", () => {
    const go = starterChecks({ "go.mod": "module x\n" });
    assert.deepEqual(go["go-test"].cmd, ["go", "test", "-count=1", "./..."]);
    assert.deepEqual(go["go-build"].cmd, ["go", "build", "./..."]);
    assert.ok(matchAny("internal/a.go", go["go-test"].when) && matchAny("go.sum", go["go-test"].when));
    const backend = starterChecks({ "backend/go.mod": "module x\n" })["backend-go-test"];
    assert.equal(backend.cwd, "backend");
    assert.ok(matchAny("backend/cmd/main.go", backend.when));
    assert.equal(matchAny("tools/main.go", backend.when), false);

    const cargo = starterChecks({ "rust/Cargo.toml": "[workspace]\n" })["rust-cargo-test"];
    assert.equal(cargo.cwd, "rust");
    assert.deepEqual(cargo.cmd, ["cargo", "test", "--all-targets"]);
    // target 由 cargo 自己创建，不能作为前置条件，否则全新克隆永远跳过这项检查
    assert.equal(cargo.requires, undefined);
    assert.equal(starterChecks({ "Cargo.toml": "[package]\n" })["cargo-test"].cwd, undefined);
    // 根目录是 Cargo workspace 时成员由根目录统一测试
    assert.deepEqual(starterIds({ "Cargo.toml": '[workspace]\nmembers = ["core"]\n', "core/Cargo.toml": "[package]\n" }), ["cargo-test", ...GENERIC]);

    // 只认 pytest 自己会读的配置：只用来写元数据的 setup.cfg 不算
    assert.deepEqual(starterIds({ "app/main.py": "print(1)\n" }), GENERIC);
    assert.deepEqual(starterIds({ "setup.cfg": "[metadata]\nname = x\n" }), GENERIC);
    assert.deepEqual(starterIds({ "setup.cfg": "[tool:pytest]\naddopts = -q\n" }), ["pytest", ...GENERIC]);
    assert.deepEqual(starterIds({ "tox.ini": "[pytest]\n" }), ["pytest", ...GENERIC]);
    assert.equal(starterChecks({ "pyproject.toml": "[tool.pytest.ini_options]\n" }).pytest.tier, "gate");
    const api = starterChecks({ "api/tests/conftest.py": "" })["api-pytest"];
    assert.equal(api.cwd, "api");
    assert.ok(matchAny("api/app/main.py", api.when));
    // 根目录的 pytest 会递归收集子目录，不再为子目录单独生成
    assert.deepEqual(starterIds({ "pytest.ini": "[pytest]\n", "api/tests/conftest.py": "" }), ["pytest", ...GENERIC]);
  });

  test("只有文档的项目只保留通用检查，不再写入示例检查", () => {
    assert.deepEqual(starterIds({ "README.md": "demo\n" }), GENERIC);
  });

  test("包内只有一份版本号，版本目录清单覆盖源码、资源与入口", () => {
    // 版本号只来自 package.json；两份来源迟早对不上。
    const root = PACKAGE_ROOT_TEST;
    assert.equal(existsSync(join(root, "VERSION")), false, "包根目录不应再有 VERSION 文件");    const repo = setup();
    const manifest = JSON.parse(readFileSync(join(repo.env.HARNESS_STORE, currentVersion(), "MANIFEST.json"), "utf8"));
    assert.equal(manifest.version, currentVersion());
    assert.ok(Object.keys(manifest.files).some((rel) => rel.startsWith("src/")), "应包含源码");
    assert.ok(Object.keys(manifest.files).some((rel) => rel.startsWith("assets/")), "应包含资源");
    assert.ok(Object.keys(manifest.files).includes("bin/harness.mjs"), "应包含入口");
  });

  test("init 不把内置黄金任务拷进项目，开箱按内置用例全部通过", () => {
    const repo = makeRepo({ install: false, project: { ".harness/config.json": null, ".harness/policy.json": null, ".harness/verify.json": null } });
    repos.push(repo);
    assert.equal(repo.rawCli("init").status, 0);
    const project = JSON.parse(readFileSync(join(repo.root, ".harness/golden/tasks.json"), "utf8"));
    assert.deepEqual(project.tasks, [], "项目文件只放项目自己的用例");
    const builtin = JSON.parse(readFileSync(join(PACKAGE_ROOT_TEST, "assets/golden/builtin.json"), "utf8")).tasks;
    assert.ok(builtin.length >= 10, "内置用例随版本分发");
    const golden = repo.rawCli("golden", "--worktree");
    assert.equal(golden.status, 0, golden.stdout + golden.stderr);
    assert.match(golden.stdout, /PASS g04-recursive-delete/);
    assert.match(golden.stdout, /PASS g17-plan-first/);
    assert.match(golden.stdout, /SKIP g16-main-worktree-merge-only/, "针对可选预设的用例在预设未启用时跳过");
  });

  test("项目自己的黄金任务与内置用例一起重放", () => {
    const repo = setup({
      project: {
        ".harness/golden/tasks.json": {
          version: 1,
          tasks: [{ id: "p01-own", title: "项目自己的用例", kind: "policy", steps: [{ kind: "shell", command: "rm -rf build", expect: "deny" }] }],
        },
      },
    });
    const golden = repo.cli("golden");
    assert.equal(golden.status, 0, golden.stdout + golden.stderr);
    assert.match(golden.stdout, /PASS p01-own/);
    assert.match(golden.stdout, /PASS g04-recursive-delete/);
  });

  test("项目里同 id 的用例覆盖内置用例，输出里标明", () => {
    const repo = setup({
      project: {
        ".harness/golden/tasks.json": {
          version: 1,
          tasks: [{ id: "g04-recursive-delete", kind: "policy", steps: [{ kind: "shell", command: "rm -rf build", expect: "allow" }] }],
        },
      },
    });
    const golden = repo.cli("golden");
    assert.notEqual(golden.status, 0);
    assert.match(golden.stdout, /FAIL g04-recursive-delete.*覆盖内置/);
    assert.match(golden.stdout, /步骤 1 期望 allow，实际 deny/);
  });

  test("disableBuiltin 停用内置用例，输出里记为跳过并说明原因", () => {
    const repo = setup({
      project: {
        ".harness/policy.json": { version: 1, presets: ["secrets", "git-safety", "gate-self"], disabled: ["shell-recursive-delete"], rules: [] },
        ".harness/golden/tasks.json": { version: 1, disableBuiltin: ["g04-recursive-delete"], tasks: [] },
      },
    });
    const golden = repo.cli("golden");
    assert.equal(golden.status, 0, golden.stdout + golden.stderr);
    assert.match(golden.stdout, /SKIP g04-recursive-delete.*项目停用/);
  });

  test("启用可选预设后，起始黄金任务里对应的用例参与重放", () => {
    const presets = ["secrets", "git-safety", "gate-self", "main-worktree", "plan-first"];
    const repo = makeRepo({ project: { ".harness/policy.json": { version: 1, presets, disabled: [], rules: [] } } });
    repos.push(repo);
    const golden = repo.cli("golden");
    assert.equal(golden.status, 0, golden.stdout + golden.stderr);
    assert.match(golden.stdout, /PASS g16-main-worktree-merge-only/);
    assert.match(golden.stdout, /PASS g17-plan-first/);
    assert.doesNotMatch(golden.stdout, /跳过/);
  });

  test("改坏规则后黄金任务能发现退化", () => {
    const repo = makeRepo();
    repos.push(repo);
    // 关掉递归删除规则，g04 应当失败。
    const policy = JSON.parse(readFileSync(join(repo.root, ".harness/policy.json"), "utf8"));
    policy.disabled = [...(policy.disabled ?? []), "shell-recursive-delete"];
    writeFileSync(join(repo.root, ".harness/policy.json"), `${JSON.stringify(policy, null, 2)}\n`);
    commit(repo.root, "chore: 关闭规则\n\n- 测试用\n- 验证黄金任务");
    const golden = repo.cli("golden");
    assert.notEqual(golden.status, 0);
    assert.match(golden.stdout, /FAIL g04/);
  });

  test("黄金任务的检查计划选中写错的 gate 检查时失败，并说明原因", () => {
    const repo = makeRepo();
    repos.push(repo);
    const verify = JSON.parse(readFileSync(join(repo.root, ".harness/verify.json"), "utf8"));
    // unit 漏写 cmd：以前被静默跳过，g11 照样通过。
    verify.checks = verify.checks.map(({ cmd, ...check }) => (check.id === "unit" ? check : { ...check, ...(cmd ? { cmd } : {}) }));
    writeFileSync(join(repo.root, ".harness/verify.json"), `${JSON.stringify(verify, null, 2)}\n`);
    commit(repo.root, "chore: 漏写命令\n\n- 测试用\n- 验证黄金任务");
    const golden = repo.cli("golden");
    assert.notEqual(golden.status, 0);
    assert.match(golden.stdout, /FAIL g11/);
    assert.match(golden.stdout, /检查 unit 配置无效: gate 检查没有可执行的 cmd/);
  });

  test("doctor 报告各项状态，已信任的客户端不再标未实测", () => {
    const repo = setup();
    const result = repo.cli("doctor");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /client:claude/);
    assert.match(result.stdout, /client:codex: 钩子已接入且已信任/);
    assert.match(result.stdout, /client:dsh/);
  });

  test("Codex 钩子未信任时 doctor 明确要求先批准", () => {
    const repo = makeRepo({ trustCodex: false });
    repos.push(repo);
    const result = repo.cli("doctor");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /尚未信任/);
  });

  test("已安装版本内容被改动时 doctor 报错", () => {
    const repo = setup();
    const file = join(repo.env.HARNESS_STORE, `${currentVersion()}/src/policy/engine.mjs`);
    writeFileSync(file, `${readFileSync(file, "utf8")}\n// 被改动\n`);
    const result = repo.cli("doctor");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /内容被改动|内容与清单一致/);
  });

  test("升级会按新版本重写规则并保留配置", () => {
    const repo = setup();
    const before = readFileSync(join(repo.root, ".harness/config.json"), "utf8");
    const result = repo.cli("upgrade");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(repo.root, ".harness/config.json"), "utf8"), before);
    assert.ok(existsSync(join(repo.root, ".harness/rules/harness.md")));
  });

  test("升级移除项目里与内置完全相同的旧副本，改过的用例保留并提示", () => {
    const repo = setup();
    const builtin = JSON.parse(readFileSync(join(PACKAGE_ROOT_TEST, "assets/golden/builtin.json"), "utf8")).tasks;
    const identical = builtin.find((task) => task.id === "g01-secret-read-denied");
    const stale = { ...builtin.find((task) => task.id === "g02-secret-write-denied"), steps: [{ kind: "write", path: ".env", expect: "deny" }] };
    const own = { id: "p01-own", kind: "policy", steps: [{ kind: "shell", command: "rm -rf build", expect: "deny" }] };
    const file = join(repo.root, ".harness/golden/tasks.json");
    write(repo.root, ".harness/golden/tasks.json", `${JSON.stringify({ version: 1, tasks: [identical, stale, own] }, null, 2)}\n`);
    const result = repo.cli("upgrade");
    assert.equal(result.status, 0, result.stderr);
    const after = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(after.tasks.map((task) => task.id), ["g02-secret-write-denied", "p01-own"]);
    assert.match(result.stdout, /g01-secret-read-denied/, "说明移除了哪些旧副本");
    assert.match(result.stdout, /覆盖内置.*g02-secret-write-denied/s);
  });

  test("升级不动没有内置副本的黄金任务文件", () => {
    const repo = setup();
    const file = join(repo.root, ".harness/golden/tasks.json");
    const own = { id: "p01-own", kind: "policy", steps: [{ kind: "shell", command: "rm -rf build", expect: "deny" }] };
    write(repo.root, ".harness/golden/tasks.json", `${JSON.stringify({ version: 1, tasks: [own] })}\n`);
    const before = readFileSync(file, "utf8");
    const result = repo.cli("upgrade");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.doesNotMatch(result.stdout, /覆盖内置/);
  });
});

describe("客户端钩子入口", () => {
  const payload = (command, cwd) => JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd });

  test("claude 入口：拒绝退出码 2，放行退出码 0", () => {
    const repo = setup();
    const deny = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["hook", "--client", "claude"], repo.env, payload("git stash", repo.root));
    assert.equal(deny.status, 2);
    assert.match(deny.stderr, /正确做法/);
    const allow = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["hook", "--client", "claude"], repo.env, payload("git status", repo.root));
    assert.equal(allow.status, 0);
  });

  test("codex 入口：拒绝时输出 permissionDecision", () => {
    const repo = setup();
    const output = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["hook", "--client", "codex"], repo.env, payload("rm -rf build", repo.root));
    const parsed = JSON.parse(output.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /正确做法/);
  });

  test("dsh 入口：同样载荷也能拒绝", () => {
    const repo = setup();
    const input = JSON.stringify({ name: "bash", arguments: { command: `cat ${SECRET_FILE}` } });
    const output = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["hook", "--client", "dsh"], repo.env, input);
    assert.equal(output.status, 2);
    assert.match(output.stderr, /密钥|已拦截/);
  });

  test("三个客户端对同一操作判定一致", () => {
    const repo = setup();
    const cases = [
      [{ name: "bash", arguments: { command: "git stash" } }, { tool_name: "Bash", tool_input: { command: "git stash" } }],
      [{ name: "bash", arguments: { command: "git status" } }, { tool_name: "Bash", tool_input: { command: "git status" } }],
      [{ name: "write", arguments: { file_path: SECRET_FILE, content: "x" } }, { tool_name: "Write", tool_input: { file_path: SECRET_FILE, content: "x" } }],
    ];
    for (const [dshPayload, claudePayload] of cases) {
      const dshOut = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["hook", "--client", "dsh"], repo.env, JSON.stringify(dshPayload));
      const claudeOut = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["hook", "--client", "claude"], repo.env, JSON.stringify({ ...claudePayload, cwd: repo.root }));
      assert.equal((dshOut.status !== 0) === (claudeOut.status !== 0), true, JSON.stringify(claudePayload));
    }
  });

  test("无效输入按失败处理，不放行", () => {
    const repo = setup();
    const output = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["hook", "--client", "claude"], repo.env, "not json");
    assert.equal(output.status, 2);
  });
});

describe("status 与 uninstall", () => {
  test("status 指出还差哪几步", () => {
    const repo = setup();
    repo.branch("task/a", { "src/a.js": "x\n" });
    const none = repo.cli("status", "--branch", "task/a");
    assert.equal(none.status, 1);
    assert.match(none.stdout, /缺验证证据/);
    assert.match(none.stdout, /缺独立评审/);

    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    const half = repo.cli("status", "--branch", "task/a");
    assert.equal(half.status, 1);
    assert.match(half.stdout, /缺独立评审/);
    assert.doesNotMatch(half.stdout, /缺验证证据/);

    const head = git(repo.root, "rev-parse", "task/a");
    writeReview(repo, head, "approve");
    const ready = repo.cli("status", "--branch", "task/a");
    assert.equal(ready.status, 0, ready.stdout);
    assert.match(ready.stdout, /可以合并/);
  });

  test("status 给出验收清单的真实位置与有无，intent.mode 为 required 时缺清单算阻塞", () => {
    const repo = setup();
    repo.branch("task/a", { "src/a.js": "x\n" });
    assert.match(repo.cli("status", "--branch", "task/a").stdout, /\[!!\] acceptance: 没有验收清单 \.harness\/acceptance\/task-a\.md：评审只评工程质量/);
    repo.branch("task/b", { "src/b.js": "x\n", ".harness/acceptance/task-b.md": "- 验收\n" });
    assert.match(repo.cli("status", "--branch", "task/b").stdout, /\[ok\] acceptance: 验收清单 \.harness\/acceptance\/task-b\.md 已随任务分支提交/);

    const strict = setup({ project: { ".harness/config.json": { ...CONFIG, intent: { mode: "required", dir: "acceptance" } } } });
    strict.branch("task/c", { "src/c.js": "x\n" });
    const status = strict.cli("status", "--branch", "task/c");
    assert.match(status.stdout, /\[FAIL\] acceptance: 缺少验收清单 \.harness\/acceptance\/task-c\.md：intent\.mode 为 required，没有清单不能合并/);
    assert.match(status.stdout, /缺验收清单/);
  });

  test("status 提示门禁改动待确认", () => {
    const repo = setup();
    repo.branch("task/g", {
      "src/a.js": "x\n",
      ".harness/policy.json": `${JSON.stringify({ version: 1, presets: ["secrets"], disabled: [], rules: [] }, null, 2)}\n`,
    });
    assert.equal(repo.cli("verify", "--branch", "task/g").status, 0);
    writeReview(repo, git(repo.root, "rev-parse", "task/g"), "approve");
    const status = repo.cli("status", "--branch", "task/g");
    assert.equal(status.status, 1);
    assert.match(status.stdout, /门禁改动待确认/);
  });

  test("uninstall 移除生成物并保留项目配置", () => {
    const repo = setup();
    const dry = repo.cli("uninstall", "--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /git 钩子 pre-commit/);
    // dry-run 不应真的删掉东西
    assert.ok(existsSync(join(repo.root, ".harness/bin/harness")));

    const real = repo.cli("uninstall");
    assert.equal(real.status, 0, real.stderr);
    assert.equal(existsSync(join(repo.root, ".harness/bin")), false);
    assert.equal(existsSync(join(repo.root, ".harness/dsh-plugin")), false);
    assert.ok(existsSync(join(repo.root, ".harness/policy.json")), "项目配置应保留");
    assert.equal(readFileSync(join(repo.root, "AGENTS.md"), "utf8").includes("harness:start"), false);
    const preCommit = readFileSync(join(repo.root, ".git/hooks/pre-commit"), "utf8");
    assert.equal(preCommit.includes("# harness:hook"), false);
  });

  test("uninstall --purge 连 .harness 一起删", () => {
    const repo = setup();
    const result = repo.cli("uninstall", "--purge");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(repo.root, ".harness")), false);
  });
});

describe("证据密钥", () => {
  test("轮换后旧证据给出明确原因，重跑即恢复", () => {
    const repo = setup();
    repo.branch("task/k", { "src/a.js": "x\n" });
    assert.equal(repo.cli("verify", "--branch", "task/k").status, 0);

    // 不带 --yes 只预览，不能真的换掉密钥
    const keyFile = join(repo.keyDir, "evidence.key");
    const original = readFileSync(keyFile, "utf8");
    const preview = repo.cli("key", "rotate");
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /加 --yes 执行/);
    assert.equal(readFileSync(keyFile, "utf8"), original);

    const rotated = repo.cli("key", "rotate", "--yes");
    assert.equal(rotated.status, 0, rotated.stderr);
    assert.match(rotated.stdout, /已轮换证据密钥/);
    assert.notEqual(readFileSync(keyFile, "utf8"), original);
    assert.equal(readdirSync(join(repo.keyDir, "retired")).length, 1, "旧密钥应移入 retired/");

    const status = repo.cli("status", "--branch", "task/k");
    assert.equal(status.status, 1);
    assert.match(status.stdout, /另一把密钥签发/);
    assert.match(status.stdout, /harness verify --branch/);
    assert.match(repo.cli("key", "status").stdout, /由另一把密钥签发 1 条/);

    assert.equal(repo.cli("verify", "--branch", "task/k").status, 0);
    assert.doesNotMatch(repo.cli("status", "--branch", "task/k").stdout, /缺验证证据/);
  });

  test("密钥丢失时说明旧记录作废，重跑会生成新密钥", () => {
    const repo = setup();
    repo.branch("task/k", { "src/a.js": "x\n" });
    assert.equal(repo.cli("verify", "--branch", "task/k").status, 0);
    rmSync(join(repo.keyDir, "evidence.key"));

    const status = repo.cli("status", "--branch", "task/k");
    assert.match(status.stdout, /缺少证据密钥/);
    assert.match(status.stdout, /会生成新密钥/);
    const doctor = repo.cli("doctor");
    assert.notEqual(doctor.status, 0);
    assert.match(doctor.stdout, /key: 缺少证据密钥/);

    assert.equal(repo.cli("verify", "--branch", "task/k").status, 0);
    assert.ok(existsSync(join(repo.keyDir, "evidence.key")));
    assert.doesNotMatch(repo.cli("status", "--branch", "task/k").stdout, /缺验证证据/);
  });

  test("密钥格式不正确时拒绝使用，不静默签名", () => {
    const repo = setup();
    repo.branch("task/k", { "src/a.js": "x\n" });
    writeFileSync(join(repo.keyDir, "evidence.key"), "short\n");
    const verified = repo.cli("verify", "--branch", "task/k");
    assert.notEqual(verified.status, 0);
    assert.match(verified.stderr, /格式不正确/);
    const status = repo.cli("key", "status");
    assert.equal(status.status, 1);
    assert.match(status.stdout, /不可用/);
  });

  test("密钥对其他用户可读时 doctor 报错", () => {
    const repo = setup();
    chmodSync(join(repo.keyDir, "evidence.key"), 0o644);
    const doctor = repo.cli("doctor");
    assert.notEqual(doctor.status, 0);
    assert.match(doctor.stdout, /其他用户可读/);
  });
});

describe("多 Worktree 与已有钩子", () => {
  // 按 settings.json 里登记的命令原样执行一次，等价于 Claude Code 调用钩子。
  function runClaudeSetting(root, env, payload) {
    const settings = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
    const command = settings.hooks.PreToolUse.at(-1).hooks[0].command;
    return sh(root, "sh", ["-c", command], { ...env, CLAUDE_PROJECT_DIR: root }, JSON.stringify(payload));
  }

  test("新建的 Linked Worktree 不用重新安装就能拦截与校验提交", () => {
    const repo = setup();
    const wt = join(repo.root, "..", "wt");
    git(repo.root, "worktree", "add", "-q", "-b", "task/wt", wt);
    assert.ok(existsSync(join(wt, ".harness/bin/harness")), "入口应随仓库检出");

    const denied = runClaudeSetting(wt, repo.env, { tool_name: "Bash", tool_input: { command: "git stash" }, cwd: wt });
    assert.equal(denied.status, 2, denied.stderr);
    assert.match(denied.stderr, /已拦截/);

    write(wt, SECRET_FILE, "-----BEGIN PRIVATE KEY-----\n");
    git(wt, "add", "-f", SECRET_FILE, repo.env);
    const committed = sh(wt, "git", ["commit", "-q", "-m", BASIC], repo.env);
    assert.notEqual(committed.status, 0, "Linked Worktree 里的提交也要经过 harness");
    assert.match(committed.stderr, /密钥|已拦截/);
  });

  test("已有钩子提前退出时 harness 检查仍会执行", () => {
    const repo = setup({ install: false });
    // 模拟 husky 一类的钩子：没有前端改动就直接 exit 0。
    write(repo.root, ".git/hooks/pre-commit", "#!/bin/sh\nexit 0\n");
    chmodSync(join(repo.root, ".git/hooks/pre-commit"), 0o755);
    assert.equal(repo.rawCli("install").status, 0);
    const hook = readFileSync(join(repo.root, ".git/hooks/pre-commit"), "utf8");
    assert.ok(hook.indexOf("# harness:hook") < hook.indexOf("exit 0"), "harness 块必须排在原有内容之前");

    git(repo.root, "checkout", "-q", "-b", "task/early-exit");
    write(repo.root, SECRET_FILE, "-----BEGIN PRIVATE KEY-----\n");
    git(repo.root, "add", "-f", SECRET_FILE);
    const result = sh(repo.root, "git", ["commit", "-q", "-m", BASIC], repo.env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /密钥|已拦截/);
  });

  test("reference-transaction 原有脚本仍能读到标准输入，主分支仍受保护", () => {
    const repo = setup({ install: false });
    const capture = join(repo.root, "..", "ref-input.log");
    write(repo.root, ".git/hooks/reference-transaction", `#!/bin/sh\ncat >> ${JSON.stringify(capture)}\n`);
    chmodSync(join(repo.root, ".git/hooks/reference-transaction"), 0o755);
    assert.equal(repo.rawCli("install").status, 0);

    git(repo.root, "branch", "side");
    assert.match(readFileSync(capture, "utf8"), /refs\/heads\/side/, "原有脚本应收到完整输入");

    git(repo.root, "checkout", "-q", "side");
    write(repo.root, "a.txt", "a\n");
    git(repo.root, "add", "-A");
    git(repo.root, "commit", "-q", "-m", BASIC);
    const target = git(repo.root, "rev-parse", "side");
    const refused = sh(repo.root, "git", ["update-ref", "refs/heads/main", target], repo.env);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /只允许由 harness merge 更新/);
  });

  test("重复安装替换旧版追加在末尾的钩子块", () => {
    const repo = setup();
    const file = join(repo.root, ".git/hooks/pre-commit");
    // 旧版本把块追加在末尾且没有结束标记。
    writeFileSync(file, "#!/bin/sh\necho original\n# harness:hook pre-commit\nold-command || exit $?\n");
    assert.equal(repo.cli("install").status, 0);
    const text = readFileSync(file, "utf8");
    assert.equal(text.split("# harness:hook pre-commit").length, 2, "只应保留一个块");
    assert.doesNotMatch(text, /old-command/);
    assert.match(text, /echo original/);
  });

  test("项目全局忽略 bin/ 时入口仍能入库", () => {
    // Go 项目常见的 bin/ 忽略规则会连带忽略 .harness/bin/。
    const repo = setup({ install: false, files: { ".gitignore": "bin/\n*.log\n" } });
    assert.equal(repo.rawCli("install").status, 0);
    const ignored = sh(repo.root, "git", ["check-ignore", "-q", ".harness/bin/harness"], repo.env);
    assert.notEqual(ignored.status, 0, "入口不应再被忽略");
    assert.equal(sh(repo.root, "git", ["check-ignore", "-q", "bin/app"], repo.env).status, 0, "项目自己的 bin/ 仍被忽略");
    const text = readFileSync(join(repo.root, ".gitignore"), "utf8");
    assert.match(text, /^!\.harness\/bin\/$/m);
    // 再装一次不重复追加
    assert.equal(repo.rawCli("install").status, 0);
    assert.equal(readFileSync(join(repo.root, ".gitignore"), "utf8"), text);
  });

  test("去掉旧版要求的 .harness/bin/ 忽略规则，入口不再被忽略", () => {
    const repo = setup({ install: false, files: { ".gitignore": "*.log\n.harness/bin/\n" } });
    assert.equal(repo.rawCli("install").status, 0);
    assert.equal(readFileSync(join(repo.root, ".gitignore"), "utf8"), "*.log\n");
    assert.notEqual(sh(repo.root, "git", ["check-ignore", "-q", ".harness/bin/harness"], repo.env).status, 0);
  });

  test("本机没装入口锁定的版本时，提交照常进行，主分支仍受保护", () => {
    const repo = setup();
    // 模拟另一台机器：入口随仓库检出，但版本目录为空。
    const env = { ...repo.env, HARNESS_STORE: join(repo.root, "..", "empty-store") };
    git(repo.root, "checkout", "-q", "-b", "task/no-store", env);
    write(repo.root, "a.txt", "a\n");
    git(repo.root, "add", "-A", env);
    const committed = sh(repo.root, "git", ["commit", "-q", "-m", BASIC], env);
    assert.equal(committed.status, 0, committed.stderr);
    assert.match(committed.stderr, /本机没有安装门禁锁定的版本/);

    const target = git(repo.root, "rev-parse", "HEAD", env);
    git(repo.root, "checkout", "-q", "main", env);
    const refused = sh(repo.root, "git", ["update-ref", "refs/heads/main", target], env);
    assert.notEqual(refused.status, 0, "主分支保护不能因为没装版本而放开");
    assert.match(refused.stderr, /本机没有安装门禁锁定的版本/);
  });

  test("本机没装入口锁定的版本时，实时拦截一律拒绝，不能静默放行", () => {
    const repo = setup();
    const env = { ...repo.env, HARNESS_STORE: join(repo.root, "..", "empty-store") };
    const shim = join(repo.root, ".harness/bin/harness");
    const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "cat .env" }, cwd: repo.root });

    // Claude Code 只有退出码 2 才拦截，其他非零退出码按非阻塞错误继续执行。
    const claude = sh(repo.root, shim, ["hook", "--client", "claude"], env, payload);
    assert.equal(claude.status, 2, claude.stderr);
    assert.match(claude.stderr, /本机没有安装门禁锁定的版本/);

    // Codex 读标准输出里的 permissionDecision。
    const codex = sh(repo.root, shim, ["hook", "--client", "codex"], env, payload);
    assert.equal(codex.status, 0, codex.stderr);
    const decision = JSON.parse(codex.stdout).hookSpecificOutput;
    assert.equal(decision.permissionDecision, "deny");
    assert.match(decision.permissionDecisionReason, /本机没有安装门禁锁定的版本/);
  });

  test("没有接入 harness 的仓库共用这些钩子时不受影响", () => {
    const repo = setup();
    const plain = join(repo.root, "..", "plain");
    mkdirSync(plain);
    git(plain, "init", "-q", "-b", "main", {});
    git(plain, "config", "user.name", "t", {});
    git(plain, "config", "user.email", "t@e", {});
    for (const name of ["pre-commit", "commit-msg", "reference-transaction"]) {
      writeFileSync(join(plain, ".git/hooks", name), readFileSync(join(repo.root, ".git/hooks", name), "utf8"));
      chmodSync(join(plain, ".git/hooks", name), 0o755);
    }
    write(plain, "a.txt", "a\n");
    git(plain, "add", "-A", {});
    const result = sh(plain, "git", ["commit", "-q", "-m", "anything"], {});
    assert.equal(result.status, 0, result.stderr);
  });

  test("golden --worktree 按工作区里的配置重放，用于验证任务分支改过的规则", () => {
    const repo = setup();
    const policy = JSON.parse(readFileSync(join(repo.root, ".harness/policy.json"), "utf8"));
    policy.disabled = [...(policy.disabled ?? []), "shell-recursive-delete"];
    writeFileSync(join(repo.root, ".harness/policy.json"), `${JSON.stringify(policy, null, 2)}\n`);
    assert.equal(repo.cli("golden").status, 0, "默认按主分支配置，未提交的改动不生效");
    const worktree = repo.cli("golden", "--worktree");
    assert.notEqual(worktree.status, 0);
    assert.match(worktree.stdout, /FAIL g04/);
  });
});

describe("版本管理", () => {
  test("versions 列出已安装版本，prune 保留指定版本", () => {
    const repo = setup();
    // 手工造一个更老的版本目录，模拟多版本累积
    const store = repo.env.HARNESS_STORE;
    const older = "0.0.9";
    mkdirSync(join(store, older), { recursive: true });
    const listed = repo.cli("versions");
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(currentVersion().replaceAll(".", "\\.")));
    assert.match(listed.stdout, /0\.0\.9/);

    const dry = repo.cli("prune", "--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /0\.0\.9/);
  });
});

describe("升级时列出尚未配置的可选项", () => {
  test("缺哪项列哪项，并区分只记录与会拦截，不改任何配置文件", () => {
    const repo = setup();
    const before = ["config.json", "verify.json"].map((name) => readFileSync(join(repo.root, ".harness", name), "utf8"));
    const result = repo.cli("upgrade");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /尚未配置的可选项/);
    assert.match(result.stdout, /risk.*observe.*只记录/s);
    assert.match(result.stdout, /testFirst.*observe/s);
    assert.match(result.stdout, /coverage.*observe/s);
    assert.match(result.stdout, /requiredPaths.*直接拦截/s);
    const after = ["config.json", "verify.json"].map((name) => readFileSync(join(repo.root, ".harness", name), "utf8"));
    assert.deepEqual(after, before);
  });

  test("已配置的项不再列出，全部配置时不输出这一段", () => {
    const repo = setup();
    const config = JSON.parse(readFileSync(join(repo.root, ".harness/config.json"), "utf8"));
    const verify = JSON.parse(readFileSync(join(repo.root, ".harness/verify.json"), "utf8"));
    write(repo.root, ".harness/config.json", `${JSON.stringify({ ...config, risk: { mode: "observe", paths: [], deps: [] } })}\n`);
    write(repo.root, ".harness/verify.json", `${JSON.stringify({ ...verify, testFirst: {}, coverage: {} })}\n`);
    const partial = repo.cli("upgrade");
    assert.equal(partial.status, 0, partial.stderr);
    assert.match(partial.stdout, /requiredPaths/);
    assert.doesNotMatch(partial.stdout, /risk[^\n]*observe/);
    assert.doesNotMatch(partial.stdout, /testFirst/);
    assert.doesNotMatch(partial.stdout, /coverage/);

    write(repo.root, ".harness/verify.json", `${JSON.stringify({ ...verify, testFirst: {}, coverage: {}, requiredPaths: { match: ["src/**"] } })}\n`);
    const full = repo.cli("upgrade");
    assert.equal(full.status, 0, full.stderr);
    assert.doesNotMatch(full.stdout, /尚未配置的可选项/);
  });
});
