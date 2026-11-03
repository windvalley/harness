import { strict as assert } from "node:assert";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fakeClaudes, fakeCodex, git, makeRepo, writeReviewers } from "./helpers.mjs";
import { parsePlanReview, PLAN_REVIEW_SCHEMA } from "../src/plan/planreview.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

const PLAN_FILES = {
  ".harness/acceptance/task-a.md": "- 验收条目 ACCEPT-TEXT\n",
  "docs/changes/a/spec.md": "SPEC-TEXT\n",
  "docs/changes/a/plan.md": "PLAN-TEXT\n",
};

const HIGH = { severity: "high", category: "failure-path", ref: "docs/changes/a/plan.md", summary: "没写超时", scenario: "评审进程挂起时没有退出路径", suggestion: "补超时处理" };
const LOW = { severity: "low", category: "other", ref: "docs/changes/a/spec.md", summary: "措辞含糊", scenario: "读者可能理解成两种含义" };

function setup(files = PLAN_FILES) {
  const repo = makeRepo();
  repos.push(repo);
  repo.branch("task/a", files);
  git(repo.root, "checkout", "-q", "task/a");
  return repo;
}

/** 记录参数、提示与工作目录的假 claude；touch 指定时模拟评审者改了工作区里的文件。 */
function fakePlanClaude(repo, { structured, touch } = {}) {
  const bin = join(repo.root, "..", "fake-plan-claude.mjs");
  const log = join(repo.root, "..", "plan-call.json");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd() }));
${touch ? `writeFileSync(${JSON.stringify(touch)}, "changed\\n");` : ""}
process.stdout.write(JSON.stringify({ is_error: false, total_cost_usd: 0.02, structured_output: ${JSON.stringify(structured ?? { findings: [] })}, modelUsage: { sonnet: {} } }));
`,
  );
  chmodSync(bin, 0o755);
  repo.env.HARNESS_REVIEWER_BIN = bin;
  return () => JSON.parse(readFileSync(log, "utf8"));
}

function ledger(repo) {
  const file = join(repo.env.HARNESS_DATA_DIR, "ledger.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

describe("方案评审", () => {
  test("parsePlanReview 只认完整的发现结构，没有 verdict 字段", () => {
    assert.ok(!("verdict" in PLAN_REVIEW_SCHEMA.properties));
    assert.doesNotThrow(() => parsePlanReview({ findings: [HIGH, LOW] }));
    assert.throws(() => parsePlanReview(null));
    assert.throws(() => parsePlanReview({}), /findings/);
    assert.throws(() => parsePlanReview({ findings: [{ ...HIGH, severity: "urgent" }] }), /severity/);
    assert.throws(() => parsePlanReview({ findings: [{ ...HIGH, category: "mood" }] }), /category/);
    assert.throws(() => parsePlanReview({ findings: [{ ...HIGH, scenario: " " }] }), /scenario/);
  });

  test("提示含三份方案文件，claude 评审者能读仓库但没有写入类工具", () => {
    const repo = setup();
    const call = fakePlanClaude(repo);
    const result = repo.cli("review-plan", "--branch", "task/a");
    assert.equal(result.status, 0, result.stderr);
    const { args, prompt } = call();
    for (const text of ["ACCEPT-TEXT", "SPEC-TEXT", "PLAN-TEXT"]) assert.match(prompt, new RegExp(text));
    const at = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(at("--tools"), "Read,Grep,Glob,Bash");
    assert.equal(at("--permission-mode"), "dontAsk");
    assert.doesNotMatch(at("--tools"), /Edit|Write|NotebookEdit/);
    assert.doesNotMatch(at("--allowedTools"), /Edit|Write|NotebookEdit/);
    const denied = args.slice(args.indexOf("--disallowedTools") + 1);
    assert.ok(denied.some((rule) => /\.env/.test(rule)), "应按文件名屏蔽 .env");
    assert.ok(denied.some((rule) => /\.pem|id_rsa|credentials/.test(rule)), "应按文件名屏蔽密钥类文件");
    const schema = JSON.parse(at("--json-schema"));
    assert.ok(schema.properties.findings && !schema.properties.verdict);
    assert.match(at("--system-prompt"), /方案/);
    assert.match(result.stderr, /读仓库/);
  });

  test("high 及以上逐条展示，其余只给数量，--all 才全部展示", () => {
    const repo = setup();
    fakePlanClaude(repo, { structured: { findings: [HIGH, LOW] } });
    const result = repo.cli("review-plan", "--branch", "task/a");
    assert.equal(result.status, 0);
    assert.match(result.stderr, /\[high\].*没写超时/);
    assert.doesNotMatch(result.stderr, /措辞含糊/);
    assert.match(result.stderr, /另有 1 条.*low/);
    const all = repo.cli("review-plan", "--branch", "task/a", "--all");
    assert.match(all.stderr, /措辞含糊/);
  });

  test("不写评审与证据记录，只追加 plan.review 账本事件", () => {
    const repo = setup();
    fakePlanClaude(repo, { structured: { findings: [HIGH, LOW] } });
    assert.equal(repo.cli("review-plan", "--branch", "task/a").status, 0);
    const head = git(repo.root, "rev-parse", "HEAD");
    assert.ok(!existsSync(join(repo.env.HARNESS_DATA_DIR, "review", `${head}.json`)));
    assert.ok(!existsSync(join(repo.env.HARNESS_DATA_DIR, "evidence", `${head}.json`)));
    const events = ledger(repo).filter((item) => item.event === "plan.review");
    assert.equal(events.length, 1);
    assert.equal(events[0].branch, "task/a");
    assert.equal(events[0].findings.high, 1);
    assert.equal(events[0].findings.low, 1);
    assert.equal(events[0].readsRepo, true);
  });

  test("前一个评审者输出不合格时换下一个", () => {
    const repo = setup();
    writeReviewers(repo, {
      preferDifferentModel: false,
      reviewers: [
        { name: "first", client: "claude", model: "bad-model" },
        { name: "second", client: "claude", model: "good-model" },
      ],
    });
    const claudes = fakeClaudes(repo, {
      "bad-model": { mode: "ok", structured: { verdict: "approve" } },
      "good-model": { mode: "ok", structured: { findings: [HIGH] } },
    });
    const result = repo.cli("review-plan", "--branch", "task/a");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(claudes.calls().map((call) => call.model), ["bad-model", "good-model"]);
    assert.match(result.stderr, /没写超时/);
  });

  test("没有可用评审者时非 0 退出并说明原因，不影响分支", () => {
    const repo = setup();
    writeReviewers(repo, { reviewers: [{ name: "ghost", client: "command", command: ["harness-no-such-reviewer-bin"] }] });
    const result = repo.cli("review-plan", "--branch", "task/a");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /没有评审者给出结论/);
    assert.equal(ledger(repo).filter((item) => item.event === "plan.review").length, 0);
  });

  test("评审者改动了工作区时不采信这次结果", () => {
    const repo = setup();
    fakePlanClaude(repo, { structured: { findings: [HIGH] }, touch: join(repo.root, "stray.txt") });
    const result = repo.cli("review-plan", "--branch", "task/a");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /改动了工作区/);
    assert.doesNotMatch(result.stderr, /没写超时/);
    assert.equal(ledger(repo).filter((item) => item.event === "plan.review").length, 0);
  });

  test("分支上没有方案文件时拒绝", () => {
    const repo = setup({ "a.txt": "a\n" });
    fakePlanClaude(repo);
    const result = repo.cli("review-plan", "--branch", "task/a");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /没有.*方案/);
  });

  test("codex 评审者在空目录里只读方案文件，不读仓库，并如实说明", () => {
    const repo = setup();
    const log = fakeCodex(repo, { findings: [HIGH] });
    writeReviewers(repo, { reviewers: [{ name: "cx", client: "codex" }] });
    const result = repo.cli("review-plan", "--branch", "task/a");
    assert.equal(result.status, 0, result.stderr);
    const call = JSON.parse(readFileSync(log, "utf8"));
    assert.notEqual(call.cwd, repo.root);
    assert.match(call.stdin, /PLAN-TEXT/);
    assert.ok(call.schema.properties.findings);
    assert.match(result.stderr, /没有读仓库/);
    assert.equal(ledger(repo).find((item) => item.event === "plan.review").readsRepo, false);
  });
});
