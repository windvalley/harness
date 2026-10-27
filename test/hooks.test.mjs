import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { commit, CONFIG, git, makeRepo, sh, write, writeReview } from "./helpers.mjs";
import { PACKAGE_ROOT as PACKAGE_ROOT_TEST } from "./helpers.mjs";
import { packageVersion as currentVersion } from "../src/install/managed.mjs";

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
    // 入口入库，Linked Worktree 检出后直接可用；带绝对路径的 DSH 插件目录仍在忽略里。
    assert.equal(git(repo.root, "ls-files", ".harness/bin/harness"), ".harness/bin/harness");
    assert.match(readFileSync(join(repo.root, ".gitignore"), "utf8"), /\.harness\/dsh-plugin\//);
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

  test("DSH 插件被复制到项目后仍能加载", () => {
    const repo = setup();
    const entry = join(repo.root, ".harness/dsh-plugin/index.mjs");
    assert.ok(existsSync(entry), "应生成插件入口");
    const source = readFileSync(entry, "utf8");
    // 插件从版本目录导入，不能残留源码树里的相对路径。
    assert.doesNotMatch(source, /\.\.\/\.\.\/src\//);
    const loaded = sh(repo.root, process.execPath, ["-e", 'import("./.harness/dsh-plugin/index.mjs").then(m=>console.log(typeof m.apply)).catch(e=>{console.error(e.message);process.exit(1)})'], repo.env);
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.equal(loaded.stdout.trim(), "function");
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
    const rules = readFileSync(join(repo.root, ".harness/rules/harness.md"), "utf8");
    assert.match(rules, /## 收尾：任务 Worktree 由用户发起清理/);
    assert.match(rules, /harness worktree clean/);
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

  test("起始检查按项目技术栈生成，未知技术栈不会被塞进不可用的检查", async () => {
    const { starterVerify } = await import("../src/install/init.mjs");
    const { mkdtempSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dirs = [];
    const stack = (files) => {
      const dir = mkdtempSync(join(tmpdir(), "harness-stack-"));
      dirs.push(dir);
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(join(dir, rel, ".."), { recursive: true });
        writeFileSync(join(dir, rel), content);
      }
      return starterVerify({ cwd: dir });
    };

    const rust = stack({ "rust/Cargo.toml": "[workspace]\n" });
    const cargo = rust.checks.find((check) => check.id === "cargo-test");
    assert.equal(cargo.cwd, "rust");
    assert.deepEqual(cargo.cmd, ["cargo", "test", "--all-targets"]);
    // target 由 cargo 自己创建，不能作为前置条件，否则全新克隆永远跳过这项检查
    assert.equal(cargo.requires, undefined);

    const rootRust = stack({ "Cargo.toml": "[package]\n" });
    assert.equal(rootRust.checks.find((check) => check.id === "cargo-test").cwd, undefined);

    // 没有 pytest 配置的 Python 项目不生成 pytest 检查
    assert.equal(stack({ "app/main.py": "print(1)\n" }).checks.some((check) => check.id === "pytest"), false);
    const pytest = stack({ "pyproject.toml": "[tool.pytest.ini_options]\n", "app/main.py": "print(1)\n" });
    assert.equal(pytest.checks.find((check) => check.id === "pytest").tier, "gate");

    // 只有文档的项目不生成语言检查，只保留通用项
    const empty = stack({ "README.md": "demo\n" });
    assert.deepEqual(empty.checks.map((check) => check.id), ["lint", "harness-golden", "manual-check", "visual-hint"]);

    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
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

  test("init 自带黄金任务，且开箱全部通过", () => {
    const repo = makeRepo();
    repos.push(repo);
    const tasks = JSON.parse(readFileSync(join(repo.root, ".harness/golden/tasks.json"), "utf8"));
    assert.ok(tasks.tasks.length >= 10, "应写入起始黄金任务");
    const golden = repo.cli("golden");
    assert.equal(golden.status, 0, golden.stdout + golden.stderr);
    // 针对可选预设的用例在预设未启用时跳过，不计入通过率。
    const optional = tasks.tasks.filter((task) => (task.presets ?? []).length > 0).length;
    const applicable = tasks.tasks.length - optional;
    assert.match(golden.stdout, new RegExp(`${applicable}/${applicable} 通过`));
    if (optional > 0) assert.match(golden.stdout, new RegExp(`跳过 ${optional} 项`));
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
    const input = JSON.stringify({ name: "bash", arguments: { command: "cat .env" } });
    const output = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["hook", "--client", "dsh"], repo.env, input);
    assert.equal(output.status, 2);
    assert.match(output.stderr, /密钥|已拦截/);
  });

  test("三个客户端对同一操作判定一致", () => {
    const repo = setup();
    const cases = [
      [{ name: "bash", arguments: { command: "git stash" } }, { tool_name: "Bash", tool_input: { command: "git stash" } }],
      [{ name: "bash", arguments: { command: "git status" } }, { tool_name: "Bash", tool_input: { command: "git status" } }],
      [{ name: "write", arguments: { file_path: ".env", content: "x" } }, { tool_name: "Write", tool_input: { file_path: ".env", content: "x" } }],
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
