import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CONFIG, commit, git, makeRepo } from "./helpers.mjs";

const repos = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

const check = (id, code, extra = {}) => ({ id, tier: "gate", when: ["src/**"], cmd: [process.execPath, "-e", code], ...extra });
function setup(checks, { config = {}, verify = {} } = {}) {
  const repo = makeRepo({ project: {
    ".harness/config.json": { ...CONFIG, verify: { ...CONFIG.verify, ...config } },
    ".harness/verify.json": { version: 1, checks, docOnly: { match: [], exclude: [] }, ...verify },
  } });
  repos.push(repo);
  repo.branch("task/outcomes", { "src/example.js": "export const value = 1;\n" });
  return repo;
}
function run(repo) {
  const result = repo.cli("verify", "--branch", "task/outcomes");
  const head = git(repo.root, "rev-parse", "task/outcomes");
  return { ...result, record: JSON.parse(readFileSync(join(repo.env.HARNESS_DATA_DIR, "evidence", `${head}.json`), "utf8")) };
}

test("普通非零保留命令失败，fail-fast 完整记录后续检查与测试证据", () => {
  const repo = setup([check("first", "console.error('network unavailable'); process.exit(7)"), check("later", "process.exit(0)")], {
    verify: { coverage: { include: { match: ["src/**"], exclude: [] }, cmd: [process.execPath, "-e", "process.exit(0)"], report: "coverage/lcov.info" } },
  });
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.equal(result.record.status, "failed");
  assert.deepEqual(result.record.checks.map(({ id, outcome, reasonCode }) => [id, outcome, reasonCode]), [
    ["first", "failed", "command_failed"],
    ["later", "not_run", "fail_fast"],
    ["harness:changed-line-coverage", "not_run", "prerequisite_failed"],
  ]);
  assert.deepEqual(result.record.plan.map(({ id }) => id), ["first", "later", "harness:changed-line-coverage"]);
  assert.deepEqual(result.record.checks[1].blockedBy, ["first"]);
  assert.deepEqual(result.record.notExecuted.map(({ id }) => id), ["later", "harness:changed-line-coverage"]);
  assert.match(result.stderr, /NOT_RUN later/);
});

test("缺工具归为执行阻塞，状态给出环境动作但仍禁止合并", () => {
  const repo = setup([check("missing", "", { cmd: ["harness-missing-outcome-command-xyz"] })]);
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.equal(result.record.checks[0].outcome, "blocked");
  assert.equal(result.record.checks[0].reasonCode, "missing_command");
  assert.equal(result.record.checks[0].spawnError, "ENOENT");
  assert.match(result.stderr, /BLOCKED missing/);
  const status = repo.cli("status", "--branch", "task/outcomes");
  assert.match(status.stdout, /安装.*工具|补齐.*工具/);
  assert.doesNotMatch(status.stdout, /需要修好后重跑/);
  assert.equal(repo.cli("merge", "--branch", "task/outcomes").status, 1);
});

test("超时有结构化原因，不从日志推断", () => {
  const repo = setup([check("slow", "setInterval(() => {}, 1000)")], { config: { timeoutSeconds: 0.2 } });
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.equal(result.record.checks[0].outcome, "blocked");
  assert.equal(result.record.checks[0].reasonCode, "timeout");
  assert.equal(result.record.checks[0].signal, "SIGKILL");
  assert.match(repo.cli("status", "--branch", "task/outcomes").stdout, /超时/);
});

test("进程被信号终止与普通非零退出区分", () => {
  const repo = setup([check("terminated", "process.kill(process.pid, 'SIGTERM')")]);
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.equal(result.record.checks[0].reasonCode, "signal");
  assert.equal(result.record.checks[0].signal, "SIGTERM");
});

test("不存在的工作目录属于启动失败，不误报缺少命令", () => {
  const repo = setup([check("cwd", "process.exit(0)", { cwd: "does-not-exist" })]);
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.equal(result.record.checks[0].reasonCode, "spawn_error");
  assert.doesNotMatch(result.stderr, /未找到命令/);
});

test("缺依赖记录为阻塞，其他独立检查仍可运行", () => {
  const repo = setup([check("dependency", "process.exit(0)", { requires: ["missing-dependencies"] }), check("independent", "console.log('independent')")]);
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.equal(result.record.status, "incomplete");
  assert.equal(result.record.checks[0].outcome, "blocked");
  assert.equal(result.record.checks[0].reasonCode, "missing_dependency");
  assert.equal(result.record.checks[1].outcome, "passed");
  assert.match(repo.cli("status", "--branch", "task/outcomes").stdout, /依赖/);
});

test("配置错误导致的未运行项有明确阻塞关联", () => {
  const repo = setup([{ id: "invalid", tier: "gate", when: ["src/**"] }, check("later", "process.exit(0)")]);
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.equal(result.record.checks[0].reasonCode, "invalid_config");
  assert.equal(result.record.checks[1].outcome, "not_run");
  assert.deepEqual(result.record.checks[1].blockedBy, ["invalid"]);
  assert.match(repo.cli("status", "--branch", "task/outcomes").stdout, /配置/);
});

test("关闭 failFast 时继续执行，不能凭错误文本判定外部故障", () => {
  const repo = setup([check("failed", "console.error('ENOENT timeout existing issue'); process.exit(2)"), check("passed", "process.exit(0)")], { config: { failFast: false } });
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.deepEqual(result.record.checks.map(({ outcome, reasonCode }) => [outcome, reasonCode]), [["failed", "command_failed"], ["passed", "passed"]]);
  assert.equal(result.record.notExecuted.length, 0);
});


test("覆盖率命令的缺工具保留执行阻塞原因", () => {
  const repo = setup([{...check("trigger", "process.exit(0)"), when: ["src/**"]}], { verify: { coverage: {
    include: { match: ["src/**"], exclude: [] },
    cmd: ["harness-missing-coverage-command-xyz"], report: "coverage/lcov.info",
  } } });
  const result = run(repo);
  assert.equal(result.status, 1);
  const coverage = result.record.checks.find((item) => item.id === "harness:changed-line-coverage");
  assert.equal(coverage.outcome, "blocked");
  assert.equal(coverage.reasonCode, "missing_command");
});

test("TDD 还原后的超时不能充当有效红灯", () => {
  const repo = setup([], { config: { timeoutSeconds: 0.2 }, verify: { testFirst: {
    source: { match: ["src/**"], exclude: [] },
    tests: { match: ["test/**"], exclude: [] },
    cmd: [process.execPath, "test/example.cjs"],
  } } });
  git(repo.root, "checkout", "task/outcomes");
  commit(repo.root, "test: 增加验收测试\n\n- 当前源码存在时通过\n- 源码还原后模拟超时", {
    "test/example.cjs": "if (!require('fs').existsSync('src/example.js')) setInterval(() => {}, 1000);\n",
  });
  git(repo.root, "checkout", "main");
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.equal(result.record.checks[0].outcome, "blocked");
  assert.equal(result.record.checks[0].reasonCode, "timeout");
});

test("观察模式保留实际阻塞原因，单独声明不阻断且不复用失败结果", () => {
  const repo = setup([], { verify: { coverage: {
    mode: "observe", include: { match: ["src/**"], exclude: [] },
    cmd: ["harness-missing-observe-command-xyz"], report: "coverage/lcov.info",
  } } });
  const result = run(repo);
  assert.equal(result.status, 0, "观察模式维持不阻断");
  const item = result.record.checks[0];
  assert.equal(item.exit, 0);
  assert.equal(item.observed, true);
  assert.equal(item.outcome, "blocked");
  assert.equal(item.reasonCode, "missing_command");
  const again = run(repo);
  assert.equal(again.record.checks[0].reused, undefined, "观察到的阻塞不能当已通过的结果复用");
});


test("fail-fast 保留未受影响的普通检查与测试证据复用，统计只计实际复用", () => {
  const repo = setup([
    check("first", "process.exit(require('node:fs').existsSync(process.env.HARNESS_TEST_REUSE_FAILURE) ? 7 : 0)", { when: ["src/example.js"] }),
    check("second", "process.exit(0)", { when: ["src/second.js"] }),
  ], { verify: { coverage: {
    include: { match: ["src/second.js"], exclude: [] },
    cmd: [process.execPath, "-e", "require('node:fs').mkdirSync('coverage', {recursive:true}); require('node:fs').writeFileSync('coverage/lcov.info', 'SF:src/second.js\\nDA:1,1\\nend_of_record\\n')"],
    report: "coverage/lcov.info",
  } } });
  git(repo.root, "checkout", "task/outcomes");
  commit(repo.root, "feat: 增加另一验收范围\n\n- 独立验证第二个文件", { "src/second.js": "export const second = 2;\n" });
  git(repo.root, "checkout", "main");
  const failure = join(repo.root, "..", "fail-first");
  repo.env.HARNESS_TEST_REUSE_FAILURE = failure;
  assert.equal(run(repo).status, 0, "首次验证建立可复用证据");

  commit(repo.root, "feat: 推进首项检查的主分支范围\n\n- 只使首项检查的证据过期", { "src/example.js": "export const value = 'fail';\n" });
  writeFileSync(failure, "fail first\n");
  const result = run(repo);
  assert.equal(result.status, 1, "首项失败仍阻断整体验证");
  assert.equal(result.record.status, "failed");
  assert.deepEqual(result.record.checks.map(({ id, outcome, reused }) => [id, outcome, Boolean(reused)]), [
    ["first", "failed", false],
    ["second", "passed", true],
    ["harness:changed-line-coverage", "passed", true],
  ]);
  assert.deepEqual(result.record.notExecuted, []);
  assert.deepEqual(result.record.reusedChecks, ["second", "harness:changed-line-coverage"]);
  assert.match(result.stderr, /PASS second \(复用\)/);
  assert.doesNotMatch(result.stderr, /NOT_RUN second|NOT_RUN harness:changed-line-coverage/);
  const events = readFileSync(join(repo.env.HARNESS_DATA_DIR, "ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(events.filter((event) => event.event === "verify").at(-1).reused, 2);
  assert.equal(repo.cli("merge", "--branch", "task/outcomes").status, 1, "有效复用不会消除失败 gate");
});
