import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fakeClaudes, fakeCodex, git, makeRepo, writeReviewers } from "./helpers.mjs";
import {
  DEFAULT_PLAN_ATTEMPT_TIMEOUT_SECONDS,
  DEFAULT_PLAN_TIMEOUT_SECONDS,
  parsePlanReview,
  DEFAULT_PLAN_MAX_QUERIES,
  PLAN_REVIEW_SCHEMA,
} from "../src/plan/planreview.mjs";
import { extractRefs, isSecretPath } from "../src/plan/refs.mjs";

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
function fakePlanClaude(repo, { structured, touch, events = [], repoToolUses = 0 } = {}) {
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
  if (process.argv.includes("Read,Grep,Glob,Bash")) {
    for (let i = 0; i < ${repoToolUses}; i++) {
      process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", id: "q" + i, input: {} }] } }) + "\\n");
    }
  }
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
  test("默认总时限为 20 分钟，单次上限为 10 分钟，读仓库最多 15 次", () => {
    assert.equal(DEFAULT_PLAN_TIMEOUT_SECONDS, 1200);
    assert.equal(DEFAULT_PLAN_ATTEMPT_TIMEOUT_SECONDS, 600);
    assert.equal(DEFAULT_PLAN_MAX_QUERIES, 15);
  });

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

  test("明确失败时立即切换到备选，不等待单次时限", () => {
    const repo = setup();
    writeReviewers(repo, { reviewers: [
      { name: "first", client: "command", command: [process.execPath, "-e", "process.stderr.write('failed'); process.exit(1)"] },
      { name: "backup", client: "command", command: [process.execPath, "-e", "console.log(JSON.stringify({findings: []}))"] },
    ] });
    const result = repo.cli("review-plan", "--branch", "task/a", "--timeout-seconds", "6", "--attempt-timeout-seconds", "5");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /first 失败，换下一个/);
    assert.doesNotMatch(result.stderr, /单次评审超时/);
    assert.match(result.stderr, /方案评审完成: backup/);
  });

  test("只为一次回退预留时间，不按全部候选者均分", () => {
    const repo = setup();
    const failingCommand = [process.execPath, "-e", "process.exit(1)"];
    writeReviewers(repo, { reviewers: [
      { name: "first", client: "command", command: failingCommand },
      { name: "second", client: "command", command: failingCommand },
      { name: "third", client: "command", command: failingCommand },
    ] });
    const result = repo.cli("review-plan", "--branch", "task/a", "--timeout-seconds", "6", "--attempt-timeout-seconds", "10");
    assert.equal(result.status, 1);
    const starts = result.stderr.split("\n").filter((line) => line.includes("开始评审者"));
    assert.equal(starts.length, 3);
    assert.match(starts[0], /本次时限 3 秒/);
    assert.match(starts[1], /本次时限 6 秒/);
    assert.match(starts[2], /本次时限 6 秒/);
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

  test("流式输出区分思考、正文与结论并累计字符数，不输出内容", () => {
    const repo = setup();
    const delta = (type, field, value) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type, [field]: value } } });
    fakePlanClaude(repo, { events: [
      { type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } },
      delta("thinking_delta", "thinking", "PRIVATE-AAAA"),
      delta("thinking_delta", "thinking", "BBBB"),
      { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } },
      delta("text_delta", "text", "PRIVATE-CC"),
      { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "StructuredOutput" } } },
      delta("input_json_delta", "partial_json", "PRIVATE-{}"),
    ] });
    const result = repo.cli("review-plan", "--branch", "task/a");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /模型输出思考（累计 12 字符）[\s\S]*模型输出正文（累计 10 字符）[\s\S]*模型输出结论（累计 10 字符）/);
    assert.doesNotMatch(result.stderr, /模型输出思考（累计 16 字符）/);
    assert.doesNotMatch(result.stderr, /PRIVATE-/);
  });

  test("方案里的代码引用被预取进提示，密钥类、方案自身与不存在的路径不预取", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const repo = setup({
      ...PLAN_FILES,
      "docs/changes/a/plan.md": "复用 [x](../../../src/foo.mjs#L20) 与 foo.mjs:90，不要碰 frontend/.env.production、missing.go#L3 和 docs/changes/a/spec.md\n",
      "src/foo.mjs": lines,
      "frontend/.env.production": "SECRET-VALUE\n",
    });
    const call = fakePlanClaude(repo);
    const result = repo.cli("review-plan", "--branch", "task/a");
    assert.equal(result.status, 0, result.stderr);
    const { prompt } = call();
    assert.match(prompt, /## 方案引用的现有代码片段/);
    assert.match(prompt, /### src\/foo\.mjs:5-65\n[\s\S]*line 20\n[\s\S]*line 65\n/);
    assert.match(prompt, /### src\/foo\.mjs:75-100\n/);
    const fetched = prompt.slice(prompt.indexOf("## 方案引用的现有代码片段"));
    assert.doesNotMatch(prompt, /SECRET-VALUE/);
    assert.doesNotMatch(fetched, /missing\.go|\.env|### docs\/changes/);
    assert.match(result.stderr, /预取引用片段 2 个/);
  });

  test("引用提取支持行号与行区间，识别密钥类路径", () => {
    const text = "见 a/b.go#L12-L30、c.go:7、d.md，忽略 https://x.com/e.go，相对链接 [x](../../src/f.go#L9) 与 ../../../../outside.go";
    assert.deepEqual(extractRefs([{ path: "docs/changes/a/plan.md", text }]), [
      { path: "a/b.go", start: 12, end: 30 },
      { path: "c.go", start: 7, end: 7 },
      { path: "d.md", start: null, end: null },
      { path: "docs/src/f.go", start: 9, end: 9 },
    ]);
    for (const path of [".env", "a/.env.production", "k.pem", "a/id_rsa.pub", "x/credentials.json"]) assert.ok(isSecretPath(path), path);
    assert.ok(!isSecretPath("src/foo.mjs"));
  });

  test("仓库查询超过上限时终止，同一评审者降级为不读仓库重试并标注", () => {
    const repo = setup();
    const call = fakePlanClaude(repo, { structured: { findings: [HIGH] }, repoToolUses: DEFAULT_PLAN_MAX_QUERIES + 1 });
    const result = repo.cli("review-plan", "--branch", "task/a");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`仓库查询超过 ${DEFAULT_PLAN_MAX_QUERIES} 次，改为不读仓库重试`));
    assert.match(result.stderr, /仓库查询超限，改为只看方案文件与预取片段/);
    const { args, prompt } = call();
    assert.equal(args[args.indexOf("--tools") + 1], "");
    assert.match(prompt, /你看不到仓库/);
    const event = ledger(repo).find((item) => item.event === "plan.review");
    assert.equal(event.readsRepo, false);
    assert.equal(event.queryLimited, true);
  });

  test("--max-queries 调整上限并写进提示，非法值被拒绝", () => {
    const repo = setup();
    const call = fakePlanClaude(repo, { repoToolUses: 4 });
    const result = repo.cli("review-plan", "--branch", "task/a", "--max-queries", "3");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /最多查询 3 次/);
    assert.match(result.stderr, /仓库查询超过 3 次，改为不读仓库重试/);
    assert.match(call().prompt, /你看不到仓库/);
    for (const bad of ["0", "101", "x", "1.5"]) {
      const rejected = repo.cli("review-plan", "--branch", "task/a", "--max-queries", bad);
      assert.equal(rejected.status, 2, bad);
      assert.match(rejected.stderr, /--max-queries 必须是 1 到 100 的整数/);
    }
  });

  test("查询次数没超上限时保持读仓库，不降级", () => {
    const repo = setup();
    const call = fakePlanClaude(repo, { repoToolUses: DEFAULT_PLAN_MAX_QUERIES });
    const result = repo.cli("review-plan", "--branch", "task/a");
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /改为不读仓库重试/);
    assert.equal(call().args[call().args.indexOf("--tools") + 1], "Read,Grep,Glob,Bash");
    assert.equal(ledger(repo).find((item) => item.event === "plan.review").readsRepo, true);
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
