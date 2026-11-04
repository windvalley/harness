import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
function fakePlanClaude(repo, { structured, touch, events = [] } = {}) {
  const bin = join(repo.root, "..", "fake-plan-claude.mjs");
  const log = join(repo.root, "..", "plan-call.json");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd() }));
${touch ? `writeFileSync(${JSON.stringify(touch)}, "changed\\n");` : ""}
const result = { is_error: false, total_cost_usd: 0.02, structured_output: ${JSON.stringify(structured ?? { findings: [] })}, modelUsage: { sonnet: {} } };
if (process.argv.includes("stream-json")) {
  for (const event of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(event) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", ...result }) + "\\n");
} else process.stdout.write(JSON.stringify(result));
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

  test("首个评审者无输出时报告等待，单次超时后在总时限内回退", () => {
    const repo = setup();
    writeReviewers(repo, { reviewers: [
      { name: "slow", client: "command", command: ["sh", "-c", "sleep 60 & wait"] },
      { name: "backup", client: "command", command: [process.execPath, "-e", 'console.log(JSON.stringify({findings: []}))'] },
    ] });
    const result = repo.cli("review-plan", "--branch", "task/a", "--timeout-seconds", "6", "--attempt-timeout-seconds", "10");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /slow.*已运行.*剩余.*尚无过程输出/);
    assert.match(result.stderr, /slow.*单次评审超时/);
    assert.match(result.stderr, /方案评审完成: backup/);
    assert.equal(ledger(repo).find((item) => item.event === "plan.review").reviewer, "backup");
  });

  test("总时限耗尽时给出明确原因，且不写成功事件", () => {
    const repo = setup();
    writeReviewers(repo, { reviewers: [
      { name: "slow", client: "command", command: ["sh", "-c", "exec sleep 60"] },
    ] });
    const result = repo.cli("review-plan", "--branch", "task/a", "--timeout-seconds", "1");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /方案评审总时限耗尽/);
    assert.ok(!ledger(repo).some((item) => item.event === "plan.review"));
  });

  test("Claude 的流式事件显示阶段，结论取自 result，过程内容不输出", () => {
    const repo = setup();
    const call = fakePlanClaude(repo, { structured: { findings: [HIGH] }, events: [
      { type: "system", subtype: "init" },
      { type: "stream_event", event: { type: "message_start" } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", id: "r1", input: { file_path: "PRIVATE-PATH" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "r1", content: "PRIVATE-CONTENT" }] } },
      { type: "system", subtype: "api_retry", error: "PRIVATE-ERROR" },
    ] });
    const result = repo.cli("review-plan", "--branch", "task/a");
    assert.equal(result.status, 0, result.stderr);
    assert.ok(call().args.includes("stream-json"));
    assert.match(result.stderr, /评审会话已初始化[\s\S]*收到首个模型响应[\s\S]*仓库查询开始（Read）[\s\S]*仓库查询结束（Read）[\s\S]*模型请求重试[\s\S]*方案评审完成/);
    assert.doesNotMatch(result.stderr, /PRIVATE-/);
    assert.match(result.stderr, /没写超时/);
  });

  test("调用方取消时终止评审进程并跳过备选", { timeout: 15000 }, async () => {
    const repo = setup();
    const marker = join(repo.root, "..", "reviewer.pid");
    writeReviewers(repo, { reviewers: [
      { name: "slow", client: "command", command: ["sh", "-c", 'echo "$$" > "$1"; exec sleep 60', "sh", marker] },
      { name: "backup", client: "command", command: [process.execPath, "-e", 'console.log(JSON.stringify({findings: []}))'] },
    ] });
    const child = spawn(join(repo.root, ".harness/bin/harness"), ["review-plan", "--branch", "task/a"], {
      cwd: repo.root, env: { ...process.env, ...repo.env }, stdio: ["ignore", "ignore", "pipe"],
    });
    const closed = once(child, "close");
    let output = "";
    let reviewerPid;
    try {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { output += chunk; });
      for (let elapsed = 0; elapsed < 5000 && !existsSync(marker) && child.exitCode === null; elapsed += 25) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(existsSync(marker), output);
      reviewerPid = Number(readFileSync(marker, "utf8"));
      child.kill("SIGTERM");
      assert.deepEqual(await closed, [143, null]);
      assert.match(output, /方案评审已取消.*SIGTERM/);
      assert.doesNotMatch(output, /开始评审者 backup|方案评审完成/);
      assert.throws(() => process.kill(reviewerPid, 0), { code: "ESRCH" });
      reviewerPid = undefined;
      assert.ok(!ledger(repo).some((item) => item.event === "plan.review"));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (reviewerPid) {
        try { process.kill(reviewerPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
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

  test("codex 评审者也在任务分支的 Worktree 里运行并读仓库", () => {
    const repo = setup();
    const log = fakeCodex(repo, { findings: [HIGH] }, { events: [
      { type: "thread.started" },
      { type: "turn.started" },
      { type: "item.started", item: { type: "command_execution", command: "PRIVATE-COMMAND" } },
      { type: "item.completed", item: { type: "command_execution", aggregated_output: "PRIVATE-OUTPUT" } },
      { type: "turn.completed" },
    ] });
    writeReviewers(repo, { reviewers: [{ name: "cx", client: "codex" }] });
    const result = repo.cli("review-plan", "--branch", "task/a");
    assert.equal(result.status, 0, result.stderr);
    const call = JSON.parse(readFileSync(log, "utf8"));
    assert.equal(call.cwd, realpathSync(repo.root));
    assert.equal(call.args[call.args.indexOf("--cd") + 1], realpathSync(repo.root));
    assert.equal(call.args[call.args.indexOf("--sandbox") + 1], "read-only");
    assert.match(call.stdin, /PLAN-TEXT/);
    assert.ok(call.schema.properties.findings);
    assert.ok(call.args.includes("--json"));
    assert.match(result.stderr, /评审回合已开始[\s\S]*评审命令开始[\s\S]*评审命令结束[\s\S]*评审回合已结束[\s\S]*可读仓库/);
    assert.doesNotMatch(result.stderr, /PRIVATE-/);
    assert.equal(ledger(repo).find((item) => item.event === "plan.review").readsRepo, true);
  });

  test("command 评审者在任务分支的 Worktree 里运行，改了文件同样不采信", () => {
    const repo = setup();
    const dir = join(repo.root, "..");
    const log = join(dir, "command-call.json");
    const bin = join(dir, "fake-command-reviewer");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const stdin = readFileSync(0, "utf8");
writeFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), stdin }));
writeFileSync("command-stray.txt", "changed\\n");
process.stdout.write(JSON.stringify(${JSON.stringify({ findings: [HIGH] })}));
`,
    );
    chmodSync(bin, 0o755);
    writeReviewers(repo, { reviewers: [{ name: "cmd", client: "command", command: [bin] }] });
    const result = repo.cli("review-plan", "--branch", "task/a");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /改动了工作区/);
    const call = JSON.parse(readFileSync(log, "utf8"));
    assert.equal(call.cwd, realpathSync(repo.root));
    assert.match(call.stdin, /PLAN-TEXT/);
  });
});
