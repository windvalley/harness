import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { commitWith, git, makeRepo, PACKAGE_ROOT, sh } from "./helpers.mjs";
import { obligationKey } from "../src/verify/obligation.mjs";

const repos = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

const INPUT = {
  situation: "必要验证暂不可用",
  attempted: "已核对环境与定向入口",
  blocker: "仍需决定恢复方案",
  options: [{ id: "wait", summary: "等待恢复" }, { id: "repair", summary: "修复环境" }],
  defaultAction: "wait",
};
const SESSION = "binding-regression";
function setup(opts) {
  const repo = makeRepo(opts);
  repos.push(repo);
  return repo;
}
function moduleCall(repo, code) {
  const result = sh(repo.root, process.execPath, ["--input-type=module", "-e", code], repo.env);
  assert.equal(result.status, 0, result.stderr);
  return result;
}
function track(repo, branches) {
  moduleCall(repo, `
    import { noteSession } from ${JSON.stringify(join(PACKAGE_ROOT, "src/stop/session.mjs"))};
    noteSession(process.cwd(), { client: "claude", session: ${JSON.stringify(SESSION)}, branches: ${JSON.stringify(branches)} });
  `);
}
function stop(repo) {
  const result = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["hook", "--client", "claude", "--event", "stop"], repo.env,
    JSON.stringify({ session_id: SESSION, cwd: repo.root, hook_event_name: "Stop" }));
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function ledger(repo) {
  const file = join(repo.env.HARNESS_DATA_DIR, "ledger.jsonl");
  return existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
}
function open(repo, context) {
  const result = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["escalate", "open"], repo.env, JSON.stringify({ ...INPUT, context }));
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function invalidObligations(repo, branch, tip) {
  const dir = join(repo.env.HARNESS_DATA_DIR, "obligation");
  mkdirSync(dir, { recursive: true });
  return ["2026-11-12T00:00:00.000Z", { invalid: "timestamp" }, 42].map((createdAt, index) => {
    const key = obligationKey(`integrated-${index}`, tip);
    writeFileSync(join(dir, `${key}.json`), JSON.stringify({
      schema: 3, kind: "obligation", key, branch, branchTip: tip, checkId: `integrated-${index}`,
      check: { howToVerify: "运行真实集成验收", when: ["src/**"] }, createdAt, closedBy: null, signature: "0".repeat(64),
    }));
    return key;
  });
}
function writePending(repo, branch, tip) {
  moduleCall(repo, `
    import { writeObligations } from ${JSON.stringify(join(PACKAGE_ROOT, "src/verify/obligation.mjs"))};
    writeObligations({ root: process.cwd(), branch: ${JSON.stringify(branch)}, tip: ${JSON.stringify(tip)}, items: [{ id: "integrated", when: ["src/**"], howToVerify: "运行集成验收" }] });
  `);
}

test("本地分支有多条时间字段损坏且验签失败的义务时仍能上报，不采信伪造提交", () => {
  const repo = setup();
  const branch = "task/malformed";
  const head = repo.branch(branch, { "src/a.js": "a\n" });
  const keys = invalidObligations(repo, branch, "f".repeat(40));
  const record = open(repo, { branch, head: "f".repeat(40) });
  assert.equal(record.context.head, head);
  assert.deepEqual(record.context.obligations, keys.sort());
  assert.equal(repo.cli("status", "--post-merge").status, 1, "损坏记录仍是待验收义务，不能被当作完成");
});

test("删除分支后的损坏义务不会使整个 Stop 异常放行，上报绑定可信 main 后才允许等待", () => {
  const repo = setup();
  const branch = "task/deleted";
  const main = git(repo.root, "rev-parse", "main");
  invalidObligations(repo, branch, "f".repeat(40));
  track(repo, [branch]);
  const first = stop(repo);
  assert.equal(first?.decision, "block", JSON.stringify(first));
  assert.match(first.reason, /合并后验收待完成/);
  const record = open(repo, { branch, head: "f".repeat(40) });
  assert.equal(record.context.head, main, "不能用验签失败义务里的 branchTip 作绑定");
  assert.equal(stop(repo), null);
  assert.equal(repo.cli("status", "--post-merge").status, 1, "上报不关闭验收义务");
});

test("计划中、远端与已删除分支可保存通用上报，后建同名任务仍受 Stop 约束", () => {
  const repo = setup();
  const branches = ["task/planned", "task/remote-only", "task/removed"];
  const main = git(repo.root, "rev-parse", "main");
  git(repo.root, "update-ref", "refs/remotes/origin/task/remote-only", main);
  git(repo.root, "branch", "task/removed", main);
  git(repo.root, "branch", "-D", "task/removed");
  for (const branch of branches) {
    const record = open(repo, {
      branch,
      head: main,
      obligations: [],
      bindingStatus: "bound",
      bindingProblem: "伪造的绑定诊断",
    });
    assert.equal(record.context.branch, branch);
    assert.equal(record.context.head, undefined, "通用记录不能采信输入或远端 ref，伪装成本地绑定");
    assert.equal(record.context.obligations, undefined, "通用记录不能采信输入义务快照");
    assert.equal(record.context.bindingStatus, "unbound");
    assert.ok(record.context.bindingProblem);
    assert.notEqual(record.context.bindingProblem, "伪造的绑定诊断");
  }
  repo.branch("task/planned", { "src/a.js": "a\n" });
  track(repo, ["task/planned"]);
  const pending = stop(repo);
  assert.equal(pending?.decision, "block", JSON.stringify(pending));
  assert.match(pending.reason, /task\/planned/);
});

test("义务读取失败时保存的上报不能伪装成空快照，读取恢复后须重新绑定", () => {
  const repo = setup();
  const branch = "task/read-failure";
  const head = repo.branch(branch, { "src/a.js": "a\n" });
  const main = git(repo.root, "rev-parse", "main");
  writePending(repo, branch, main);
  track(repo, [branch]);
  const dir = join(repo.env.HARNESS_DATA_DIR, "obligation");
  const backup = `${dir}.backup`;
  renameSync(dir, backup);
  writeFileSync(dir, "义务目录暂时不可读取\n");
  let record;
  try {
    record = open(repo, {
      branch,
      head,
      obligations: [],
      bindingStatus: "bound",
      bindingProblem: "伪造的绑定诊断",
    });
    assert.equal(record.context.head, undefined, "读取失败不等于成功读取到空义务集合");
    assert.equal(record.context.obligations, undefined);
    assert.equal(record.context.bindingStatus, "unbound");
    assert.ok(record.context.bindingProblem);
    assert.notEqual(record.context.bindingProblem, "伪造的绑定诊断");
  } finally {
    rmSync(dir, { force: true });
    renameSync(backup, dir);
  }
  assert.equal(stop(repo)?.decision, "block", "恢复读取后通用上报不能成为可信放行记录");
  const reopened = open(repo, { branch });
  assert.equal(reopened.context.head, head);
  assert.ok(reopened.context.obligations.length > 0);
  assert.equal(stop(repo), null, "重新读取并绑定实际快照的上报才允许等待");
});

test("主分支配置损坏时本地任务仍可保存未绑定上报，配置恢复后重新打开才绑定", () => {
  const repo = setup();
  const config = git(repo.root, "show", "main:.harness/config.json");
  writeFileSync(join(repo.root, ".harness/config.json"), '{"mainBranch":\n');
  commitWith(repo.root, repo.env, "test: 损坏主分支配置");
  const branch = "task/config-failure";
  const head = repo.branch(branch, { "src/config.js": "config\n" });

  const unbound = open(repo, { branch, head: "f".repeat(40), obligations: ["伪造"], bindingStatus: "bound" });
  assert.equal(unbound.context.branch, branch);
  assert.equal(unbound.context.head, undefined, "配置读取失败不能回退到本地分支 HEAD");
  assert.equal(unbound.context.obligations, undefined, "配置读取失败不能伪造空义务快照");
  assert.equal(unbound.context.bindingStatus, "unbound");
  assert.ok(unbound.context.bindingProblem);

  git(repo.root, "checkout", "-q", "main");
  writeFileSync(join(repo.root, ".harness/config.json"), `${config}\n`);
  commitWith(repo.root, repo.env, "fix: 恢复主分支配置");

  const rebound = open(repo, { branch });
  assert.equal(rebound.context.branch, branch);
  assert.equal(rebound.context.head, head, "配置恢复后必须重新读取并绑定真实任务 ref");
  assert.equal(rebound.context.bindingStatus, undefined);
  assert.equal(rebound.context.bindingProblem, undefined);
});

test("没有上报时某分支读取义务失败不会使其他正常任务一起免于收尾检查", () => {
  const repo = setup();
  git(repo.root, "branch", "task/broken", "main");
  repo.branch("task/normal", { "src/normal.js": "normal\n" });
  track(repo, ["task/broken", "task/normal"]);
  const dir = join(repo.env.HARNESS_DATA_DIR, "obligation");
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  writeFileSync(dir, "not a directory\n");
  const pending = stop(repo);
  assert.equal(pending?.decision, "block", JSON.stringify(pending));
  assert.match(pending.reason, /task\/normal/);
  assert.match(pending.reason, /缺验证证据/);
  const errors = ledger(repo).filter((event) => event.event === "stop.error" && event.branch === "task/broken");
  assert.equal(errors.length, 1, "异常分支应记录一次 Stop 诊断");
  assert.equal(typeof errors[0].error, "string");
  assert.doesNotMatch(errors[0].error, /\/private\/tmp|HARNESS_DATA_DIR|harness-test-/);
});

test("通用上报和不可用绑定都不能补足失败 gate", () => {
  const repo = setup({ project: { ".harness/verify.json": { version: 1, checks: [
    { id: "failing", tier: "gate", when: ["src/**"], cmd: [process.execPath, "-e", "process.exit(2)"] },
  ], docOnly: { match: [], exclude: [] } } } });
  const branch = "task/failing";
  open(repo, { branch, head: "f".repeat(40), bindingStatus: "bound" });
  repo.branch(branch, { "src/a.js": "a\n" });
  assert.equal(repo.cli("verify", "--branch", branch).status, 1);
  const merge = repo.cli("merge", "--branch", branch);
  assert.equal(merge.status, 1);
  assert.match(merge.stderr, /verify_failed/);
});


test("已有上报绑定重新核对失败时只隔离该分支，其他正常任务继续收尾", () => {
  const repo = setup();
  repo.branch("task/bound-broken", { "src/broken.js": "broken\n" });
  repo.branch("task/normal", { "src/normal.js": "normal\n" });
  open(repo, { branch: "task/bound-broken" });
  track(repo, ["task/bound-broken", "task/normal"]);
  const dir = join(repo.env.HARNESS_DATA_DIR, "obligation");
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  writeFileSync(dir, "not a directory\n");
  const pending = stop(repo);
  assert.equal(pending?.decision, "block", JSON.stringify(pending));
  assert.match(pending.reason, /task\/normal/);
  assert.match(pending.reason, /缺验证证据/);
  const errors = ledger(repo).filter((event) => event.event === "stop.error" && event.branch === "task/bound-broken");
  assert.equal(errors.length, 1, "绑定快照读取失败不能静默视为空义务");
});

test("通用上报不能代替独立评审", () => {
  const repo = setup();
  const branch = "task/unreviewed";
  open(repo, { branch });
  repo.branch(branch, { "src/a.js": "a\n" });
  const verified = repo.cli("verify", "--branch", branch);
  assert.equal(verified.status, 0, verified.stderr);
  const merge = repo.cli("merge", "--branch", branch);
  assert.equal(merge.status, 1);
  assert.match(merge.stderr, /review_missing/);
});
