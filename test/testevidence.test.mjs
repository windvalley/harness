import { strict as assert } from "node:assert";
import { afterEach, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVE, fakeReviewer, git, makeRepo } from "./helpers.mjs";
import { verifyConfigProblems } from "../src/verify/verify.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

const TDD = "harness:tdd-red";
const COVERAGE = "harness:changed-line-coverage";
const ADD = "export const add = (a, b) => a + b;\n";
const addTest = (name, expr = "add(1, 2)", want = 3) =>
  `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.mjs";\ntest("${name}", () => assert.equal(${expr}, ${want}));\n`;
const mulTest = 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { mul } from "../src/mul.mjs";\ntest("mul", () => assert.equal(mul(2, 3), 6));\n';
const MUL = "export const mul = (a, b) => a * b;\n";

const testFirst = (extra = {}) => ({
  source: { match: ["src/**"], exclude: [] },
  tests: { match: ["test/**"], exclude: [] },
  // 这些用例本身跑在 node --test 里，要去掉继承来的 NODE_TEST_CONTEXT，否则嵌套的 node --test 什么都不执行。
  cmd: ["env", "-u", "NODE_TEST_CONTEXT", "node", "--test", "{tests}"],
  ...extra,
});

function setup({ tdd, coverage, files = {} } = {}) {
  const verify = {
    version: 1,
    docOnly: { match: ["docs/**", "**/*.md"], exclude: [] },
    checks: [{ id: "unit", tier: "gate", when: ["src/**", "test/**", "web/**"], cmd: ["node", "-e", "process.exit(0)"] }],
    fullSuiteTriggers: { paths: [] },
    ...(tdd ? { testFirst: tdd } : {}),
    ...(coverage ? { coverage } : {}),
  };
  const repo = makeRepo({
    project: { ".harness/verify.json": verify },
    files: { "src/add.mjs": ADD, "test/add.test.mjs": addTest("add"), ...files },
  });
  repos.push(repo);
  return repo;
}

function evidence(repo, branch) {
  const key = git(repo.root, "rev-parse", branch);
  return JSON.parse(readFileSync(join(repo.env.HARNESS_DATA_DIR, "evidence", `${key}.json`), "utf8"));
}
const entry = (record, id) => record.checks.find((item) => item.id === id);

describe("先红后绿的机器证据", () => {
  test("新增测试在还原实现后失败，算有效的红灯", () => {
    const repo = setup({ tdd: testFirst() });
    repo.branch("feat/mul", { "src/mul.mjs": MUL, "test/mul.test.mjs": mulTest });
    const result = repo.cli("verify", "--branch", "feat/mul");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`PASS ${TDD}`));
    const record = evidence(repo, "feat/mul");
    assert.equal(record.status, "passed");
    assert.equal(entry(record, TDD).exit, 0);
    assert.match(entry(record, TDD).note, /还原/);
  });

  test("改了实现却没有改测试，验证失败", () => {
    const repo = setup({ tdd: testFirst() });
    repo.branch("fix/add", { "src/add.mjs": `${ADD}export const sub = (a, b) => a - b;\n` });
    const result = repo.cli("verify", "--branch", "fix/add");
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`FAIL ${TDD}`));
    assert.match(result.stderr, /没有新增或修改测试/);
    assert.equal(evidence(repo, "fix/add").status, "failed");
  });

  test("测试在还原实现后仍然通过，说明没有证明过红灯，验证失败", () => {
    const repo = setup({ tdd: testFirst() });
    repo.branch("fix/add", { "src/add.mjs": `${ADD}export const unused = 1;\n`, "test/extra.test.mjs": addTest("extra") });
    const result = repo.cli("verify", "--branch", "fix/add");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /还原实现后仍然通过/);
  });

  test("测试在当前实现上就不通过，验证失败并带出输出", () => {
    const repo = setup({ tdd: testFirst() });
    repo.branch("fix/add", { "src/add.mjs": ADD.replace("a + b", "a - b"), "test/extra.test.mjs": addTest("extra") });
    const result = repo.cli("verify", "--branch", "fix/add");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /当前实现上就不通过/);
  });

  test("提交信息里的 Tdd-Waiver 豁免行为不变的改动，原因记入证据", () => {
    const repo = setup({ tdd: testFirst() });
    repo.branch("refactor/add", { "src/add.mjs": "export const add = (x, y) => x + y;\n" }, "refactor(add): 改参数名\n\n- 只改参数名\n- Tdd-Waiver: 行为不变的重命名");
    const result = repo.cli("verify", "--branch", "refactor/add");
    assert.equal(result.status, 0, result.stderr);
    assert.match(entry(evidence(repo, "refactor/add"), TDD).note, /豁免: 行为不变的重命名/);
  });

  test("没有实现文件改动时不产生这一项", () => {
    const repo = setup({ tdd: testFirst() });
    repo.branch("docs/x", { "docs/x.md": "说明\n" });
    assert.equal(repo.cli("verify", "--branch", "docs/x").status, 0);
    assert.equal(entry(evidence(repo, "docs/x"), TDD), undefined);
    repo.branch("test/only", { "test/more.test.mjs": addTest("more") });
    assert.equal(repo.cli("verify", "--branch", "test/only").status, 0);
    assert.equal(entry(evidence(repo, "test/only"), TDD), undefined);
  });

  test("mode 为 observe 时只记录不拦截", () => {
    const repo = setup({ tdd: testFirst({ mode: "observe" }) });
    repo.branch("fix/add", { "src/add.mjs": `${ADD}export const sub = (a, b) => a - b;\n` });
    const result = repo.cli("verify", "--branch", "fix/add");
    assert.equal(result.status, 0, result.stderr);
    const item = entry(evidence(repo, "fix/add"), TDD);
    assert.equal(item.exit, 0);
    assert.equal(item.observed, true);
    assert.match(item.note, /观察模式.*没有新增或修改测试/);
  });

  test("再次验证同一个提交时复用结果", () => {
    const repo = setup({ tdd: testFirst() });
    repo.branch("feat/mul", { "src/mul.mjs": MUL, "test/mul.test.mjs": mulTest });
    assert.equal(repo.cli("verify", "--branch", "feat/mul").status, 0);
    const again = repo.cli("verify", "--branch", "feat/mul");
    assert.match(again.stderr, new RegExp(`PASS ${TDD} \\(复用\\)`));
  });

  test("doctor 用的配置检查列出写错的 testFirst 与 coverage", () => {
    const problems = verifyConfigProblems({ checks: [], testFirst: { source: ["src/**"], cmd: "x" }, coverage: { include: { match: ["src/**"] }, cmd: ["x"], report: "r", threshold: 120 } });
    assert.deepEqual(problems.map((item) => item.id), [TDD, COVERAGE]);
    assert.match(problems[1].reason, /threshold/);
    assert.deepEqual(verifyConfigProblems({ checks: [], testFirst: { source: { match: [] }, tests: { match: [] }, cmd: ["x"], mode: "observe" } }), []);
  });

  test("评审输入带出测试证据的说明", () => {
    const repo = setup({ tdd: testFirst() });
    repo.branch("feat/mul", { "src/mul.mjs": MUL, "test/mul.test.mjs": mulTest });
    assert.equal(repo.cli("verify", "--branch", "feat/mul").status, 0);
    fakeReviewer(repo, APPROVE);
    const reviewed = repo.cli("review", "--branch", "feat/mul");
    assert.equal(reviewed.status, 0, reviewed.stderr);
    const prompt = readFileSync(join(repo.root, "..", "prompt.log"), "utf8");
    assert.match(prompt, new RegExp(`${TDD}: exit=0.* - .*还原`));
  });

  test("verify --plan 列出会复算的测试证据，不涉及时不列，配置写错时报错", () => {
    const repo = setup({ tdd: testFirst(), coverage: coverage(), files: coverageFiles });
    repo.branch("feat/mul", { "src/mul.mjs": MUL, "test/mul.test.mjs": mulTest });
    const plan = repo.cli("verify", "--plan", "--branch", "feat/mul");
    assert.equal(plan.status, 0, plan.stderr);
    assert.match(plan.stdout, new RegExp(`RUN  ${TDD}  .*1 个实现文件`));
    assert.doesNotMatch(plan.stdout, new RegExp(COVERAGE));
    repo.branch("feat/web", { "web/src/calc.mjs": CALC_MORE });
    assert.match(repo.cli("verify", "--plan", "--branch", "feat/web").stdout, new RegExp(`RUN  ${COVERAGE}  .*1 个文件`));
    repo.branch("docs/x", { "docs/x.md": "说明\n" });
    const docs = repo.cli("verify", "--plan", "--branch", "docs/x").stdout;
    assert.doesNotMatch(docs, /harness:/);
    const json = JSON.parse(repo.cli("verify", "--plan", "--json", "--branch", "feat/mul").stdout);
    assert.deepEqual(json.testEvidence.map((item) => item.id), [TDD]);

    const broken = setup({ tdd: { source: ["src/**"], cmd: "x" } });
    broken.branch("feat/mul", { "src/mul.mjs": MUL });
    const bad = broken.cli("verify", "--plan", "--branch", "feat/mul");
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /ERR  harness:tdd-red/);
  });

  test("配置写错按配置错误失败", () => {
    const repo = setup({ tdd: { source: ["src/**"], cmd: "node --test" } });
    repo.branch("feat/mul", { "src/mul.mjs": MUL, "test/mul.test.mjs": mulTest });
    const result = repo.cli("verify", "--branch", "feat/mul");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /配置错误/);
    assert.match(result.stderr, /testFirst/);
  });
});

const CALC = ["a", "b", "c", "d", "e", "f"].map((name, i) => `export const ${name} = ${i};`).join("\n") + "\n";
const CALC_MORE = `${CALC}export const g = 6;\nexport const h = 7;\nexport const i = 8;\nexport const j = 9;\n`;
const lcov = (file, hits) => `TN:\nSF:${file}\n${Object.entries(hits).map(([line, n]) => `DA:${line},${n}`).join("\n")}\nend_of_record\n`;
const coverage = (extra = {}) => ({
  include: { match: ["web/src/**"], exclude: [] },
  cwd: "web",
  cmd: ["sh", "-c", "mkdir -p out && cp ../cov/lcov.info out/lcov.info"],
  report: "out/lcov.info",
  ...extra,
});
const coverageFiles = { "web/src/calc.mjs": CALC };

describe("改动行覆盖率", () => {
  test("改动行覆盖率达标放行，只统计改动行，路径相对命令的 cwd", () => {
    const repo = setup({ coverage: coverage({ threshold: 75 }), files: coverageFiles });
    // 第 1 行没被覆盖但不是这次改的；新增的 7-10 行里 3 行被覆盖。
    repo.branch("feat/more", { "web/src/calc.mjs": CALC_MORE, "cov/lcov.info": lcov("src/calc.mjs", { 1: 0, 7: 1, 8: 1, 9: 1, 10: 0 }) });
    const result = repo.cli("verify", "--branch", "feat/more");
    assert.equal(result.status, 0, result.stderr);
    const item = entry(evidence(repo, "feat/more"), COVERAGE);
    assert.equal(item.exit, 0);
    assert.deepEqual([item.coverage.covered, item.coverage.total], [3, 4]);
    assert.match(item.note, /3\/4/);
  });

  test("低于阈值验证失败，输出未覆盖的改动行", () => {
    const repo = setup({ coverage: coverage({ threshold: 80 }), files: coverageFiles });
    repo.branch("feat/more", { "web/src/calc.mjs": CALC_MORE, "cov/lcov.info": lcov("src/calc.mjs", { 7: 1, 8: 1, 9: 0, 10: 0 }) });
    const result = repo.cli("verify", "--branch", "feat/more");
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`FAIL ${COVERAGE}`));
    assert.match(result.stderr, /web\/src\/calc\.mjs:9-10/);
    assert.match(result.stderr, /2\/4/);
  });

  test("改动的文件不在报告里按全部未覆盖算", () => {
    const repo = setup({ coverage: coverage(), files: coverageFiles });
    repo.branch("feat/more", { "web/src/calc.mjs": CALC_MORE, "cov/lcov.info": lcov("src/other.mjs", { 1: 1 }) });
    const result = repo.cli("verify", "--branch", "feat/more");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /不在覆盖率报告里/);
  });

  test("没有生成报告或命令失败都不能通过", () => {
    const repo = setup({ coverage: coverage({ cmd: ["sh", "-c", "true"] }), files: coverageFiles });
    repo.branch("feat/more", { "web/src/calc.mjs": CALC_MORE });
    const missing = repo.cli("verify", "--branch", "feat/more");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /没有生成覆盖率报告/);

    const broken = setup({ coverage: coverage({ cmd: ["sh", "-c", "exit 3"] }), files: coverageFiles });
    broken.branch("feat/more", { "web/src/calc.mjs": CALC_MORE });
    const failed = broken.cli("verify", "--branch", "feat/more");
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /覆盖率命令失败/);
  });

  test("Go 覆盖率文件按模块路径映射到仓库文件", () => {
    const go = ["package calc", "", "func A() int { return 1 }", "func B() int {", "\treturn 2", "}", ""].join("\n");
    const more = `${go}func C() int {\n\treturn 3\n}\nfunc D() int {\n\treturn 4\n}\n`;
    const profile = (hits) => `mode: set\nexample.com/m/calc/calc.go:7.15,9.2 1 ${hits[0]}\nexample.com/m/calc/calc.go:10.15,12.2 1 ${hits[1]}\n`;
    const repo = setup({
      coverage: { include: { match: ["calc/*.go"], exclude: [] }, cmd: ["sh", "-c", "cp cov/cover.out cover.out"], report: "cover.out", threshold: 50 },
      files: { "go.mod": "module example.com/m\n\ngo 1.22\n", "calc/calc.go": go },
    });
    repo.branch("feat/more", { "calc/calc.go": more, "cov/cover.out": profile([1, 0]) });
    const result = repo.cli("verify", "--branch", "feat/more");
    assert.equal(result.status, 0, result.stderr);
    const item = entry(evidence(repo, "feat/more"), COVERAGE);
    assert.deepEqual([item.coverage.covered, item.coverage.total], [3, 6]);

    const strict = setup({
      coverage: { include: { match: ["calc/*.go"], exclude: [] }, cmd: ["sh", "-c", "cp cov/cover.out cover.out"], report: "cover.out", threshold: 100 },
      files: { "go.mod": "module example.com/m\n\ngo 1.22\n", "calc/calc.go": go },
    });
    strict.branch("feat/more", { "calc/calc.go": more, "cov/cover.out": profile([1, 0]) });
    assert.equal(strict.cli("verify", "--branch", "feat/more").status, 1);
  });

  test("mode 为 observe 时低覆盖只记录", () => {
    const repo = setup({ coverage: coverage({ mode: "observe" }), files: coverageFiles });
    repo.branch("feat/more", { "web/src/calc.mjs": CALC_MORE, "cov/lcov.info": lcov("src/calc.mjs", { 7: 0, 8: 0, 9: 0, 10: 0 }) });
    const result = repo.cli("verify", "--branch", "feat/more");
    assert.equal(result.status, 0, result.stderr);
    const item = entry(evidence(repo, "feat/more"), COVERAGE);
    assert.equal(item.observed, true);
    assert.match(item.note, /观察模式/);
  });

  test("门禁确认摘要点名测试证据配置的改动", () => {
    const repo = setup({ coverage: coverage({ threshold: 80 }), files: coverageFiles });
    const verify = JSON.parse(readFileSync(join(repo.root, ".harness/verify.json"), "utf8"));
    verify.coverage.threshold = 0;
    repo.branch("chore/loosen", { ".harness/verify.json": `${JSON.stringify(verify, null, 2)}\n` });
    const summary = repo.cli("confirm", "--branch", "chore/loosen");
    assert.equal(summary.status, 0, summary.stderr);
    assert.match(summary.stdout, /测试证据配置有改动/);
    assert.match(summary.stdout, /"threshold":80.*"threshold":0/);
  });
});
