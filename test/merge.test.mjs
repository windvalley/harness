import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, commit, fakeReviewer, git, makeRepo, write, writeReview } from "./helpers.mjs";
import { planChecks, reusableChecks, verifyConfigProblems } from "../src/verify/verify.mjs";
import { environmentDigests } from "../src/verify/environment.mjs";

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
const verifyWith = (checks) => ({ version: 1, docOnly: { match: [], exclude: [] }, checks, fullSuiteTriggers: { paths: [] } });
const evidenceOf = (repo, branch) =>
  JSON.parse(readFileSync(join(repo.env.HARNESS_DATA_DIR, "evidence", `${git(repo.root, "rev-parse", branch)}.json`), "utf8"));

describe("检查计划", () => {
  const project = {
    verify: {
      docOnly: { match: ["docs/**"], exclude: [] },
      checks: [
        { id: "always", tier: "gate", when: ["**"], cmd: ["node", "-e", "process.exit(0)"] },
        { id: "files", tier: "gate", when: ["src/**"], cmd: ["node", "-e", "process.exit(0)", "files"] },
        { id: "manual", tier: "extended", when: ["src/**"], reason: "需人工" },
        { id: "hint", tier: "advisory", when: ["src/**"], hint: "建议" },
      ],
      fullSuiteTriggers: { paths: [] },
    },
  };

  test("只改文档时走轻量路径", () => {
    const result = planChecks({ project, cwd: "/tmp", changed: ["docs/a.md"], exists: () => true });
    assert.equal(result.docOnly, true);
    assert.deepEqual(result.plan.map((item) => item.id), ["always"]);
  });

  test("extended 进未执行项，advisory 只提示不进未执行", () => {
    const result = planChecks({ project, cwd: "/tmp", changed: ["src/a.js"], exists: () => true });
    assert.deepEqual(result.notExecuted.map((item) => item.id), ["manual"]);
    assert.deepEqual(result.advisory.map((item) => item.id), ["hint"]);
  });

  test("删除的文件不进入选择器输入但保留触发", () => {
    const withSelector = {
      verify: {
        docOnly: { match: [], exclude: [] },
        checks: [{ id: "go", tier: "gate", when: ["src/**"], selector: "go-packages", cmd: ["true"], sharedPrefixes: [] }],
        fullSuiteTriggers: { paths: [] },
      },
    };
    // 纯删除：选择器拿不到可分析的路径，但触发仍然成立，交给选择器返回 none。
    const deletedOnly = planChecks({ project: withSelector, cwd: "/tmp", changed: ["src/gone.js"], exists: () => false });
    assert.equal(deletedOnly.plan.length, 0);
    // 混合变更：存在的文件驱动选择器，删除的路径不参与。
    const mixed = planChecks({ project, cwd: "/tmp", changed: ["src/kept.js", "src/gone.js"], exists: (p) => p === "src/kept.js" });
    assert.ok(mixed.plan.some((item) => item.id === "files"));
  });

  test("配置错误的 gate 检查被选中时进 invalid，不再静默跳过；没选中、不自动执行的检查不受影响", () => {
    const configured = {
      verify: {
        docOnly: { match: [], exclude: [] },
        checks: [
          { id: "no-cmd", tier: "gate", when: ["src/**"] },
          { id: "string-cmd", tier: "gate", when: ["src/**"], cmd: "npm test" },
          { id: "empty-cmd", when: ["src/**"], cmd: [] },
          { id: "vitest", tier: "gate", when: ["src/**"], selector: "vitest", testRoot: "src" },
          { id: "unknown", tier: "gate", when: ["src/**"], selector: "jest", cmd: ["npx", "jest"] },
          { id: "go", tier: "gate", when: ["src/**"], selector: "go-packages", sharedPrefixes: [] },
          { id: "manual", tier: "extended", when: ["src/**"], reason: "需人工" },
          { id: "hint", tier: "advisory", when: ["src/**"], hint: "建议" },
          { id: "elsewhere", tier: "gate", when: ["web/**"] },
        ],
        fullSuiteTriggers: { paths: [] },
      },
    };
    const result = planChecks({ project: configured, cwd: "/tmp", changed: ["src/a.js"], exists: () => true });
    assert.deepEqual(result.invalid.map((item) => item.id), ["no-cmd", "string-cmd", "empty-cmd", "vitest", "unknown"]);
    assert.match(result.invalid.find((item) => item.id === "string-cmd").reason, /参数数组/);
    const vitest = result.invalid.find((item) => item.id === "vitest");
    assert.match(vitest.reason, /selector vitest 已移除/);
    assert.match(vitest.fix, /--changed/);
    assert.match(result.invalid.find((item) => item.id === "unknown").reason, /不认识的 selector "jest"/);
    assert.ok(result.invalid.every((item) => item.def && item.fix), "每项都带检查指纹与改法");
    assert.deepEqual(result.plan.map((item) => item.id), [], "go-packages 不需要 cmd，这里没有 Go 包可测");
    assert.deepEqual(result.notExecuted.map((item) => item.id), ["manual"]);
    assert.deepEqual(result.advisory.map((item) => item.id), ["hint"]);
    assert.deepEqual(verifyConfigProblems(configured.verify).map((item) => item.id), ["no-cmd", "string-cmd", "empty-cmd", "vitest", "unknown", "elsewhere"]);
  });
});

describe("证据复用判定", () => {
  const plan = [
    { id: "frontend", when: ["frontend/**"] },
    { id: "go", when: ["internal/**"] },
  ];
  const previous = {
    status: "passed",
    checks: [
      { id: "frontend", exit: 0 },
      { id: "go", exit: 0 },
    ],
  };

  test("主分支改动与检查范围无交集时两项都复用", () => {
    const { reuse, rerun } = reusableChecks({ previous, plan, mainDelta: ["docs/a.md"] });
    assert.equal(reuse.size, 2);
    assert.deepEqual(rerun, []);
  });

  test("主分支改到某检查的范围时只重跑那一项", () => {
    const { reuse, rerun } = reusableChecks({ previous, plan, mainDelta: ["frontend/src/a.vue"] });
    assert.deepEqual([...reuse.keys()], ["go"]);
    assert.deepEqual(rerun, ["frontend"]);
  });

  test("检查定义或命令与上次不同时重跑，不按 ID 复用", () => {
    const current = [
      { id: "frontend", when: ["frontend/**"], def: "v2" },
      { id: "go", when: ["internal/**"], cmd: ["go", "test", "./b"], def: "g1" },
    ];
    const prior = {
      status: "passed",
      checks: [
        { id: "frontend", exit: 0, def: "v1" },
        { id: "go", exit: 0, cmd: "go test ./a", def: "g1" },
      ],
    };
    const { reuse, rerun } = reusableChecks({ previous: prior, plan: current, mainDelta: [] });
    assert.equal(reuse.size, 0);
    assert.deepEqual(rerun, ["frontend", "go"]);
  });

  test("没有历史证据或状态非通过时全部重跑", () => {
    assert.equal(reusableChecks({ previous: null, plan, mainDelta: [] }).rerun.length, 2);
    assert.equal(reusableChecks({ previous: { ...previous, status: "failed" }, plan, mainDelta: [] }).rerun.length, 2);
  });
});

describe("验证与证据", () => {
  test("验证通过后写入以分支提交为键的证据", () => {
    const repo = setup();
    repo.branch("task/a", { "src/a.js": "x\n" });
    const result = repo.cli("verify", "--branch", "task/a");
    assert.equal(result.status, 0, result.stderr);
    const key = git(repo.root, "rev-parse", "task/a");
    const file = join(repo.env.HARNESS_DATA_DIR, "evidence", `${key}.json`);
    const record = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(record.status, "passed");
    assert.equal(record.recordKey, key);
  });

  test("检查失败时证据为 failed 且退出码非零", () => {
    const repo = setup({
      project: {
        ".harness/verify.json": {
          version: 1,
          docOnly: { match: [], exclude: [] },
          checks: [{ id: "bad", tier: "gate", when: ["**"], cmd: ["node", "-e", "process.exit(7)"] }],
          fullSuiteTriggers: { paths: [] },
        },
      },
    });
    repo.branch("task/a", { "a.txt": "a\n" });
    const result = repo.cli("verify", "--branch", "task/a");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL bad/);
  });

  test("verify --plan 只列出检查，不执行也不写证据", () => {
    const repo = setup();
    repo.branch("task/plan", { "src/a.js": "x\n", "docs/x.md": "d\n" });
    const result = repo.cli("verify", "--plan", "--branch", "task/plan");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RUN {2}unit/);
    assert.match(result.stdout, /TODO lint/);
    assert.match(result.stdout, /TODO manual-check/);
    assert.match(result.stdout, /HINT visual-hint/);
    const key = git(repo.root, "rev-parse", "task/plan");
    assert.equal(existsSync(join(repo.env.HARNESS_DATA_DIR, "evidence", `${key}.json`)), false, "plan 不应写证据");
  });

  test("必验路径没有自动检查覆盖时证据为 incomplete，豁免与覆盖后通过", () => {
    const unit = { id: "unit", tier: "gate", when: ["src/**"], cmd: ["node", "-e", "process.exit(0)"] };
    const withRequired = (requiredPaths) => ({ ...verifyWith([unit]), requiredPaths });
    const repo = setup({ project: { ".harness/verify.json": withRequired({ match: ["lib/**", "src/**"], exclude: ["lib/gen/**"] }) } });

    repo.branch("task/gap", { "lib/a.js": "x\n", "src/a.js": "y\n" });
    const gap = repo.cli("verify", "--branch", "task/gap");
    assert.equal(gap.status, 1, gap.stderr);
    assert.match(gap.stderr, /验证结果: incomplete/);
    assert.match(gap.stderr, /NOT_EXECUTED required-paths: 1 个必验路径没有自动检查覆盖: lib\/a\.js/);
    assert.equal(evidenceOf(repo, "task/gap").status, "incomplete");
    const plan = repo.cli("verify", "--plan", "--branch", "task/gap");
    assert.equal(plan.status, 1);
    assert.match(plan.stdout, /ERR {2}required-paths/);

    repo.branch("task/exempt", { "lib/gen/a.js": "x\n", "src/a.js": "y\n" });
    const exempt = repo.cli("verify", "--branch", "task/exempt");
    assert.equal(exempt.status, 0, exempt.stderr);
    assert.equal(evidenceOf(repo, "task/exempt").status, "passed");
  });

  test("没配置 requiredPaths 时未覆盖的改动只记录不阻断；requiredPaths 写错形状按配置错误处理", () => {
    const repo = setup({ project: { ".harness/verify.json": verifyWith([{ id: "unit", tier: "gate", when: ["src/**"], cmd: ["node", "-e", "process.exit(0)"] }]) } });
    repo.branch("task/loose", { "lib/a.js": "x\n", "src/a.js": "y\n" });
    const loose = repo.cli("verify", "--branch", "task/loose");
    assert.equal(loose.status, 0, loose.stderr);
    assert.deepEqual(evidenceOf(repo, "task/loose").uncovered, ["lib/a.js"]);

    const broken = setup({
      project: { ".harness/verify.json": { ...verifyWith([{ id: "unit", tier: "gate", when: ["src/**"], cmd: ["node", "-e", "process.exit(0)"] }]), requiredPaths: ["src/**"] } },
    });
    broken.branch("task/a", { "src/a.js": "y\n" });
    const result = broken.cli("verify", "--branch", "task/a");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requiredPaths 必须是/);
  });

  test("共享依赖变了而代码没变时，普通验证不再复用旧结果", () => {
    const check = { id: "unit", tier: "gate", when: ["src/**"], cmd: ["node", "-e", "process.exit(0)"], requires: ["node_modules"] };
    const repo = setup({ project: { ".harness/verify.json": verifyWith([check]) }, files: { ".gitignore": "node_modules/\n" } });
    write(repo.root, "node_modules/.package-lock.json", '{"packages":{"a":{"version":"1.0.0"}}}\n');
    write(repo.root, "node_modules/a/index.js", "module.exports = 1;\n");
    repo.branch("task/a", { "src/a.js": "x\n" });

    const first = repo.cli("verify", "--branch", "task/a");
    assert.equal(first.status, 0, first.stderr);
    const second = repo.cli("verify", "--branch", "task/a");
    assert.match(second.stderr, /= unit 复用上次结果/, "依赖没变时照常复用");

    write(repo.root, "node_modules/.package-lock.json", '{"packages":{"a":{"version":"2.0.0"}}}\n');
    const third = repo.cli("verify", "--branch", "task/a");
    assert.equal(third.status, 0, third.stderr);
    assert.doesNotMatch(third.stderr, /复用上次结果/);
    assert.match(third.stderr, /-> unit/);

    // 合并前的证据复用判定同样看环境：依赖在验证之后又变了，合并按当前环境重新验证
    assert.ok(evidenceOf(repo, "task/a").checks[0].envDigest);
    writeReview(repo, git(repo.root, "rev-parse", "task/a"), "approve");
    write(repo.root, "node_modules/b/index.js", "module.exports = 2;\n");
    const merged = repo.cli("merge", "--branch", "task/a");
    assert.equal(merged.status, 0, merged.stderr);
    assert.match(merged.stderr, /主分支改动波及 unit，重新验证/);
  });

  test("环境指纹：工具链版本与依赖安装状态任何一项变化都会改变", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-env-"));
    try {
      write(root, "node_modules/.package-lock.json", "v1\n");
      write(root, "node_modules/a/index.js", "1\n");
      write(root, "node_modules/.cache/x", "noise\n");
      const digest = (items) => environmentDigests({ items, mainRoot: root, cwd: root }).get("c");
      const item = { id: "c", tool: "node", requires: ["node_modules"] };
      const base = digest([item]);
      assert.equal(digest([item]), base, "同一状态指纹稳定");
      write(root, "node_modules/.cache/x", "more noise\n");
      assert.equal(digest([item]), base, "点开头的缓存目录不参与");
      write(root, "node_modules/.package-lock.json", "v2\n");
      assert.notEqual(digest([item]), base, "安装清单变化");
      assert.notEqual(digest([{ ...item, requires: ["missing_dir"] }]), digest([{ ...item, requires: [] }]), "依赖目录缺失与无依赖不同");
      assert.notEqual(digest([{ ...item, tool: "go" }]), digest([{ ...item, tool: "node" }]), "工具不同");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("命令不存在时说明是环境问题，与检查失败区分", () => {
    const repo = setup({
      project: {
        ".harness/verify.json": {
          version: 1,
          docOnly: { match: [], exclude: [] },
          checks: [{ id: "missing-tool", tier: "gate", when: ["**"], cmd: ["harness-no-such-command-xyz"] }],
          fullSuiteTriggers: { paths: [] },
        },
      },
    });
    repo.branch("task/a", { "a.txt": "a\n" });
    const result = repo.cli("verify", "--branch", "task/a");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /未找到命令 harness-no-such-command-xyz/);
    const record = JSON.parse(readFileSync(join(repo.env.HARNESS_DATA_DIR, "evidence", `${git(repo.root, "rev-parse", "task/a")}.json`), "utf8"));
    assert.equal(record.checks[0].spawnError, "ENOENT");
  });

  test("配置错误的 gate 检查被选中时验证失败并给出改法，不执行任何命令", () => {
    const marker = join(tmpdir(), `harness-should-not-run-${process.pid}-${Date.now()}`);
    const repo = setup({
      project: {
        ".harness/verify.json": verifyWith([
          { id: "no-cmd", tier: "gate", when: ["src/**"] },
          { id: "string-cmd", tier: "gate", when: ["src/**"], cmd: "npm test" },
          { id: "ok", tier: "gate", when: ["src/**"], cmd: ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`] },
        ]),
      },
    });
    repo.branch("task/a", { "src/a.js": "x\n" });
    const result = repo.cli("verify", "--branch", "task/a");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /FAIL no-cmd/);
    assert.match(result.stderr, /FAIL string-cmd/);
    assert.match(result.stderr, /--- no-cmd 配置错误 ---\ngate 检查没有可执行的 cmd/);
    assert.match(result.stderr, /tier 改为 extended/);
    assert.equal(existsSync(marker), false, "配置有错时不执行其他检查");
    const record = evidenceOf(repo, "task/a");
    assert.equal(record.status, "failed");
    assert.deepEqual(record.checks.map((check) => [check.id, check.exit, Boolean(check.configError)]), [
      ["no-cmd", null, true],
      ["string-cmd", null, true],
    ]);

    // verify --plan 同样列出，并以非零退出提示这份计划验证不会通过
    const plan = repo.cli("verify", "--plan", "--branch", "task/a");
    assert.equal(plan.status, 1);
    assert.match(plan.stdout, /ERR {2}no-cmd {2}gate 检查没有可执行的 cmd/);
    assert.match(plan.stdout, /RUN {2}ok/);
    const json = JSON.parse(repo.cli("verify", "--plan", "--json", "--branch", "task/a").stdout);
    assert.deepEqual(json.invalid.map((item) => item.id), ["no-cmd", "string-cmd"]);
  });

  test("已移除的 vitest 选择器被选中时报配置错误；只改配置的分支选不中它，旧配置可以照常修掉", () => {
    const legacy = { id: "web-unit", tier: "gate", when: ["web/**"], cwd: "web", selector: "vitest", testRoot: "web/src" };
    const repo = setup({ project: { ".harness/verify.json": verifyWith([legacy]) } });
    repo.branch("task/web", { "web/src/a.ts": "export const a = 1;\n" });
    const result = repo.cli("verify", "--branch", "task/web");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /FAIL web-unit/);
    assert.match(result.stderr, /selector vitest 已移除/);
    assert.match(result.stderr, /"cmd": \["pnpm", "exec", "vitest", "run", "--changed", "main"\]/);
    assert.equal(evidenceOf(repo, "task/web").status, "failed");

    // 主分支的配置决定验证；修配置的分支只改 .harness/verify.json，不在 web/** 范围内，照常通过
    const { selector, testRoot, ...rest } = legacy;
    const fixed = verifyWith([{ ...rest, cmd: ["node", "-e", "process.exit(0)"] }]);
    repo.branch("task/fix", { ".harness/verify.json": `${JSON.stringify(fixed, null, 2)}\n` }, "fix(verify): 改用普通命令\n\n- 删掉已移除的 vitest 选择器\n- 改成参数数组形式的命令");
    const fix = repo.cli("verify", "--branch", "task/fix");
    assert.equal(fix.status, 0, fix.stderr);
  });

  test("doctor 列出主分支配置里所有写错的检查，不论这次是否会被选中", () => {
    const repo = setup({
      project: {
        ".harness/verify.json": verifyWith([
          { id: "web-unit", tier: "gate", when: ["web/**"], cwd: "web", selector: "vitest" },
          { id: "no-cmd", tier: "gate", when: ["api/**"] },
          { id: "unit", tier: "gate", when: ["src/**"], cmd: ["node", "-e", "process.exit(0)"] },
        ]),
      },
    });
    const result = repo.cli("doctor");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /\[!!\] project:verify: web-unit: selector vitest 已移除；no-cmd: gate 检查没有可执行的 cmd/);
    assert.match(result.stdout, /--changed/);
    assert.doesNotMatch(result.stdout, /；unit: /, "写对的检查不列出");
  });

  test("主分支前进但未触及检查范围时复用证据", () => {
    const repo = setup({
      project: {
        ".harness/verify.json": {
          version: 1,
          docOnly: { match: [], exclude: [] },
          checks: [{ id: "only-docs", tier: "gate", when: ["docs/**"], cmd: ["node", "-e", "process.exit(0)"] }],
          fullSuiteTriggers: { paths: [] },
        },
      },
    });
    repo.branch("task/a", { "docs/a.md": "a\n" });
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    commit(repo.root, "feat(other): 主分支前进\n\n- 只改代码\n- 不碰文档", { "src/o.js": "o\n" });
    const again = repo.cli("verify", "--branch", "task/a");
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stderr, /复用/);
  });
});

/** 主分支上改检查配置：模拟另一个已合入的任务改了 verify.json。 */
function changeMainChecks(repo, checks) {
  const verifyJson = JSON.parse(readFileSync(join(repo.root, ".harness/verify.json"), "utf8"));
  verifyJson.checks = checks(verifyJson.checks);
  commit(repo.root, "chore(harness): 调整检查\n\n- 修改检查配置\n- 模拟其他任务合入", {
    ".harness/verify.json": `${JSON.stringify(verifyJson, null, 2)}\n`,
  });
}
const FAIL_CMD = ["node", "-e", "process.exit(1)"];

describe("主分支在验证或评审之后前进", () => {
  test("主分支改了检查命令后，重新 verify 按新命令执行，不复用旧结果", () => {
    const repo = setup();
    repo.branch("task/a", { "src/a.js": "a\n" });
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    changeMainChecks(repo, (checks) => checks.map((check) => (check.id === "unit" ? { ...check, cmd: FAIL_CMD } : check)));
    const again = repo.cli("verify", "--branch", "task/a");
    assert.notEqual(again.status, 0, "改了命令的检查必须重跑并失败");
    assert.match(again.stderr, /-> unit:/);
  });

  test("主分支改了检查命令后，合并重新验证并按新命令拒绝", () => {
    const repo = setup();
    repo.branch("task/a", { "src/a.js": "a\n" });
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    writeReview(repo, git(repo.root, "rev-parse", "task/a"), "approve");
    changeMainChecks(repo, (checks) => checks.map((check) => (check.id === "unit" ? { ...check, cmd: FAIL_CMD } : check)));
    const status = repo.cli("status", "--branch", "task/a");
    assert.match(status.stdout, /检查配置在验证之后有变化/);
    const before = git(repo.root, "rev-parse", "main");
    const merged = repo.cli("merge", "--branch", "task/a");
    assert.notEqual(merged.status, 0);
    assert.match(merged.stderr, /verify_failed/);
    assert.equal(git(repo.root, "rev-parse", "main"), before);
  });

  test("主分支新增了覆盖本分支改动的检查后，合并补跑这项检查", () => {
    const repo = setup();
    repo.branch("task/a", { "src/a.js": "a\n" });
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    writeReview(repo, git(repo.root, "rev-parse", "task/a"), "approve");
    changeMainChecks(repo, (checks) => [...checks, { id: "extra", tier: "gate", when: ["src/**"], cmd: FAIL_CMD }]);
    const merged = repo.cli("merge", "--branch", "task/a");
    assert.notEqual(merged.status, 0);
    assert.match(merged.stderr, /-> extra:/);
    assert.match(merged.stderr, /verify_failed/);
  });

  test("主分支在评审之后改了本分支也改过的文件时拒绝合并，集成主分支并重新评审后放行", () => {
    const lines = (first, last) => [first, "2", "3", "4", "5", "6", last].join("\n") + "\n";
    const repo = setup({ files: { "src/shared.js": lines("1", "7") } });
    repo.branch("task/a", { "src/shared.js": lines("task", "7") });
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    writeReview(repo, git(repo.root, "rev-parse", "task/a"), "approve");
    commit(repo.root, "feat(other): 主分支改同一文件\n\n- 改另一处\n- 三方合并无冲突", { "src/shared.js": lines("1", "main") });

    const status = repo.cli("status", "--branch", "task/a");
    assert.notEqual(status.status, 0);
    assert.match(status.stdout, /主分支在评审之后改了本分支也改过的文件.*src\/shared\.js/);
    const before = git(repo.root, "rev-parse", "main");
    const rejected = repo.cli("merge", "--branch", "task/a");
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /review_stale/);
    assert.match(rejected.stderr, /src\/shared\.js/);
    assert.match(rejected.stderr, /git merge main/);
    assert.equal(git(repo.root, "rev-parse", "main"), before);

    git(repo.root, "checkout", "-q", "task/a");
    git(repo.root, "merge", "-q", "--no-edit", "main");
    git(repo.root, "checkout", "-q", "main");
    writeReview(repo, git(repo.root, "rev-parse", "task/a"), "approve");
    const merged = repo.cli("merge", "--branch", "task/a");
    assert.equal(merged.status, 0, merged.stderr);
    assert.equal(readFileSync(join(repo.root, "src/shared.js"), "utf8"), lines("task", "main"));
  });

  test("主分支只改了本分支没碰的文件时，评审继续有效", () => {
    const repo = setup();
    repo.branch("task/a", { "src/a.js": "a\n" });
    writeReview(repo, git(repo.root, "rev-parse", "task/a"), "approve");
    commit(repo.root, "feat(other): 主分支前进\n\n- 改别的文件\n- 与本分支无交集", { "src/other.js": "o\n" });
    const merged = repo.cli("merge", "--branch", "task/a");
    assert.equal(merged.status, 0, merged.stderr);
  });
});

describe("合并门禁", () => {
  test("无证据时自动验证并合并", () => {
    const repo = setup();
    repo.branch("task/b", { "b.txt": "b\n" });
    writeReview(repo, git(repo.root, "rev-parse", "task/b"), "approve");
    const before = git(repo.root, "rev-parse", "main");
    const result = repo.cli("merge", "--branch", "task/b");
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(git(repo.root, "rev-parse", "main"), before);
  });

  test("缺少评审时拒绝", () => {
    const repo = setup();
    repo.branch("task/a", { "a.txt": "a\n" });
    const result = repo.cli("merge", "--branch", "task/a");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /review_missing/);
  });

  test("评审为 reject 或含 high 发现时拒绝", () => {
    const repo = setup();
    repo.branch("task/a", { "a.txt": "a\n" });
    const head = git(repo.root, "rev-parse", "task/a");
    writeReview(repo, head, "reject");
    const rejected = repo.cli("merge", "--branch", "task/a");
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /review_blocked/);

    writeReview(repo, head, "approve", { blocking: [{ severity: "high" }] });
    const blocked = repo.cli("merge", "--branch", "task/a");
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /review_blocked/);
  });

  test("主工作树不干净时拒绝且不丢文件", () => {
    const repo = setup();
    repo.branch("task/a", { "a.txt": "a\n" });
    const head = git(repo.root, "rev-parse", "task/a");
    writeReview(repo, head, "approve");
    write(repo.root, "scratch.txt", "手写内容\n");
    const before = git(repo.root, "rev-parse", "main");
    const result = repo.cli("merge", "--branch", "task/a");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /未提交或未跟踪/);
    assert.equal(git(repo.root, "rev-parse", "main"), before);
    assert.equal(readFileSync(join(repo.root, "scratch.txt"), "utf8"), "手写内容\n");
  });

  test("冲突时拒绝并列出冲突文件", () => {
    const repo = setup({ files: { "c.txt": "base\n" } });
    repo.branch("task/a", { "c.txt": "task\n" });
    commit(repo.root, "feat(other): 改同一文件\n\n- 制造冲突\n- 主分支先行", { "c.txt": "main\n" });
    const result = repo.cli("merge", "--branch", "task/a");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /conflict/);
  });

  test("提交信息不规范或带共同作者行时拒绝", () => {
    const repo = setup();
    repo.branch("task/a", { "a.txt": "a" }, "update code");
    assert.match(repo.cli("merge", "--branch", "task/a").stderr, /bad_commit_message/);
    repo.branch("task/b", { "b.txt": "b" }, "feat(x): 增加\n\n- 一\n- 二\n\nCo-Authored-By: X <x@y>");
    assert.match(repo.cli("merge", "--branch", "task/b").stderr, /bad_commit_message/);
  });

  test("改动门禁配置时要求先人工确认，确认后可合并", () => {
    const repo = setup();
    repo.branch("task/gate", {
      "a.txt": "a\n",
      ".harness/policy.json": `${JSON.stringify({ version: 1, presets: ["secrets"], disabled: [], rules: [] }, null, 2)}\n`,
    });
    const head = git(repo.root, "rev-parse", "task/gate");
    writeReview(repo, head, "approve");
    const refused = repo.cli("merge", "--branch", "task/gate");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /gate_change_unconfirmed/);

    const summary = repo.cli("confirm", "--branch", "task/gate");
    assert.equal(summary.status, 0, summary.stderr);
    assert.match(summary.stdout, /拦截规则/);

    const approved = repo.cli("confirm", "--branch", "task/gate", "--yes");
    assert.equal(approved.status, 0, approved.stderr);
    const merged = repo.cli("merge", "--branch", "task/gate");
    assert.equal(merged.status, 0, merged.stderr);
  });

  test("确认摘要列出被关掉的预设规则", () => {
    const repo = setup();
    // 只改 disabled，不碰自有 rules：这类改动最需要人看见，摘要必须点名。
    repo.branch("task/gate", {
      "a.txt": "a\n",
      ".harness/policy.json": `${JSON.stringify(
        { version: 1, presets: ["secrets", "git-safety", "gate-self"], disabled: ["git-stash"], rules: [] },
        null,
        2,
      )}\n`,
    });
    const summary = repo.cli("confirm", "--branch", "task/gate");
    assert.equal(summary.status, 0, summary.stderr);
    assert.match(summary.stdout, /移除: git-stash/);
  });

  test("改坏规则的分支在验证阶段被黄金任务拦下", () => {
    const repo = setup({
      project: {
        ".harness/verify.json": {
          version: 1,
          docOnly: { match: [], exclude: [] },
          checks: [{ id: "harness-golden", tier: "gate", when: [".harness/**"], cmd: [".harness/bin/harness", "golden", "--worktree"] }],
          fullSuiteTriggers: { paths: [] },
        },
        ".harness/golden/tasks.json": {
          version: 1,
          tasks: [{ id: "g-rm", kind: "policy", steps: [{ kind: "shell", command: "rm -rf build", expect: "deny" }] }],
        },
      },
    });
    const policy = JSON.parse(readFileSync(join(repo.root, ".harness/policy.json"), "utf8"));
    repo.branch("task/weaken", {
      ".harness/policy.json": `${JSON.stringify({ ...policy, disabled: ["shell-recursive-delete"] }, null, 2)}\n`,
    });
    const result = repo.cli("verify", "--branch", "task/weaken");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /FAIL harness-golden/);
  });

  test("升级入口版本属于门禁改动，合并前需要确认", () => {
    const repo = setup();
    const shim = readFileSync(join(repo.root, ".harness/bin/harness"), "utf8");
    repo.branch("task/shim", { "a.txt": "a\n", ".harness/bin/harness": shim.replace(/:-[0-9.]+\}/, ":-9.9.9}") });
    writeReview(repo, git(repo.root, "rev-parse", "task/shim"), "approve");
    const refused = repo.cli("merge", "--branch", "task/shim");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /gate_change_unconfirmed/);
    assert.match(refused.stderr, /\.harness\/bin\/harness/);
  });

  test("确认绑定合并结果，内容再变即失效", () => {
    const repo = setup();
    repo.branch("task/gate", {
      "a.txt": "a\n",
      ".harness/policy.json": `${JSON.stringify({ version: 1, presets: ["secrets"], disabled: [], rules: [] }, null, 2)}\n`,
    });
    repo.cli("confirm", "--branch", "task/gate", "--yes");
    git(repo.root, "checkout", "-q", "task/gate");
    commit(repo.root, "fix(gate): 再改一次\n\n- 改了规则\n- 旧的确认应当失效", {
      ".harness/policy.json": `${JSON.stringify({ version: 1, presets: [], disabled: [], rules: [] }, null, 2)}\n`,
    });
    git(repo.root, "checkout", "-q", "main");
    const refused = repo.cli("merge", "--branch", "task/gate");
    assert.match(refused.stderr, /gate_change_unconfirmed|review_missing|verify/);
  });

  test("没有验收清单时仍可合并，只提示需求符合度会记 unknown", () => {
    const repo = setup();
    repo.branch("task/a", { "a.txt": "a\n" });
    const head = git(repo.root, "rev-parse", "task/a");
    writeReview(repo, head, "approve");
    const result = repo.cli("merge", "--branch", "task/a");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /没有验收清单/);
  });

  test("intent.mode=required 时缺少清单直接拒绝", () => {
    const repo = setup();
    const config = JSON.parse(readFileSync(join(repo.root, ".harness/config.json"), "utf8"));
    config.intent.mode = "required";
    writeFileSync(join(repo.root, ".harness/config.json"), `${JSON.stringify(config, null, 2)}\n`);
    const bypass = { ...repo.env, HARNESS_MAIN_BYPASS: "1" };
    git(repo.root, "add", "-A", bypass);
    git(repo.root, "commit", "-q", "--no-verify", "-m", "chore: 改为必需\n\n- 开启必需\n- 测试用", bypass);
    repo.branch("task/a", { "a.txt": "a\n" });
    const result = repo.cli("merge", "--branch", "task/a");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /intent_missing/);
  });

  test("分支自带的验收清单会被评审读到并标注来源", () => {
    const repo = setup();
    repo.branch("task/a", { "a.txt": "a\n", ".harness/acceptance/task-a.md": "- 验收 唯一标记\n" });
    const head = git(repo.root, "rev-parse", "task/a");
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    fakeReviewer(repo, APPROVE);
    const review = repo.cli("review", "--branch", "task/a");
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stderr, /验收清单来源: branch/);
    assert.match(readFileSync(join(repo.root, "..", "prompt.log"), "utf8"), /唯一标记/);
  });
});
