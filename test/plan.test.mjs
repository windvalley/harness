import { strict as assert } from "node:assert";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, CONFIG, commit, fakeReviewer, git, makeRepo, sh, write } from "./helpers.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

const POLICY = { version: 1, presets: ["secrets", "git-safety", "gate-self", "plan-first"], disabled: [], rules: [] };
const BRANCH = "feat/login";
const ACCEPTANCE = ".harness/acceptance/feat-login.md";
const PLAN = "docs/changes/login/plan.md";
const QUOTE = "可以，开始实施";
const code = (lines) => `${Array.from({ length: lines }, (_, i) => `export const v${i} = ${i};`).join("\n")}\n`;

function setup() {
  const config = { ...CONFIG, intent: { ...CONFIG.intent, plan: { maxLines: 5 } } };
  const repo = makeRepo({ project: { ".harness/config.json": config, ".harness/policy.json": POLICY } });
  repos.push(repo);
  return repo;
}

/** 会话停在 Linked Worktree 里的任务分支上。 */
function linkedTask(repo) {
  const linked = join(realpathSync(repo.root), "..", "task");
  git(repo.root, "worktree", "add", "-q", "-b", BRANCH, linked, "main");
  return linked;
}

function claudeHook(repo, payload) {
  return sh(repo.root, join(repo.root, ".harness/bin/harness"), ["hook", "--client", "claude"], repo.env, JSON.stringify(payload));
}
const writeHook = (repo, cwd, file) => claudeHook(repo, { tool_name: "Write", tool_input: { file_path: join(cwd, file), content: "x\n" }, cwd });
const bashHook = (repo, cwd, command) => claudeHook(repo, { tool_name: "Bash", tool_input: { command }, cwd });

function landed(repo, branch) {
  fakeReviewer(repo, APPROVE);
  for (const step of ["verify", "review"]) {
    const result = repo.cli(step, "--branch", branch);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  return repo.cli("merge", "--branch", branch);
}

describe("先方案后实施", () => {
  test("写了实施方案后，记录授权前只能写方案文件；记录后放行，清单再改又要重新记录", () => {
    const repo = setup();
    const linked = linkedTask(repo);
    assert.equal(writeHook(repo, linked, "src/app.js").status, 0, "还没写方案时按直接实施处理");

    write(linked, PLAN, "# 实施方案\n");
    write(linked, ACCEPTANCE, "- 登录成功后进入首页\n");
    const denied = writeHook(repo, linked, "src/app.js");
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /plan-before-code/);
    assert.match(denied.stderr, /用户还没有同意实施时.*停下等待/);
    assert.match(denied.stderr, /harness approve --branch <任务分支> --yes --note/);
    assert.equal(writeHook(repo, linked, "src/app.test.js").status, 2, "测试同样要等授权");
    assert.equal(writeHook(repo, linked, "docs/changes/login/spec.md").status, 0);
    assert.equal(writeHook(repo, linked, ACCEPTANCE).status, 0);

    const early = repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE);
    assert.notEqual(early.status, 0, "方案没提交到分支时不能记录授权");
    assert.match(early.stderr, /先把方案提交到任务分支/);

    commit(linked, "docs(login): 方案\n\n- 验收清单与实施方案", {});
    const summary = repo.cli("approve", "--branch", BRANCH);
    assert.equal(summary.status, 0, summary.stderr);
    assert.match(summary.stdout, /docs\/changes\/login\/plan\.md/);
    assert.match(summary.stdout, /登录成功后进入首页/);
    assert.match(summary.stdout, /还没有记录用户的实施授权/);
    const approved = repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE);
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(repo.cli("approve", "--branch", BRANCH).stdout, new RegExp(`已记录实施授权（依据：${QUOTE}`));
    assert.equal(writeHook(repo, linked, "src/app.js").status, 0, "记录授权后可以写测试与实现");

    write(linked, ACCEPTANCE, "- 登录成功后进入首页\n- 新加一条\n");
    assert.equal(writeHook(repo, linked, "src/app.js").status, 2, "授权后清单又改了");
  });

  test("用户同意后由 Agent 记录授权，不需要用户执行命令，但必须照录原话", () => {
    const repo = setup();
    const linked = linkedTask(repo);
    commit(linked, "docs(login): 方案\n\n- 验收清单与实施方案", { [PLAN]: "# 实施方案\n", [ACCEPTANCE]: "- 登录成功后进入首页\n" });
    const agent = bashHook(repo, linked, `.harness/bin/harness approve --branch ${BRANCH} --yes --note "${QUOTE}"`);
    assert.equal(agent.status, 0, `Agent 可以记录授权: ${agent.stderr}`);

    for (const args of [["--yes"], ["--yes", "--note", "  "]]) {
      const refused = repo.cli("approve", "--branch", BRANCH, ...args);
      assert.notEqual(refused.status, 0, "没写依据时不记录");
      assert.match(refused.stderr, /--note/);
    }
    assert.match(repo.cli("status", "--branch", BRANCH).stdout, /待实施授权/);
  });

  test("小改动直接合并，不需要授权记录", () => {
    const repo = setup();
    repo.branch("fix/small", { "src/a.js": code(3) });
    const status = repo.cli("status", "--branch", "fix/small");
    assert.match(status.stdout, /\[ok\] plan: 属于直接实施的范围/);
    const merged = landed(repo, "fix/small");
    assert.equal(merged.status, 0, merged.stderr);
  });

  test("超过阈值或改了库表、没有授权记录时拒绝合并，记录后放行并显示依据", () => {
    const repo = setup();
    repo.branch(BRANCH, { "src/big.js": code(10), "src/big.test.js": code(50), [ACCEPTANCE]: "- 大改动\n" });
    const refused = landed(repo, BRANCH);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /plan_unapproved/);
    assert.match(refused.stderr, /代码改动 10 行，超过 5 行/, "测试文件不计入行数");
    assert.match(refused.stderr, /先向用户说明/);
    assert.match(repo.cli("status", "--branch", BRANCH).stdout, /待实施授权/);

    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE).status, 0);
    assert.match(repo.cli("status", "--branch", BRANCH).stdout, new RegExp(`已有实施授权.*依据：${QUOTE}`));
    const merged = repo.cli("merge", "--branch", BRANCH);
    assert.equal(merged.status, 0, merged.stderr);
    assert.match(merged.stderr, new RegExp(`已有实施授权\\(依据: ${QUOTE}\\)`));

    repo.branch("feat/schema", { "db/migrations/0002_add_user.sql": "alter table t add c int;\n" });
    const schema = landed(repo, "feat/schema");
    assert.notEqual(schema.status, 0);
    assert.match(schema.stderr, /改了库表相关文件 db\/migrations\/0002_add_user\.sql/);
  });

  test("未启用 plan-first 的项目不受影响", () => {
    const repo = makeRepo();
    repos.push(repo);
    repo.branch("feat/big", { "src/big.js": code(800) });
    const merged = landed(repo, "feat/big");
    assert.equal(merged.status, 0, merged.stderr);
  });

  test("升级会刷新 AGENTS.md 的托管块，块外内容保留", () => {
    const repo = setup();
    write(repo.root, "AGENTS.md", "# 项目规范\n\n自己的规则\n\n<!-- harness:start -->\n旧内容\n<!-- harness:end -->\n");
    assert.equal(repo.cli("upgrade").status, 0);
    const text = readFileSync(join(repo.root, "AGENTS.md"), "utf8");
    assert.match(text, /自己的规则/);
    assert.doesNotMatch(text, /旧内容/);
    assert.match(text, /先判断任务分级/);
    assert.match(text, /用户表达开始实施的意思才算授权/);
    assert.match(text, /授权后连续实施到完成/);
    assert.match(text, /先红后绿/);
  });
});
