import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, commit, fakeReviewer, git, makeRepo, sh } from "./helpers.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

// 命令行工具的夹具：没有前端、没有部署环境，合并后验收是对发布产物的冒烟。
const VERIFY = {
  version: 1,
  docOnly: { match: ["docs/**", "**/*.md"], exclude: [] },
  checks: [
    { id: "unit", tier: "gate", when: ["src/**"], cmd: ["node", "-e", "process.exit(0)"] },
    { id: "release-smoke", tier: "extended", phase: "post-merge", when: ["src/**"], reason: "需要主分支集成后的产物", howToVerify: "对合入后的主分支产物运行冒烟脚本" },
  ],
  fullSuiteTriggers: { paths: [] },
};

const ACCEPTANCE = `# 验收清单

## 应该发生

- 命令行子命令行为正确。

## 合并后验收

- 主分支产物的冒烟脚本通过。
`;

const DOC_COMMIT = "docs(demo): 补充说明\n\n- 只更新文档\n- 不改检查覆盖文件";

function setup(project = { ".harness/verify.json": VERIFY }) {
  const repo = makeRepo({ project });
  repos.push(repo);
  fakeReviewer(repo, APPROVE);
  return repo;
}

function acceptanceFor(branch) {
  return `.harness/acceptance/${branch.replace(/[^0-9A-Za-z._-]/g, "-")}.md`;
}

function task(repo, branch, files = { "src/a.js": "a\n" }) {
  return repo.branch(branch, { ...files, [acceptanceFor(branch)]: ACCEPTANCE });
}

function extend(repo, branch, files, message = DOC_COMMIT) {
  git(repo.root, "checkout", "-q", branch);
  const head = commit(repo.root, message, files);
  git(repo.root, "checkout", "-q", "main");
  return head;
}

function gate(repo, branch) {
  assert.equal(repo.cli("verify", "--branch", branch).status, 0, `verify ${branch}`);
  const reviewed = repo.cli("review", "--branch", branch);
  assert.equal(reviewed.status, 0, reviewed.stderr);
}

function deliver(repo, branch) {
  gate(repo, branch);
  const merged = repo.cli("merge", "--branch", branch);
  assert.equal(merged.status, 0, merged.stderr);
  return merged;
}

function attest(repo, branch, extra = []) {
  const report = join(repo.root, "..", "smoke-report.md");
  writeFileSync(report, "release smoke passed\n");
  return repo.cli("attest", "--branch", branch, "--check", "release-smoke", "--command", "run release smoke", "--report", report, ...extra);
}

const main = (repo) => git(repo.root, "rev-parse", "main");
const status = (repo, branch) => repo.cli("status", "--branch", branch);
const obligationDir = (repo) => join(repo.env.HARNESS_DATA_DIR, "obligation");

describe("合并后验收义务：默认关闭", () => {
  test("没有配置 post-merge 检查时不产生义务记录，输出与原来一致", () => {
    const repo = setup({
      ".harness/verify.json": {
        version: 1,
        docOnly: { match: ["docs/**", "**/*.md"], exclude: [] },
        checks: [{ id: "unit", tier: "gate", when: ["src/**"], cmd: ["node", "-e", "process.exit(0)"] }],
        fullSuiteTriggers: { paths: [] },
      },
    });
    repo.branch("task/a", { "src/a.js": "a\n" });
    const merged = deliver(repo, "task/a");
    assert.doesNotMatch(merged.stderr, /合并后验收/);
    assert.equal(existsSync(obligationDir(repo)), false);

    const done = status(repo, "task/a");
    assert.equal(done.status, 0);
    assert.match(done.stdout, /已经包含在主分支中，无需再交付/);

    const list = repo.cli("status", "--post-merge");
    assert.equal(list.status, 0);
    assert.equal(list.stdout.trim(), "");
  });
});

describe("合并后验收义务：不丢", () => {
  test("合入后在原分支追加不命中检查范围的提交并再次合入，义务不消失", () => {
    const repo = setup();
    task(repo, "task/a");
    deliver(repo, "task/a");
    assert.match(status(repo, "task/a").stdout, /合并后验收待完成：release-smoke/);

    extend(repo, "task/a", { "docs/a.md": "a\n" });
    deliver(repo, "task/a");

    const pending = status(repo, "task/a");
    assert.equal(pending.status, 1, pending.stdout);
    assert.match(pending.stdout, /合并后验收待完成：release-smoke/);
    assert.doesNotMatch(pending.stdout, /无需再交付/);

    assert.equal(attest(repo, "task/a").status, 0);
    const done = status(repo, "task/a");
    assert.equal(done.status, 0, done.stdout);
    assert.match(done.stdout, /交付与合并后验收均完成/);
  });

  test("合入后重跑 verify 覆盖证据，义务不消失", () => {
    const repo = setup();
    task(repo, "task/a");
    deliver(repo, "task/a");
    repo.cli("verify", "--branch", "task/a", "--no-reuse");
    const pending = status(repo, "task/a");
    assert.equal(pending.status, 1, pending.stdout);
    assert.match(pending.stdout, /合并后验收待完成：release-smoke/);
  });

  test("删除已合并的分支后，义务仍可查询并可登记", () => {
    const repo = setup();
    task(repo, "task/a");
    deliver(repo, "task/a");
    git(repo.root, "branch", "-D", "task/a");

    const list = repo.cli("status", "--post-merge");
    assert.equal(list.status, 1, list.stdout);
    assert.match(list.stdout, /release-smoke/);
    assert.match(list.stdout, /task\/a/);

    const attested = attest(repo, "task/a");
    assert.equal(attested.status, 0, attested.stderr);
    const after = repo.cli("status", "--post-merge");
    assert.equal(after.status, 0, after.stdout);
    assert.equal(after.stdout.trim(), "");
  });

  test("密钥轮换后验签失败的义务按待办处理，重新登记后关闭", () => {
    const repo = setup();
    task(repo, "task/a");
    deliver(repo, "task/a");
    assert.equal(attest(repo, "task/a").status, 0);
    assert.equal(status(repo, "task/a").status, 0);

    assert.equal(repo.cli("key", "rotate", "--yes").status, 0);
    const list = repo.cli("status", "--post-merge");
    assert.equal(list.status, 1, list.stdout);
    assert.match(list.stdout, /release-smoke/);
    assert.match(list.stdout, /密钥/);

    assert.equal(attest(repo, "task/a").status, 0);
    assert.equal(repo.cli("status", "--post-merge").status, 0);
  });
});

describe("合并后验收义务：可见", () => {
  test("merge 的可读输出列出待办与登记命令", () => {
    const repo = setup();
    task(repo, "task/a");
    const merged = deliver(repo, "task/a");
    assert.match(merged.stderr, /合并后验收待完成[\s\S]*release-smoke[\s\S]*task\/a/);
    assert.match(merged.stderr, /对合入后的主分支产物运行冒烟脚本/);

    const list = repo.cli("status", "--post-merge");
    assert.match(list.stdout, /harness attest --branch task\/a --check release-smoke/);
  });

  test("义务只在分支顶端已合入主分支后到期", () => {
    const repo = setup();
    task(repo, "task/a");
    gate(repo, "task/a");
    const before = repo.cli("status", "--post-merge");
    assert.equal(before.status, 0);
    assert.equal(before.stdout.trim(), "");
  });

  test("没有任何义务时 status --post-merge 输出为空", () => {
    const repo = setup();
    const list = repo.cli("status", "--post-merge");
    assert.equal(list.status, 0);
    assert.equal(list.stdout.trim(), "");
  });
});

describe("合并后验收义务：关闭规则", () => {
  test("修复分支登记通过后，原分支的义务一并关闭", () => {
    const repo = setup();
    task(repo, "feat/login");
    deliver(repo, "feat/login");
    repo.branch("fix/login-gateway", { "src/a.js": "fixed\n" });
    deliver(repo, "fix/login-gateway");
    assert.equal(status(repo, "feat/login").status, 1);

    assert.equal(attest(repo, "fix/login-gateway").status, 0);
    assert.equal(status(repo, "feat/login").status, 0);
    assert.equal(status(repo, "fix/login-gateway").status, 0);
    assert.equal(repo.cli("status", "--post-merge").stdout.trim(), "");
  });

  test("--at 只关闭被测提交已经包含的义务，并行合入的其余义务保持待办", () => {
    const repo = setup();
    task(repo, "task/a", { "src/a.js": "a\n" });
    task(repo, "task/b", { "src/b.js": "b\n" });
    gate(repo, "task/a");
    gate(repo, "task/b");
    assert.equal(repo.cli("merge", "--branch", "task/a").status, 0);
    const afterA = main(repo);
    const mergedB = repo.cli("merge", "--branch", "task/b");
    assert.equal(mergedB.status, 0, mergedB.stderr);

    const early = attest(repo, "task/a", ["--at", afterA]);
    assert.equal(early.status, 0, early.stderr);
    assert.equal(status(repo, "task/a").status, 0);
    assert.equal(status(repo, "task/b").status, 1);

    const refused = attest(repo, "task/b", ["--at", afterA]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /合入/);

    assert.equal(attest(repo, "task/b").status, 0);
    assert.equal(status(repo, "task/b").status, 0);
  });

  test("--at 必须是当前主分支的祖先", () => {
    const repo = setup();
    task(repo, "task/a");
    deliver(repo, "task/a");
    const unmerged = repo.branch("task/c", { "src/c.js": "c\n" });
    const refused = attest(repo, "task/a", ["--at", unmerged]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /祖先|主分支/);
    assert.equal(status(repo, "task/a").status, 1);
  });

  test("非快进合并同样到期并可关闭", () => {
    const repo = setup();
    task(repo, "task/a");
    gate(repo, "task/a");
    commit(repo.root, "feat(main): 推进主分支\n\n- 增加另一处改动\n- 制造三方合并", { "src/main.js": "main\n" });
    const merged = repo.cli("merge", "--branch", "task/a");
    assert.equal(merged.status, 0, merged.stderr);
    assert.equal(JSON.parse(merged.stdout).fastForward, false);
    assert.equal(status(repo, "task/a").status, 1);
    assert.equal(attest(repo, "task/a").status, 0);
    assert.equal(status(repo, "task/a").status, 0);
  });

  test("只有 0.16.0 证据、没有义务记录的任务读取时被推导出来，并可关闭", () => {
    const repo = setup();
    task(repo, "task/a");
    deliver(repo, "task/a");
    for (const name of readdirSync(obligationDir(repo))) sh(repo.root, "rm", [join(obligationDir(repo), name)]);

    const pending = status(repo, "task/a");
    assert.equal(pending.status, 1, pending.stdout);
    assert.match(pending.stdout, /合并后验收待完成：release-smoke/);

    assert.equal(attest(repo, "task/a").status, 0);
    assert.equal(status(repo, "task/a").status, 0);
  });

  test("0.16.0 已登记完成的旧任务读取时仍视为完成", () => {
    const repo = setup();
    task(repo, "task/a");
    deliver(repo, "task/a");
    assert.equal(attest(repo, "task/a").status, 0);
    for (const name of readdirSync(obligationDir(repo))) sh(repo.root, "rm", [join(obligationDir(repo), name)]);
    const done = status(repo, "task/a");
    assert.equal(done.status, 0, done.stdout);
    assert.match(done.stdout, /交付与合并后验收均完成/);
  });
});

describe("合并后验收义务：清单判定", () => {
  test("已有义务的分支追加文档提交后可以再次验证", () => {
    const repo = setup();
    task(repo, "task/a");
    deliver(repo, "task/a");
    extend(repo, "task/a", { "docs/a.md": "a\n" });
    const verified = repo.cli("verify", "--branch", "task/a");
    assert.equal(verified.status, 0, verified.stderr);
  });

  test("已有义务的分支改了合并后章节却没有命中检查时仍然失败", () => {
    const repo = setup();
    task(repo, "task/a");
    deliver(repo, "task/a");
    extend(repo, "task/a", { [acceptanceFor("task/a")]: ACCEPTANCE.replace("冒烟脚本通过", "冒烟脚本与回滚演练都通过") });
    const verified = repo.cli("verify", "--branch", "task/a");
    assert.notEqual(verified.status, 0);
    assert.match(verified.stderr, /acceptance:post-merge/);
    assert.doesNotMatch(verified.stderr, /删除该章节/);
  });

  test("没有义务的分支清单有合并后章节却没有命中检查时仍然失败", () => {
    const repo = setup();
    repo.branch("task/a", { "docs/a.md": "a\n", [acceptanceFor("task/a")]: ACCEPTANCE });
    const verified = repo.cli("verify", "--branch", "task/a");
    assert.notEqual(verified.status, 0);
    assert.match(verified.stderr, /acceptance:post-merge/);
  });
});

describe("合并后验收义务：数据", () => {
  test("义务记录按检查与分支顶端分别保存，重复合入不会重新打开已关闭的义务", () => {
    const repo = setup();
    task(repo, "task/a");
    deliver(repo, "task/a");
    assert.equal(attest(repo, "task/a").status, 0);
    const files = readdirSync(obligationDir(repo));
    assert.equal(files.length, 1);
    const record = JSON.parse(readFileSync(join(obligationDir(repo), files[0]), "utf8"));
    assert.equal(record.branch, "task/a");
    assert.equal(record.checkId, "release-smoke");
    assert.ok(record.closedBy.at);

    extend(repo, "task/a", { "docs/a.md": "a\n" });
    deliver(repo, "task/a");
    const done = status(repo, "task/a");
    assert.equal(done.status, 0, "新提交顶端没有命中检查，旧顶端的义务已关闭，不应重新出现待办");
    assert.match(done.stdout, /交付与合并后验收均完成/);
  });
});
