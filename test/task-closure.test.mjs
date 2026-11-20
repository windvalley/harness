import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { APPROVE, commit, fakeReviewer, git, makeRepo } from "./helpers.mjs";

const repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos.length = 0;
});

function setup(checks) {
  const repo = makeRepo({
    project: {
      ".harness/verify.json": {
        version: 1,
        docOnly: { match: ["docs/**", "**/*.md"], exclude: [] },
        checks,
        fullSuiteTriggers: { paths: [] },
      },
    },
  });
  repos.push(repo);
  return repo;
}

function record(repo, kind, key) {
  return JSON.parse(readFileSync(join(repo.env.HARNESS_DATA_DIR, kind, `${key}.json`), "utf8"));
}

function attest(repo, check = "browser") {
  const report = join(repo.root, "..", `${check}-report.md`);
  writeFileSync(report, "browser passed\n");
  return repo.cli("attest", "--branch", "task/a", "--check", check, "--command", "run browser", "--report", report);
}

const CHECKS = [
  { id: "unit", tier: "gate", when: ["src/**"], cmd: ["node", "-e", "process.exit(0)"] },
  { id: "browser", tier: "extended", when: ["src/**"], reason: "真实浏览器", howToVerify: "运行浏览器验收" },
  { id: "integrated", tier: "extended", phase: "post-merge", when: ["src/**"], reason: "集成环境", howToVerify: "合并后冒烟" },
];

test("必需证据在评审前预检，补登记后同一提交可以正式评审", () => {
  const repo = setup(CHECKS);
  repo.branch("task/a", {
    "src/a.js": "a\n",
    ".harness/acceptance/task-a.md": '- 行为正确\n\n<!-- harness:evidence id="browser" phase="pre-merge" -->\n',
  });
  assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
  fakeReviewer(repo, APPROVE);
  const blocked = repo.cli("review", "--branch", "task/a", "--json");
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  const preflight = JSON.parse(blocked.stdout);
  assert.equal(preflight.outcome, "preflight_blocked");
  assert.equal(preflight.code, "evidence_incomplete");
  assert.equal(preflight.problems[0].id, "browser");
  assert.equal(existsSync(join(repo.root, "..", "prompt.log")), false, "预检失败不能调用评审者");

  assert.equal(attest(repo).status, 0);
  assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
  const reviewed = repo.cli("review", "--branch", "task/a", "--json");
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.equal(JSON.parse(reviewed.stdout).outcome, "completed");
});

test("未知必需检查与错误阶段会被拒绝，未声明的 extended 不阻断", () => {
  const repo = setup(CHECKS);
  repo.branch("task/a", {
    "src/a.js": "a\n",
    ".harness/acceptance/task-a.md": '<!-- harness:evidence id="unknown" phase="pre-merge" -->\n<!-- harness:evidence id="integrated" phase="post-merge" -->\n',
  });
  assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
  fakeReviewer(repo, APPROVE);
  const blocked = repo.cli("review", "--branch", "task/a", "--json");
  assert.equal(blocked.status, 1);
  assert.match(JSON.parse(blocked.stdout).problems[0].reason, /不是 verify\.json 里的 extended 检查/);

  git(repo.root, "checkout", "-q", "task/a");
  commit(repo.root, "docs: 只保留合法的合并后声明\n\n- 修正必需证据声明", {
    ".harness/acceptance/task-a.md": '<!-- harness:evidence id="integrated" phase="post-merge" -->\n',
  });
  git(repo.root, "checkout", "-q", "main");
  const verified = repo.cli("verify", "--branch", "task/a");
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  const reviewed = repo.cli("review", "--branch", "task/a");
  assert.equal(reviewed.status, 0, reviewed.stdout + reviewed.stderr);
});

test("必需外部证据在实际集成结果中过期时，已有 approve 也不能合并", () => {
  const checks = [
    { ...CHECKS[0], when: ["src/task.js"] },
    CHECKS[1],
  ];
  const repo = setup(checks);
  repo.branch("task/a", {
    "src/task.js": "task\n",
    ".harness/acceptance/task-a.md": '<!-- harness:evidence id="browser" phase="pre-merge" -->\n',
  });
  assert.equal(attest(repo).status, 0);
  assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
  fakeReviewer(repo, APPROVE);
  assert.equal(repo.cli("review", "--branch", "task/a").status, 0);
  commit(repo.root, "feat: 主分支更新共享实现", { "src/shared.js": "shared\n" });
  const status = JSON.parse(repo.cli("status", "--branch", "task/a", "--json").stdout);
  assert.equal(status.codes.includes("evidence_incomplete"), true, "过期必需证据在交付前就标为缺失");
  const merged = repo.cli("merge", "--branch", "task/a");
  assert.equal(merged.status, 1, merged.stdout + merged.stderr);
  assert.match(merged.stderr, /evidence_incomplete/);
  assert.match(merged.stderr, /browser/);
});

test("新任务尚未提交时，定向验证也会选中相对 HEAD 的未提交修改", () => {
  const checks = [{
    id: "unit",
    tier: "gate",
    when: ["src/**"],
    cmd: ["node", "-e", "process.exit(require('fs').readFileSync('src/a.js','utf8').includes('ok') ? 0 : 1)"],
  }];
  const repo = setup(checks);
  commit(repo.root, "feat: 添加待修改实现\n\n- 建立新任务基线", { "src/a.js": "bad\n" });
  git(repo.root, "checkout", "-q", "-b", "task/a");
  writeFileSync(join(repo.root, "src/a.js"), "ok\n");
  const targeted = repo.cli("verify", "--check", "unit", "--json");
  assert.equal(targeted.status, 0, targeted.stdout + targeted.stderr);
  assert.equal(JSON.parse(targeted.stdout).source, "worktree");
});

test("定向验证与探索性评审不覆盖正式证据，定向默认读取工作区", () => {
  const checks = [{
    id: "unit",
    tier: "gate",
    when: ["src/**"],
    cmd: ["node", "-e", "process.exit(require('fs').readFileSync('src/a.js','utf8').includes('ok') ? 0 : 1)"],
  }];
  const repo = setup(checks);
  const head = repo.branch("task/a", { "src/a.js": "bad\n" });
  assert.equal(repo.cli("verify", "--branch", "task/a").status, 1);
  git(repo.root, "checkout", "-q", "task/a");
  writeFileSync(join(repo.root, "src/a.js"), "ok\n");
  const targeted = repo.cli("verify", "--check", "unit", "--json");
  assert.equal(targeted.status, 0, targeted.stdout + targeted.stderr);
  assert.equal(JSON.parse(targeted.stdout).source, "worktree");
  assert.equal(record(repo, "evidence", head).status, "failed", "定向通过不能改写正式失败证据");

  commit(repo.root, "fix: 修复工作区行为\n\n- 让定向与正式验证一致", { "src/a.js": "ok\n" });
  git(repo.root, "checkout", "-q", "main");
  const formalHead = git(repo.root, "rev-parse", "task/a");
  assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
  fakeReviewer(repo, APPROVE);
  assert.equal(repo.cli("review", "--branch", "task/a").status, 0);
  const formalEvidence = record(repo, "evidence", formalHead);
  const formalReview = record(repo, "review", formalHead);

  git(repo.root, "checkout", "-q", "task/a");
  writeFileSync(join(repo.root, "src/a.js"), "bad\n");
  assert.equal(repo.cli("verify", "--check", "unit").status, 1);
  assert.equal(repo.cli("review", "--branch", "task/a", "--exploratory", "--json").status, 0);
  assert.deepEqual(record(repo, "evidence", formalHead), formalEvidence);
  assert.deepEqual(record(repo, "review", formalHead), formalReview);
  assert.equal(record(repo, "review-exploratory", formalHead).outcome, "exploratory");
});
