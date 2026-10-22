import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, fakeReviewer, git, makeRepo, sh } from "./helpers.mjs";
import { blockingFindings, buildPrompt, parseVerdict } from "../src/review/review.mjs";
import { validateEscalation } from "../src/escalate/escalate.mjs";
import { computeMetrics, formatMetrics } from "../src/golden/metrics.mjs";

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

describe("评审", () => {
  test("blockingFindings 只按配置级别阻断", () => {
    const findings = [{ severity: "low" }, { severity: "high" }, { severity: "medium" }, { severity: "critical" }];
    assert.equal(blockingFindings(findings, ["high", "critical"]).length, 2);
    assert.equal(blockingFindings(findings, ["critical"]).length, 1);
  });

  test("parseVerdict 拒绝缺字段的输出", () => {
    assert.throws(() => parseVerdict(null));
    assert.throws(() => parseVerdict({ verdict: "maybe", findings: [] }));
    assert.throws(() => parseVerdict({ verdict: "approve" }));
    assert.doesNotThrow(() => parseVerdict(APPROVE));
  });

  test("提示里区分清单来源，没有清单时明确说明", () => {
    const fromMain = buildPrompt({ acceptance: { source: "main", text: "验收 1" }, evidence: "e", diff: "d", branch: "b" });
    assert.match(fromMain, /主分支已确认/);
    const fromBranch = buildPrompt({ acceptance: { source: "branch", text: "验收 2" }, evidence: "e", diff: "d", branch: "b" });
    assert.match(fromBranch, /未经人工确认/);
    const none = buildPrompt({ acceptance: null, evidence: "e", diff: "d", branch: "b" });
    assert.match(none, /未提供验收清单/);
  });

  test("有清单却评 unknown 时拒绝，没有清单时 unknown 不阻断", async () => {
    const repo = setup();
    repo.branch("task/a", { "a.txt": "a\n", ".harness/acceptance/task-a.md": "- 验收\n" });
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    fakeReviewer(repo, { ...APPROVE, requirementFit: { rating: "unknown", evidence: "看不出来" } });
    assert.equal(repo.cli("review", "--branch", "task/a").status, 1);

    const repo2 = setup();
    repo2.branch("task/b", { "b.txt": "b\n" });
    assert.equal(repo2.cli("verify", "--branch", "task/b").status, 0);
    fakeReviewer(repo2, { ...APPROVE, requirementFit: { rating: "unknown", evidence: "无清单" } });
    assert.equal(repo2.cli("review", "--branch", "task/b").status, 0);
  });

  test("diff 过大时拒绝评审", () => {
    const repo = setup();
    repo.branch("task/big", { "big.txt": "x".repeat(200_000) });
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("verify", "--branch", "task/big").status, 0);
    const review = repo.cli("review", "--branch", "task/big");
    assert.equal(review.status, 1);
    assert.match(review.stderr, /超过独立评审上限/);
  });

  test("没有验证证据时拒绝评审", () => {
    const repo = setup();
    repo.branch("task/a", { "a.txt": "a\n" });
    fakeReviewer(repo, APPROVE);
    const review = repo.cli("review", "--branch", "task/a");
    assert.equal(review.status, 1);
    assert.match(review.stderr, /必须先有通过的验证证据/);
  });
});

describe("例外上报", () => {
  const VALID = {
    situation: "审批超时应当拒绝还是自动通过",
    attempted: ["读了逻辑", "查了历史"],
    blocker: "两处行为不一致",
    options: [
      { id: "reject", summary: "超时视为拒绝" },
      { id: "approve", summary: "超时视为通过" },
    ],
    defaultAction: "reject",
    resumeHint: "改 timeout 逻辑",
  };

  test("缺必填项或选项不足时报错", () => {
    assert.throws(() => validateEscalation({ ...VALID, blocker: "" }), /blocker/);
    assert.throws(() => validateEscalation({ ...VALID, options: [{ id: "a", summary: "x" }] }), /至少给出两个/);
    assert.throws(() => validateEscalation({ ...VALID, defaultAction: "nope" }), /defaultAction/);
  });

  test("创建、答复、续跑的完整流程", () => {
    const repo = setup();
    const opened = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["escalate", "open"], repo.env, JSON.stringify(VALID));
    assert.equal(opened.status, 0, opened.stderr);
    const id = JSON.parse(opened.stdout).id;
    assert.match(id, /^esc-[0-9a-f]{8}$/);

    const pending = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["escalate", "resume", "--id", id], repo.env);
    assert.equal(pending.status, 1);

    assert.equal(sh(repo.root, join(repo.root, ".harness/bin/harness"), ["escalate", "answer", "--id", id, "--choice", "approve"], repo.env).status, 0);
    const plan = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["escalate", "resume", "--id", id], repo.env);
    assert.equal(plan.status, 0);
    assert.equal(JSON.parse(plan.stdout).chosen.summary, "超时视为通过");
  });

  test("非法编号不能越出上报目录", () => {
    const repo = setup();
    const result = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["escalate", "answer", "--id", "../../etc/passwd", "--choice", "x"], repo.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /非法上报编号/);
  });
});

describe("度量", () => {
  const at = (day) => `2026-10-${String(day).padStart(2, "0")}T08:00:00.000Z`;

  test("验证首过率按 tree 的第一次结果计算，复用数单独统计", () => {
    const events = [
      { at: at(5), event: "verify", status: "failed", tree: "t1" },
      { at: at(6), event: "verify", status: "passed", tree: "t1", reused: 2 },
      { at: at(6), event: "verify", status: "passed", tree: "t2" },
    ];
    const { total } = computeMetrics(events);
    assert.equal(total.verifyTrees, 2);
    assert.equal(total.verifyFirstPass, 1);
    assert.equal(total.verifyFirstPassRate, 0.5);
    assert.equal(total.verifyReused, 2);
  });

  test("按周分组，无数据时比率为空", () => {
    const metrics = computeMetrics([
      { at: at(5), event: "merge" },
      { at: at(14), event: "merge" },
      { at: at(14), event: "confirm.approve" },
    ]);
    assert.equal(metrics.weeks.length, 2);
    assert.equal(metrics.total.confirmations, 1);
    assert.equal(metrics.total.verifyFirstPassRate, null);
  });

  test("表格包含门禁确认与复用列", () => {
    const text = formatMetrics(computeMetrics([{ at: at(5), event: "verify", status: "passed", tree: "t", reused: 1 }]));
    assert.match(text, /复用检查/);
    assert.match(text, /门禁确认/);
  });
});

describe("L3 判据", () => {
  test("conformance 逐项输出，样本不足的项标 PEND", () => {
    const repo = setup();
    const result = repo.cli("conformance");
    assert.equal(result.status, 0, result.stderr);
    for (const id of ["intent", "context", "harness", "execution", "eval", "governance", "stability"]) {
      assert.match(result.stdout, new RegExp(id), id);
    }
    assert.match(result.stdout, /PEND/);
    assert.match(result.stdout, /样本不足/);
  });

  test("关闭必要条件时 governance 判据失败", () => {
    const repo = setup({
      project: {
        ".harness/config.json": {
          version: 1,
          mainBranch: "main",
          verify: { timeoutSeconds: 60 },
          merge: { requireEvidence: false, requireReview: false },
          review: { blockSeverities: ["high"] },
          intent: { mode: "checklist" },
          governance: { confirmOnGateChange: false },
          escalate: { triggers: [] },
          env: {},
        },
      },
    });
    const result = repo.cli("conformance");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /FAIL governance/);
  });
});

describe("评审的拆分提示", () => {
  test("diff 过大时给出按目录的分组建议", async () => {
    const { splitSuggestion } = await import("../src/review/review.mjs");
    const repo = setup();
    repo.branch("task/big", {
      "backend/a.js": "x".repeat(120_000),
      "frontend/b.vue": "y".repeat(120_000),
    });
    const base = git(repo.root, "merge-base", "main", "task/big");
    const head = git(repo.root, "rev-parse", "task/big");
    const suggestion = splitSuggestion(repo.root, base, head, 240_000, 50_000);
    assert.match(suggestion, /backend/);
    assert.match(suggestion, /frontend/);
    assert.match(suggestion, /至少拆成 5 次/);

    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("verify", "--branch", "task/big").status, 0);
    const review = repo.cli("review", "--branch", "task/big");
    assert.equal(review.status, 1);
    assert.match(review.stderr, /按目录拆分建议/);
  });
});
