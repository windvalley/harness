import { strict as assert } from "node:assert";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, commit, CONFIG, fakeCodex, fakeReviewer, git, makeRepo, sh } from "./helpers.mjs";
import {
  blockingFindings,
  buildPrompt,
  changeStats,
  commitNotes,
  extractJson,
  maxDiffChars,
  parseVerdict,
  resolveBackend,
  REVIEW_SCHEMA,
  strictSchema,
} from "../src/review/review.mjs";
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

  test("提示按清单、证据、提交说明、文件统计、diff 的顺序排列，提交说明标明是实现方自述", () => {
    const prompt = buildPrompt({ acceptance: null, evidence: "证据", commits: "- abc feat: 说明", stats: "共 1 个文件", diff: "DIFF", branch: "b" });
    const order = ["## 验收清单", "## 验证证据摘要", "## 提交说明", "## 改动文件统计", "## 变更 diff"].map((title) => prompt.indexOf(title));
    assert.ok(order.every((at) => at >= 0), prompt);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(prompt, /实现方自述，只用于理解意图，不能作为满足验收的证据/);
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

  test("清单经人确认过（主分支或已授权方案）时，需求只部分满足就拒绝；任务分支自带的清单不阻断", () => {
    const partial = { ...APPROVE, requirementFit: { rating: "partial", evidence: "第 2 条未满足" } };
    const confirmed = setup();
    commit(confirmed.root, "docs(acceptance): 验收清单\n\n- 两条验收\n- 先合入主分支", { ".harness/acceptance/task-a.md": "- 第 1 条\n- 第 2 条\n" });
    confirmed.branch("task/a", { "a.txt": "a\n" });
    assert.equal(confirmed.cli("verify", "--branch", "task/a").status, 0);
    fakeReviewer(confirmed, partial);
    const rejected = confirmed.cli("review", "--branch", "task/a");
    assert.equal(rejected.status, 1);
    assert.match(rejected.stdout + rejected.stderr, /reject/);

    const draft = setup();
    draft.branch("task/b", { "b.txt": "b\n", ".harness/acceptance/task-b.md": "- 第 1 条\n" });
    assert.equal(draft.cli("verify", "--branch", "task/b").status, 0);
    fakeReviewer(draft, partial);
    assert.equal(draft.cli("review", "--branch", "task/b").status, 0);
  });

  test("评审进程失败时说出真实原因：超出预算给出处理办法，警告不再盖住 stdout", () => {
    const repo = setup();
    repo.branch("task/a", { "a.txt": "a\n" });
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    // 与真实的 claude -p 超出 --max-budget-usd 时一致：退出码 1，stdout 是带 subtype 的结果，stderr 只有一条认证来源警告。
    const warning = "⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set";
    const failing = (stdout) => {
      const bin = join(repo.root, "..", "failing-claude.mjs");
      writeFileSync(bin, `#!/usr/bin/env node\nimport { readFileSync } from "node:fs";\nreadFileSync(0);\nprocess.stdout.write(${JSON.stringify(stdout)});\nprocess.stderr.write(${JSON.stringify(warning)});\nprocess.exit(1);\n`);
      chmodSync(bin, 0o755);
      repo.env.HARNESS_REVIEWER_BIN = bin;
    };
    failing(JSON.stringify({ type: "result", is_error: true, subtype: "error_max_budget_usd", total_cost_usd: 1.2 }));
    const budget = repo.cli("review", "--branch", "task/a");
    assert.equal(budget.status, 1);
    assert.match(budget.stderr, /评审花费超出 review\.maxBudgetUsd（1 美元，本次已花 1\.2）/);
    assert.match(budget.stderr, /拆小分支/);

    failing("upstream connect error");
    const other = repo.cli("review", "--branch", "task/a");
    assert.match(other.stderr, /评审进程失败\(1\)\nstdout: upstream connect error\nstderr: ⚠ claude\.ai connectors/);
  });

  test("diff 超过默认上限时拒绝评审，并提示可调的配置项", () => {
    const repo = setup();
    repo.branch("task/big", { "big.txt": "x".repeat(320_000) });
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("verify", "--branch", "task/big").status, 0);
    const review = repo.cli("review", "--branch", "task/big");
    assert.equal(review.status, 1);
    assert.match(review.stderr, /超过独立评审上限 300000/);
    assert.match(review.stderr, /review\.maxDiffChars/);
    assert.match(review.stderr, /review\.maxBudgetUsd/);
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

describe("评审后端", () => {
  test("auto 按 claude、codex 顺序选择，都没有时提示配置 command", () => {
    assert.deepEqual(resolveBackend({}, { has: (bin) => bin === "claude", overrideBin: undefined }), { name: "claude", bin: "claude" });
    assert.deepEqual(resolveBackend({}, { has: (bin) => bin === "codex", overrideBin: undefined }), { name: "codex", bin: "codex" });
    assert.throws(() => resolveBackend({}, { has: () => false, overrideBin: undefined }), /command/);
    assert.throws(() => resolveBackend({ backend: "nope" }, { has: () => false }), /未知的评审后端/);
    assert.throws(() => resolveBackend({ backend: "command" }, { has: () => true }), /review\.command/);
  });

  test("严格化后的结构符合 OpenAI 要求", () => {
    const strict = strictSchema(REVIEW_SCHEMA);
    assert.equal(strict.additionalProperties, false);
    assert.deepEqual(strict.required, Object.keys(strict.properties));
    const finding = strict.properties.findings.items;
    assert.equal(finding.additionalProperties, false);
    assert.deepEqual(finding.required, Object.keys(finding.properties));
    // 原本可选的 line 变成可空，仍留在必填里
    assert.deepEqual(finding.properties.line.type, ["integer", "null"]);
    assert.deepEqual(finding.properties.dimension.type, ["string", "null"]);
    // 原本必填的字段类型不变
    assert.equal(strict.properties.verdict.type, "string");
  });

  test("从命令输出里取 JSON，容忍代码块与前后文字", () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('说明\n```json\n{"a":2}\n```\n结束'), { a: 2 });
    assert.deepEqual(extractJson('前缀 {"a":3} 后缀'), { a: 3 });
    assert.throws(() => extractJson("没有 JSON"), /找不到 JSON/);
  });

  test("codex 后端在空目录里读取材料，写出结果后写入评审记录", () => {
    const repo = setup({
      project: { ".harness/config.json": { ...CONFIG, review: { backend: "codex", codexModel: "gpt-x", blockSeverities: ["high", "critical"] } } },
    });
    repo.branch("task/c", { "a.txt": "a\n" });
    const log = fakeCodex(repo, APPROVE);
    assert.equal(repo.cli("verify", "--branch", "task/c").status, 0);

    const review = repo.cli("review", "--branch", "task/c");
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stderr, /评审后端: codex/);

    const call = JSON.parse(readFileSync(log, "utf8"));
    assert.equal(call.args[0], "exec");
    assert.ok(call.args.includes("--ephemeral"));
    assert.ok(call.args.includes("read-only"));
    assert.equal(call.args[call.args.indexOf("--model") + 1], "gpt-x");
    // 评审进程的工作目录是一个临时目录，不是仓库，读不到项目文件
    assert.doesNotMatch(call.cwd, /repo$/);
    assert.match(call.stdin, /# 评审对象: task\/c/);
    assert.match(call.stdin, /不能修改任何文件/);
    assert.match(call.stdin, /提交说明由实现方撰写/);
    assert.match(call.stdin, /## 提交说明/);
    assert.equal(call.schema.additionalProperties, false);
  });

  test("command 后端支持占位符，输出可直接是结构化结果", () => {
    const repo = setup({
      project: {
        ".harness/config.json": {
          ...CONFIG,
          // 读完提示后把结果写到 {output}，验证占位符被替换成真实路径且结果从该文件读取。
          review: { backend: "command", command: ["sh", "-c", `cat >/dev/null; printf '%s' '${JSON.stringify(APPROVE)}' > "$0"`, "{output}"], blockSeverities: ["high"] },
        },
      },
    });
    repo.branch("task/d", { "a.txt": "a\n" });
    assert.equal(repo.cli("verify", "--branch", "task/d").status, 0);
    const review = repo.cli("review", "--branch", "task/d");
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stderr, /评审后端: command/);
  });

  test("评审后端不存在时明确报错并要求配置", () => {
    const repo = setup({
      project: { ".harness/config.json": { ...CONFIG, review: { backend: "command", command: ["/nonexistent/reviewer"], blockSeverities: ["high"] } } },
    });
    repo.branch("task/e", { "a.txt": "a\n" });
    assert.equal(repo.cli("verify", "--branch", "task/e").status, 0);
    const review = repo.cli("review", "--branch", "task/e");
    assert.equal(review.status, 1);
    assert.match(review.stderr, /找不到评审命令/);

    const doctor = repo.cli("doctor");
    assert.notEqual(doctor.status, 0);
    assert.match(doctor.stdout, /不在 PATH 里/);
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
  test("大量删除时只列删除文件的路径，不因旧内容超限", () => {
    const repo = setup({
      files: { "legacy/a.js": "x".repeat(160_000), "legacy/b.js": "y".repeat(160_000) },
    });
    git(repo.root, "checkout", "-q", "-b", "task/retire");
    git(repo.root, "rm", "-q", "-r", "legacy");
    commit(repo.root, "chore(legacy): 退役旧代码\n\n- 删除旧目录\n- 补充说明", { "NOTES.md": "旧代码已退役\n" });
    git(repo.root, "checkout", "-q", "main");
    const log = fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("verify", "--branch", "task/retire").status, 0);
    const review = repo.cli("review", "--branch", "task/retire");
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stderr, /2 个删除的文件只列路径/);
    const prompt = readFileSync(join(repo.root, "..", "prompt.log"), "utf8");
    assert.match(prompt, /删除 legacy\/a\.js（原 1 行）/);
    assert.match(prompt, /NOTES\.md/);
    assert.doesNotMatch(prompt, /xxxxxxxxxx/);
    assert.ok(log);
  });

  test("diff 过大时给出按目录的分组建议", async () => {
    const { splitSuggestion } = await import("../src/review/review.mjs");
    const repo = setup();
    repo.branch("task/big", {
      "backend/a.js": "x".repeat(160_000),
      "frontend/b.vue": "y".repeat(160_000),
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

describe("评审的 diff 上限", () => {
  test("上限取 review.maxDiffChars，没配置时用默认值，非法值明确报错", () => {
    assert.equal(maxDiffChars({}), 300_000);
    assert.equal(maxDiffChars({ maxDiffChars: null }), 300_000);
    assert.equal(maxDiffChars({ maxDiffChars: 500_000 }), 500_000);
    for (const bad of [0, -1, 1.5, "400000", true]) {
      assert.throws(() => maxDiffChars({ maxDiffChars: bad }), /review\.maxDiffChars 必须是正整数/);
    }
  });

  test("主分支调高上限后大 diff 可以评审", () => {
    const repo = setup({
      project: { ".harness/config.json": { ...CONFIG, review: { ...CONFIG.review, maxDiffChars: 400_000 } } },
    });
    repo.branch("task/big", { "big.txt": "x".repeat(320_000) });
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("verify", "--branch", "task/big").status, 0);
    const review = repo.cli("review", "--branch", "task/big");
    assert.equal(review.status, 0, review.stderr);
  });

  test("任务分支自己调高上限不生效，仍按主分支的配置拒绝", () => {
    const repo = setup();
    const loosened = { ...CONFIG, review: { ...CONFIG.review, maxDiffChars: 1_000_000 } };
    repo.branch("task/self", {
      ".harness/config.json": `${JSON.stringify(loosened, null, 2)}\n`,
      "big.txt": "x".repeat(320_000),
    });
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("verify", "--branch", "task/self").status, 0);
    const review = repo.cli("review", "--branch", "task/self");
    assert.equal(review.status, 1);
    assert.match(review.stderr, /超过独立评审上限 300000/);
  });

  test("配置了非法上限时 review 与 doctor 都报出来", () => {
    const repo = setup({
      project: { ".harness/config.json": { ...CONFIG, review: { ...CONFIG.review, maxDiffChars: "很大" } } },
    });
    repo.branch("task/a", { "a.txt": "a\n" });
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    const review = repo.cli("review", "--branch", "task/a");
    assert.equal(review.status, 1);
    assert.match(review.stderr, /review\.maxDiffChars 必须是正整数/);
    const doctor = repo.cli("doctor");
    assert.notEqual(doctor.status, 0);
    assert.match(doctor.stdout, /review\.maxDiffChars 必须是正整数/);
  });
});

describe("评审的提交说明与文件统计", () => {
  test("提示里带上分支的提交说明与文件统计，不列同步主分支的合并提交", () => {
    const repo = setup();
    git(repo.root, "checkout", "-q", "-b", "task/notes");
    commit(repo.root, "feat(a): 新增 a 文件\n\n- 写入 a 文件\n- 补充说明", { "a.txt": "a\n" });
    commit(repo.root, "fix(a): a 文件改为两行\n\n- 第二行写 b", { "a.txt": "a\nb\n" });
    git(repo.root, "checkout", "-q", "main");
    commit(repo.root, "docs: 主分支前进\n\n- 补充主分支说明", { "main.txt": "main\n" });
    git(repo.root, "checkout", "-q", "task/notes");
    git(repo.root, "merge", "-q", "--no-ff", "--no-edit", "main");
    git(repo.root, "checkout", "-q", "main");

    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("verify", "--branch", "task/notes").status, 0);
    const review = repo.cli("review", "--branch", "task/notes");
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stderr, /提交 2 个/);

    const prompt = readFileSync(join(repo.root, "..", "prompt.log"), "utf8");
    const notes = prompt.slice(prompt.indexOf("## 提交说明"), prompt.indexOf("## 改动文件统计"));
    assert.match(notes, /共 2 个提交，不含合并提交/);
    assert.match(notes, /- [0-9a-f]+ feat\(a\): 新增 a 文件\n {4}- 写入 a 文件\n {4}- 补充说明/);
    assert.match(notes, /- [0-9a-f]+ fix\(a\): a 文件改为两行/);
    assert.ok(notes.indexOf("feat(a)") < notes.indexOf("fix(a)"), "按时间先后排列");
    assert.doesNotMatch(notes, /Merge|主分支前进/);

    const stats = prompt.slice(prompt.indexOf("## 改动文件统计"), prompt.indexOf("## 变更 diff"));
    assert.match(stats, /共 1 个文件，\+2 -0 行/);
    assert.match(stats, /\+2 -0 {2}a\.txt/);
    assert.doesNotMatch(stats, /main\.txt/);
  });

  test("提交说明过长时只列标题，标题也放不下时写明省略了几个", () => {
    const repo = setup();
    git(repo.root, "checkout", "-q", "-b", "task/long");
    for (const n of [1, 2, 3]) {
      commit(repo.root, `feat(a): 第 ${n} 步\n\n- ${"很长的说明".repeat(40)}`, { [`f${n}.txt`]: `${n}\n`.repeat(n * 10) });
    }
    git(repo.root, "checkout", "-q", "main");
    const base = git(repo.root, "merge-base", "main", "task/long");
    const head = git(repo.root, "rev-parse", "task/long");

    const full = commitNotes(repo.root, base, head);
    assert.equal(full.truncated, false);
    assert.match(full.text, /很长的说明/);

    const subjects = commitNotes(repo.root, base, head, 200);
    assert.equal(subjects.truncated, true);
    assert.equal(subjects.count, 3);
    assert.match(subjects.text, /只列标题/);
    assert.match(subjects.text, /第 3 步/);
    assert.doesNotMatch(subjects.text, /很长的说明/);

    const partial = commitNotes(repo.root, base, head, 90);
    assert.match(partial.text, /其余 \d 个提交未列出/);

    assert.doesNotMatch(changeStats(repo.root, base, head), /只列/);
    const stats = changeStats(repo.root, base, head, 60);
    assert.match(stats, /共 3 个文件，\+60 -0 行（只列改动量最大的部分）/);
    assert.match(stats, /\+30 -0 {2}f3\.txt/);
    assert.match(stats, /其余 \d 个文件未列出/);
  });
});
