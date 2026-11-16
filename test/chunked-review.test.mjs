import { strict as assert } from "node:assert";
import { describe, test, afterEach } from "node:test";
import { planChunkedDiff, assertChunkCoverage, integrationDiff, chunkedRecordProblem } from "../src/review/chunks.mjs";
import { reviewBranch } from "../src/review/review.mjs";
import { APPROVE, CONFIG, makeRepo, readReviewRecord, writeReview } from "./helpers.mjs";

let repos = [];
afterEach(() => { for (const repo of repos) repo.cleanup(); repos = []; });
const setup = (options = {}) => { const repo = makeRepo(options); repos.push(repo); return repo; };

// 与 repo.cli() 使用相同隔离目录；try/finally 防止测试之间泄露证据、密钥及评审配置。
async function withRepoEnv(repo, task) {
  const saved = Object.fromEntries(Object.keys(repo.env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, repo.env);
  try {
    return await task();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const patch = (path, n = 500) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${n} @@\n` +
  Array.from({ length: n }, (_, i) => `+line-${i}: ${"x".repeat(35)}\n`).join("");

function bigFiles() {
  return Object.fromEntries(Array.from({ length: 6 }, (_, i) =>
    [`module-${i}.txt`, Array.from({ length: 1700 }, (_, n) => `entry-${n} ${"z".repeat(45)}\n`).join("")]));
}

describe("自动分批评审规划", () => {
  test("覆盖每个文件的原始字符且不超过单批预算", () => {
    const diff = ["api", "db", "ui", "worker"].map((name) => patch(`${name}/f.js`, 850)).join("");
    const plan = planChunkedDiff(diff, 70_000);
    assert.ok(plan.chunks.length > 1);
    assert.equal(plan.files.length, 4);
    assert.ok(plan.chunks.every((chunk) => chunk.chars <= plan.budget));
    const coverage = assertChunkCoverage(plan, diff);
    assert.equal(coverage.coveredChars, coverage.totalChars);
    assert.equal(coverage.diffHash, plan.diffHash);
    assert.equal(coverage.complete, true);
  });

  test("单文件跨批时续片不能遗漏一行，且不得悄悄截断", () => {
    const diff = patch("very-big.js", 600);
    const plan = planChunkedDiff(diff, 1_600);
    assert.ok(plan.chunks.length > 10);
    assert.ok(plan.files.length === 1);
    assert.ok(plan.chunks.some((chunk) => chunk.text.includes("连续续片")));
    assert.equal(assertChunkCoverage(plan, diff).coveredChars, diff.length);
    // 注入一个缺口应机械判定失败，而不是依赖模型发现。
    const part = plan.chunks[1].segments[0];
    part.start += 1;
    assert.throws(() => assertChunkCoverage(plan, diff), /遗漏|重叠|不一致/);
  });

  test("无法按行拆分的超长行一律失败关闭", () => {
    const diff = patch("huge-line.js", 2) + "+" + "x".repeat(1_100);
    assert.throws(() => planChunkedDiff(diff, 1_000), /超长行|无法按行拆分/);
  });

  test("二进制变更无法获得源码审查，必须阻断分批评审", () => {
    const binary = "diff --git a/logo.bin b/logo.bin\nBinary files a/logo.bin and b/logo.bin differ\n";
    assert.throws(() => planChunkedDiff(binary, 3_000), /二进制变更/);
  });

  test("校验原始 diff 内容版本，且全局摘要保留全部文件清单", () => {
    const diff = [patch("api/users.js", 30), patch("web/users.js", 35)].join("");
    const plan = planChunkedDiff(diff, 3_000);
    assert.throws(() => assertChunkCoverage(plan, diff + "!"), /不一致/);
    const sample = integrationDiff(plan, 1_200);
    assert.match(sample, /api\/users.js/);
    assert.match(sample, /web\/users.js/);
    assert.ok(sample.length <= 1_200);
    assert.match(sample, /仅为摘录/);
  });

  test("缺失分批或全局证据的签名记录不得视为完整", () => {
    assert.equal(chunkedRecordProblem({ reviewMode: "single" }), null);
    assert.match(chunkedRecordProblem({ reviewMode: "chunked" }), /完整覆盖/);
    const coverage = { complete: true, totalChars: 500, coveredChars: 500,
      diffHash: "a".repeat(64), files: 2, fragments: 2 };
    const chunks = [0, 1].map((index) => ({ index, status: "complete", chars: 200, fragments: 1, verdict: "approve" }));
    const record = { reviewMode: "chunked", chunked: { version: 1, coverage, chunks,
      integration: { status: "complete", verdict: "approve" } } };
    assert.equal(chunkedRecordProblem(record), null);
    record.chunked.integration.status = "failed";
    assert.match(chunkedRecordProblem(record), /全局集成评审/);
  });
});

describe("自动分批评审与完整门禁", () => {
  test("超过默认上限后自动完成多批和全局评审，形成一条签名记录", async () => {
    const repo = setup();
    const oid = repo.branch("task/chunked", bigFiles());
    assert.equal(repo.cli("verify", "--branch", "task/chunked").status, 0);
    const prompts = [];
    const reviewer = ({ prompt }) => {
      prompts.push(prompt);
      return { structured: APPROVE, costUsd: 0.1, backend: "command",
        reviewer: { name: "test-reviewer", client: "command", actualModels: ["fake"] }, attempts: [] };
    };
    const record = await withRepoEnv(repo, () =>
      reviewBranch({ cwd: repo.root, branch: "task/chunked", reviewer, log: () => {} }));
    assert.equal(record.verdict, "approve");
    assert.equal(record.reviewMode, "chunked");
    assert.ok(record.chunked.chunks.length >= 2);
    assert.equal(prompts.length, record.chunked.chunks.length + 1);
    assert.match(prompts.at(-1), /全部批次评审发现和跨模块线索/);
    assert.equal(record.chunked.coverage.totalChars, record.chunked.coverage.coveredChars);
    assert.equal(chunkedRecordProblem(record), null);
    assert.equal(readReviewRecord(repo, oid).signature, record.signature);
    assert.ok(record.costUsd > 0.2);
  });

  test("跨模块评审发现 high 时，即使每个分批通过仍然 reject", async () => {
    const repo = setup();
    repo.branch("task/reject", bigFiles());
    assert.equal(repo.cli("verify", "--branch", "task/reject").status, 0);
    const high = { severity: "high", dimension: "engineering", file: "module-0.txt",
      summary: "接口不兼容", scenario: "跨模块返回值与消费方约定不一致" };
    const reviewer = ({ prompt }) => ({
      structured: prompt.includes("全部批次评审发现和跨模块线索")
        ? { ...APPROVE, verdict: "reject", findings: [high] } : APPROVE,
      costUsd: 0, backend: "command", reviewer: { name: "stub", client: "command" },
    });
    const record = await withRepoEnv(repo, () =>
      reviewBranch({ cwd: repo.root, branch: "task/reject", reviewer, log: () => {} }));
    assert.equal(record.verdict, "reject");
    assert.equal(record.blocking.length, 1);
    assert.match(chunkedRecordProblem(record), /全局集成评审/);
  });

  test("某一批评审异常时不生成虚假的最终通过记录", async () => {
    const repo = setup();
    const oid = repo.branch("task/fail", bigFiles());
    assert.equal(repo.cli("verify", "--branch", "task/fail").status, 0);
    let calls = 0;
    const reviewer = () => { if (++calls === 2) throw new Error("预算耗尽");
      return { structured: APPROVE, costUsd: 0.1 }; };
    await assert.rejects(withRepoEnv(repo, () =>
      reviewBranch({ cwd: repo.root, branch: "task/fail", reviewer, log: () => {} })), /预算耗尽/);
    assert.equal(calls, 2);
    assert.throws(() => readReviewRecord(repo, oid), /ENOENT/);
  });


  test("配置 critical-only 时局部 high 的原始 reject 不得额外阻断", async () => {
    const repo = setup({ project: { ".harness/config.json": {
      ...CONFIG, review: { ...CONFIG.review, blockSeverities: ["critical"] },
    } } });
    repo.branch("task/severity-local", bigFiles());
    assert.equal(repo.cli("verify", "--branch", "task/severity-local").status, 0);
    const high = { severity: "high", dimension: "engineering", file: "module-0.txt",
      summary: "非阻断级问题", scenario: "输入某些参数导致高严重级别问题" };
    const reviewer = ({ prompt }) => ({
      structured: prompt.includes("# 批次 1/")
        ? { ...APPROVE, verdict: "reject", findings: [high] } : APPROVE,
      costUsd: 0, backend: "command", reviewer: { name: "stub", client: "command" },
    });
    const result = await withRepoEnv(repo, () =>
      reviewBranch({ cwd: repo.root, branch: "task/severity-local", reviewer, log: () => {} }));
    assert.equal(result.verdict, "approve");
    assert.deepEqual(result.blocking, []);
    assert.equal(result.chunked.chunks[0].verdict, "approve");
    assert.equal(chunkedRecordProblem(result), null);
    assert.equal(result.findings.length, 1);
  });

  test("配置 critical-only 时全局 high 的原始 reject 不得额外阻断", async () => {
    const repo = setup({ project: { ".harness/config.json": {
      ...CONFIG, review: { ...CONFIG.review, blockSeverities: ["critical"] },
    } } });
    repo.branch("task/severity-global", bigFiles());
    assert.equal(repo.cli("verify", "--branch", "task/severity-global").status, 0);
    const high = { severity: "high", dimension: "engineering", file: "module-0.txt",
      summary: "非阻断级集成发现", scenario: "某场景中接口出现高等级兼容性问题" };
    const reviewer = ({ prompt }) => ({
      structured: prompt.includes("全部批次评审发现和跨模块线索")
        ? { ...APPROVE, verdict: "reject", findings: [high] } : APPROVE,
      costUsd: 0, backend: "command", reviewer: { name: "stub", client: "command" },
    });
    const result = await withRepoEnv(repo, () =>
      reviewBranch({ cwd: repo.root, branch: "task/severity-global", reviewer, log: () => {} }));
    assert.equal(result.verdict, "approve");
    assert.deepEqual(result.blocking, []);
    assert.equal(result.chunked.integration.verdict, "approve");
    assert.equal(chunkedRecordProblem(result), null);
  });

  test("全局文件清单超出可审容量时，不产生任何评审调用和签名记录", async () => {
    const repo = setup({ project: { ".harness/config.json": {
      ...CONFIG, review: { ...CONFIG.review, maxDiffChars: 3_000 },
    } } });
    const files = Object.fromEntries(Array.from({ length: 15 }, (_, i) =>
      [`group-${i}.txt`, `message-${i}: ${"x".repeat(220)}\n`]));
    const oid = repo.branch("task/wide", files);
    assert.equal(repo.cli("verify", "--branch", "task/wide").status, 0);
    let calls = 0;
    const reviewer = () => { calls++; return { structured: APPROVE, costUsd: 0.1 }; };
    await assert.rejects(withRepoEnv(repo, () =>
      reviewBranch({ cwd: repo.root, branch: "task/wide", reviewer, log: () => {} })),
    /改动文件过多|全局集成评审材料超限/);
    assert.equal(calls, 0, "预检查必须先于任何付费模型调用");
    assert.throws(() => readReviewRecord(repo, oid), /ENOENT/);
  });

  test("合并不能复用签名有效但伪造为部分完成的分批评审记录", () => {
    const repo = setup();
    const oid = repo.branch("task/legacy", { "a.txt": "new\n" });
    assert.equal(repo.cli("verify", "--branch", "task/legacy").status, 0);
    assert.equal(writeReview(repo, oid, "approve", { reviewMode: "chunked", chunked: {} }).status, 0);
    const outcome = repo.cli("merge", "--branch", "task/legacy", "--dry-run");
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr + outcome.stdout, /分批评审缺少可信|review_blocked/);
  });
});
