import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { git, makeRepo, sh } from "./helpers.mjs";
import { answerEscalation, listEscalations, openEscalation, readEscalation, resolveEscalation, resumePlan } from "../src/escalate/escalate.mjs";

let repos = [];
const originalEnv = new Map();
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnv.clear();
});

function setup() {
  const repo = makeRepo({ install: false });
  repos.push(repo);
  for (const [name, value] of Object.entries(repo.env)) {
    if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  return repo;
}

const INPUT = {
  situation: "验证工具暂时不可用",
  attempted: ["检查工具安装与版本"],
  blocker: "工具无法启动",
  options: [{ id: "wait", summary: "等待工具恢复" }, { id: "repair", summary: "修复本机工具" }],
  defaultAction: "wait",
};

describe("上报版本绑定与技术消除", () => {
  test("自动绑定本地分支的实际 SHA，不采信输入的 head", () => {
    const repo = setup();
    const head = repo.branch("task/a", { "src/a.js": "a\n" });
    const record = openEscalation(repo.root, { ...INPUT, context: { branch: "task/a", head: "f".repeat(40), check: "unit" } });
    assert.deepEqual(record.context, { branch: "task/a", head, check: "unit" });

    const current = openEscalation(repo.root, { ...INPUT, context: { head } });
    assert.equal(current.context.branch, "main");
    assert.equal(current.context.head, git(repo.root, "rev-parse", "main"));
    assert.throws(() => openEscalation(repo.root, { ...INPUT, context: { branch: "task/a~0" } }), /找不到/);
  });

  test("技术消除保留上报事实并登记原因与证据，不伪造人的答复", () => {
    const repo = setup();
    const opened = openEscalation(repo.root, INPUT);
    const resolved = resolveEscalation(repo.root, opened.id, { reason: "重新安装工具后真实检查通过", evidence: "verify:unit/run-2" });
    const stored = readEscalation(repo.root, opened.id);
    const resumed = resumePlan(repo.root, opened.id);
    assert.equal(resolved.status, "resolved");
    assert.deepEqual(resolved.resolution, { reason: "重新安装工具后真实检查通过", evidence: "verify:unit/run-2" });
    assert.ok(resolved.resolvedAt);
    assert.equal(resolved.openedAt, opened.openedAt);
    for (const key of ["situation", "attempted", "blocker", "options", "defaultAction", "context"]) assert.deepEqual(resolved[key], opened[key], key);
    assert.equal(Object.hasOwn(resolved, "answer"), false);
    assert.deepEqual(stored, resolved);
    assert.equal(resumed.ready, true);
    assert.equal(resumed.status, "resolved");
    assert.deepEqual(resumed.resolution, resolved.resolution);
    assert.equal(Object.hasOwn(resumed, "chosen"), false);
    assert.equal(Object.hasOwn(resumed, "decision"), false);
    assert.deepEqual(listEscalations(repo.root, "open"), []);
    const events = readFileSync(join(repo.env.HARNESS_DATA_DIR, "ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.filter((event) => event.event.startsWith("escalate.")).map((event) => event.event), ["escalate.open", "escalate.resolve"]);
  });

  test("CLI 可创建、技术消除与续跑，缺参拒绝且原失败门禁继续阻断", () => {
    const repo = makeRepo({ project: { ".harness/verify.json": { version: 1, checks: [
      { id: "failing", tier: "gate", when: ["src/**"], cmd: [process.execPath, "-e", "process.exit(2)"] },
    ], docOnly: { match: [], exclude: [] } } } });
    repos.push(repo);
    const head = repo.branch("task/cli", { "src/a.js": "a\n" });
    const opened = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["escalate", "open"], repo.env, JSON.stringify({ ...INPUT, context: { branch: "task/cli" } }));
    assert.equal(opened.status, 0, opened.stderr);
    const record = JSON.parse(opened.stdout);
    assert.equal(record.context.head, head);
    assert.notEqual(repo.cli("escalate", "resolve", "--id", record.id, "--reason", "工具恢复").status, 0);
    assert.equal(repo.cli("escalate", "resume", "--id", record.id).status, 1);
    const resolved = repo.cli("escalate", "resolve", "--id", record.id, "--reason", "工具恢复", "--evidence", "tool-probe:passed");
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(JSON.parse(resolved.stdout).status, "resolved");
    const resumed = repo.cli("escalate", "resume", "--id", record.id);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(Object.hasOwn(JSON.parse(resumed.stdout), "chosen"), false);
    assert.equal(repo.cli("verify", "--branch", "task/cli").status, 1);
    const merge = repo.cli("merge", "--branch", "task/cli");
    assert.equal(merge.status, 1);
    assert.match(merge.stderr, /verify_failed/);
  });

  test("技术消除必须提供非空原因和证据，终态记录不能改写", () => {
    const repo = setup();
    const opened = openEscalation(repo.root, INPUT);
    const errors = [];
    for (const resolution of [{ evidence: "run-2" }, { reason: "已恢复" }, { reason: " ", evidence: "run-2" }, { reason: "已恢复", evidence: " " }]) {
      try { resolveEscalation(repo.root, opened.id, resolution); } catch (error) { errors.push(error.message); }
    }
    answerEscalation(repo.root, opened.id, { choice: "wait", note: "由人决定等待" });
    try { resolveEscalation(repo.root, opened.id, { reason: "已恢复", evidence: "run-2" }); } catch (error) { errors.push(error.message); }
    const another = openEscalation(repo.root, INPUT);
    resolveEscalation(repo.root, another.id, { reason: "已恢复", evidence: "run-2" });
    try { answerEscalation(repo.root, another.id, { choice: "repair" }); } catch (error) { errors.push(error.message); }
    assert.equal(errors.length, 6);
    assert.match(errors[0], /reason|原因/);
    assert.match(errors[1], /evidence|证据/);
    assert.match(errors[4], /answered/);
    assert.match(errors[5], /resolved/);
  });
});
