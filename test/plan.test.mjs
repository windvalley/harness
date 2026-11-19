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
  test("已授权任务更换实现路径和更新计划后按原验收直接交付", () => {
    const repo = setup();
    const linked = linkedTask(repo);
    commit(linked, "docs(login): 方案\n\n- 写明验收与实施路径", { [PLAN]: "# 方案\n\n用组件 A。\n", [ACCEPTANCE]: "- 登录成功后进入首页\n" });
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE).status, 0);
    commit(linked, "feat(login): 完成登录\n\n- 复用组件 B\n- 按同一验收交付", { [PLAN]: "# 方案\n\n实测后改用组件 B。\n", "src/app.js": code(10) });
    const result = landed(repo, BRANCH);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /已有实施授权/);
  });

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

  test("授权后改验收清单时，失效原因说明改了哪个章节、增删几条", () => {
    const repo = setup();
    repo.branch(BRANCH, { "src/big.js": code(10), [ACCEPTANCE]: "## 应该发生\n\n- 甲\n- 乙\n" });
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE).status, 0);

    git(repo.root, "checkout", "-q", BRANCH);
    commit(repo.root, "docs(login): 调整验收\n\n- 改掉一条验收\n- 补一条新验收", { [ACCEPTANCE]: "## 应该发生\n\n- 甲\n- 丙\n" });
    git(repo.root, "checkout", "-q", "main");

    const status = repo.cli("status", "--branch", BRANCH);
    assert.match(status.stdout, /合并前 新增 1 条、删除 1 条/, "要说出增删条数，不能让用户自己 diff");
    assert.match(status.stdout, /授权之后验收清单又改过/);

    const verify = repo.cli("verify", "--branch", BRANCH);
    assert.match(verify.stderr, /RISK 实施授权已失效: 授权之后验收清单又改过（合并前 新增 1 条、删除 1 条）/, "verify 也要显示失效，而不是只给静态提示");
  });

  test("只有排版变化时说清楚没有条目增删", () => {
    const repo = setup();
    repo.branch(BRANCH, { "src/big.js": code(10), [ACCEPTANCE]: "## 应该发生\n\n- 甲\n" });
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE).status, 0);

    git(repo.root, "checkout", "-q", BRANCH);
    commit(repo.root, "docs(login): 调整排版\n\n- 只加空行\n- 不改条目", { [ACCEPTANCE]: "## 应该发生\n\n\n- 甲\n" });
    git(repo.root, "checkout", "-q", "main");

    assert.match(repo.cli("status", "--branch", BRANCH).stdout, /只有空行、标题或排版变化/);
  });

  test("approve 摘要列出合并后检查及本次改动是否命中", () => {
    const verify = {
      version: 1,
      docOnly: { match: ["docs/**", "**/*.md"], exclude: [] },
      checks: [
        { id: "unit", tier: "gate", when: ["src/**"], cmd: ["node", "-e", "process.exit(0)"] },
        { id: "login-smoke", tier: "extended", phase: "post-merge", when: ["src/other/**"], reason: "需要合入后环境", howToVerify: "部署后实测" },
      ],
      fullSuiteTriggers: { paths: [] },
    };
    const repo = makeRepo({ project: { ".harness/verify.json": verify } });
    repos.push(repo);
    repo.branch(BRANCH, { "src/big.js": code(10), [ACCEPTANCE]: "- 大改动\n" });
    const summary = repo.cli("approve", "--branch", BRANCH);
    assert.equal(summary.status, 0, summary.stderr);
    assert.match(summary.stdout, /login-smoke: 本次改动没有命中/, "交付时才发现会白干一轮，登记授权时就要看到");
  });

  test("账本记下授权的原话与清单指纹，记录被覆盖后仍可核对", () => {
    const repo = setup();
    repo.branch(BRANCH, { "src/big.js": code(10), [ACCEPTANCE]: "## 应该发生\n\n- 甲\n" });
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE).status, 0);

    git(repo.root, "checkout", "-q", BRANCH);
    commit(repo.root, "docs(login): 改验收\n\n- 追加一条验收\n- 说明改动原因", { [ACCEPTANCE]: "## 应该发生\n\n- 甲\n- 乙\n" });
    git(repo.root, "checkout", "-q", "main");
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", "确认改成两条").status, 0);

    const ledger = readFileSync(join(repo.env.HARNESS_DATA_DIR, "ledger.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "plan.approve");
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0].note, QUOTE, "旧授权被覆盖后，账本里仍要留下当时的原话");
    assert.match(ledger[0].acceptanceHash, /^[0-9a-f]{16}$/);
    assert.notEqual(ledger[0].acceptanceHash, ledger[1].acceptanceHash, "两次授权的清单指纹要能区分");
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
    assert.match(text, /已授权的任务连续推进到交付/);
    assert.match(text, /每一轮以工具调用推进/);
    assert.match(text, /回应客户端的进度提醒后继续调用工具，不结束这一轮/);
    assert.match(text, /先红后绿/);
  });
});
