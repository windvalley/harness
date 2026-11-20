import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, CONFIG, fakeReviewer, git, makeRepo, sh, write } from "./helpers.mjs";
import { formatHandoff } from "../src/handoff.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

const BRANCH = "feature/login";
const ACCEPTANCE = ".harness/acceptance/feature-login.md";
const PLAN_POLICY = { version: 1, presets: ["secrets", "git-safety", "gate-self", "plan-first"], disabled: [], rules: [] };

function setup({ plan = false } = {}) {
  const config = plan ? { ...CONFIG, intent: { ...CONFIG.intent, plan: { maxLines: 1 } } } : CONFIG;
  const repo = makeRepo({ project: { ".harness/config.json": config, ...(plan ? { ".harness/policy.json": PLAN_POLICY } : {}) } });
  repos.push(repo);
  return repo;
}

function reviewAndVerify(repo, branch) {
  fakeReviewer(repo, APPROVE);
  const verified = repo.cli("verify", "--branch", branch);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  const reviewed = repo.cli("review", "--branch", branch);
  assert.equal(reviewed.status, 0, reviewed.stdout + reviewed.stderr);
}

function openEscalation(repo, branch, blocker) {
  const result = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["escalate", "open"], repo.env, JSON.stringify({
    situation: "外部浏览器验收尚未完成",
    attempted: ["检查本机浏览器入口"],
    blocker,
    options: [{ id: "wait", summary: "等待环境恢复" }, { id: "manual", summary: "由人执行验收" }],
    defaultAction: "wait",
    resumeHint: "环境恢复后重新执行浏览器验收",
    context: { branch },
  }));
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe("status --handoff", () => {
  test("多阶段进度和非数组上报尝试都进入交接", () => {
    const output = formatHandoff({
      status: {
        branch: BRANCH,
        mainRef: "main",
        delivery: { mode: "local" },
        steps: [{ id: "stages", state: "info", detail: "方案 docs/changes/login/stages.json：已合入 1/2 个阶段，下一阶段 ui" }],
        blockers: ["缺验证证据"],
        ready: false,
      },
      summary: null,
      summaryProblem: "还没有记录用户的实施授权",
      acceptance: { path: ACCEPTANCE, text: null, source: null },
      planFiles: [],
      worktrees: [],
      worktreeProblem: null,
      escalations: { items: [{ id: "esc-12345678", status: "open", blocker: "等待浏览器", situation: "外部验收", attempted: "检查本机入口", defaultAction: "wait" }], problem: null },
    });
    assert.match(output, /stages：方案 docs\/changes\/login\/stages\.json：已合入 1\/2 个阶段，下一阶段 ui/);
    assert.match(output, /已尝试：检查本机入口/);
    assert.match(output, /处理阻塞与注意项/);
  });

  test("真实 CLI 从现有 Git 与签名记录生成完整交接，脱敏且不改变状态", () => {
    const repo = setup({ plan: true });
    const branchHead = repo.branch(BRANCH, {
      [ACCEPTANCE]: "# 登录验收\n\n- 登录失败时保持原会话。\n- 诊断示例不得包含 API_KEY=acceptance-secret。\n",
      "docs/changes/login/spec.md": "# 行为说明\n\n登录失败时保持原会话。\n",
      "docs/changes/login/plan.md": "# 实施方案\n\n先补失败路径测试。\n",
      "src/login.js": "export const login = true;\nexport const session = true;\n",
    });
    const mainHead = git(repo.root, "rev-parse", "main");
    const approved = repo.cli("approve", "--branch", BRANCH, "--yes", "--note", "可以按方案实施，诊断示例 API_KEY=approval-secret");
    assert.equal(approved.status, 0, approved.stderr);
    reviewAndVerify(repo, BRANCH);
    const escalation = openEscalation(repo, BRANCH, "浏览器配置 API_KEY=escalation-secret 不可读取");

    const worktree = join(repo.root, "..", "login-worktree");
    git(repo.root, "worktree", "add", "-q", worktree, BRANCH);
    write(worktree, "src/login.js", "export const login = false;\nexport const session = true;\n");
    write(worktree, "scratch.txt", "未提交说明\n");

    const ordinary = repo.cli("status", "--branch", BRANCH);
    const ledgerFile = join(repo.env.HARNESS_DATA_DIR, "ledger.jsonl");
    const ledgerBefore = readFileSync(ledgerFile, "utf8");
    const worktreeBefore = git(repo.root, "status", "--porcelain");
    const result = repo.cli("status", "--handoff", "--branch", BRANCH);

    assert.equal(result.status, ordinary.status, result.stderr);
    assert.match(result.stdout, /^# 任务交接/m);
    assert.match(result.stdout, new RegExp(branchHead));
    assert.match(result.stdout, new RegExp(mainHead));
    assert.match(result.stdout, /本地交付/);
    assert.match(result.stdout, new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.stdout, /^M src\/login\.js/m);
    assert.match(result.stdout, /\?\? scratch\.txt/);
    assert.match(result.stdout, /docs\/changes\/login\/spec\.md/);
    assert.match(result.stdout, /docs\/changes\/login\/plan\.md/);
    assert.match(result.stdout, /可以按方案实施/);
    assert.match(result.stdout, /登录失败时保持原会话/);
    assert.match(result.stdout, /验证通过/);
    assert.match(result.stdout, /评审通过/);
    assert.match(result.stdout, new RegExp(escalation.id));
    assert.match(result.stdout, /harness status --branch feature\/login/);
    assert.match(result.stdout, /没有结构化记录/);
    assert.match(result.stdout, /API_KEY=\*\*\*/);
    assert.doesNotMatch(result.stdout, /acceptance-secret|approval-secret|escalation-secret/);
    assert.equal(readFileSync(ledgerFile, "utf8"), ledgerBefore, "不生成交接记录或额外账本事件");
    assert.equal(git(repo.root, "status", "--porcelain"), worktreeBefore, "不修改当前 Worktree");
    assert.equal(repo.cli("status", "--branch", BRANCH).stdout, ordinary.stdout, "普通 status 输出保持不变");

    const jsonResult = repo.cli("status", "--handoff", "--branch", BRANCH, "--json");
    assert.equal(jsonResult.status, ordinary.status, jsonResult.stderr);
    const handoff = JSON.parse(jsonResult.stdout);
    assert.match(handoff.acceptance.text, /API_KEY=\*\*\*/);
    assert.doesNotMatch(jsonResult.stdout, /acceptance-secret|approval-secret|escalation-secret/);
  });

  test("缺少清单、授权、证据和 Worktree 时如实保留未决状态", () => {
    const repo = setup({ plan: true });
    repo.branch(BRANCH, { "src/login.js": "export const login = true;\nexport const session = true;\n" });
    const ordinary = repo.cli("status", "--branch", BRANCH);
    const result = repo.cli("status", "--handoff", "--branch", BRANCH);
    assert.equal(result.status, ordinary.status);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /没有验收清单/);
    assert.match(result.stdout, /没有已提交方案/);
    assert.match(result.stdout, /没有有效实施授权/);
    assert.match(result.stdout, /未检出到 Worktree/);
    assert.match(result.stdout, /缺少验证证据/);
    assert.match(result.stdout, /harness verify --branch feature\/login/);
    assert.match(result.stdout, /harness review --branch feature\/login/);
  });

  test("已合入分支的交接显示完成状态，不再建议重复合并", () => {
    const repo = setup();
    const head = repo.branch(BRANCH, {
      [ACCEPTANCE]: "- 登录失败时保持原会话。\n",
      "src/login.js": "export const login = true;\n",
    });
    reviewAndVerify(repo, BRANCH);
    const merged = repo.cli("merge", "--branch", BRANCH);
    assert.equal(merged.status, 0, merged.stdout + merged.stderr);
    const result = repo.cli("status", "--handoff", "--branch", BRANCH);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(head));
    assert.match(result.stdout, /已合入主分支/);
    assert.doesNotMatch(result.stdout, /harness merge --branch feature\/login/);
  });

  test("handoff 与 post-merge 互斥，帮助列出新参数", () => {
    const repo = setup();
    const conflict = repo.cli("status", "--handoff", "--post-merge");
    assert.equal(conflict.status, 2);
    assert.match(conflict.stderr, /不能同时/);
    const help = repo.rawCli("status", "--help");
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--handoff/);
  });
});
