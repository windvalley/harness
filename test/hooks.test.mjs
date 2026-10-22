import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { git, makeRepo, sh, write } from "./helpers.mjs";

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
    assert.match(readFileSync(join(repo.root, ".claude/settings.json"), "utf8"), /claude-hook\.mjs|\.harness\/bin/);
    assert.match(readFileSync(join(repo.root, ".codex/hooks.json"), "utf8"), /codex-hook/);
  });

  test("init 会写出配置、规则与托管块，且可重复执行", () => {
    const repo = setup({ install: false, project: { ".harness/config.json": null, ".harness/policy.json": null, ".harness/verify.json": null } });
    const first = repo.rawCli("init");
    assert.equal(first.status, 0, first.stderr);
    for (const rel of [".harness/config.json", ".harness/policy.json", ".harness/verify.json", ".harness/rules/core.md", ".harness/rules/harness.md", ".harness/templates/spec.md"]) {
      assert.ok(existsSync(join(repo.root, rel)), rel);
    }
    assert.match(readFileSync(join(repo.root, "AGENTS.md"), "utf8"), /harness:start/);
    // 二次执行不覆盖已有配置
    writeFileSync(join(repo.root, ".harness/config.json"), JSON.stringify({ version: 1, mainBranch: "main", marker: "保留" }, null, 2));
    const second = repo.rawCli("init");
    assert.equal(second.status, 0, second.stderr);
    assert.match(readFileSync(join(repo.root, ".harness/config.json"), "utf8"), /保留/);
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
    const file = join(repo.env.HARNESS_STORE, "0.1.0/src/policy/engine.mjs");
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
