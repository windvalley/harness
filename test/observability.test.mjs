import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { git, makeRepo, PACKAGE_ROOT } from "./helpers.mjs";
import { listProjects, projectsFile, readProjects, rebindProject, registerProject } from "../src/observability/projects.mjs";
import { readObservedLedger } from "../src/observability/ledger.mjs";
import { buildSnapshot } from "../src/observability/snapshot.mjs";
import { readRecord } from "../src/lib/store.mjs";
import { buildTaskFunnel } from "../src/observability/analysis.mjs";

const repos = [];
const ENV_NAMES = ["HARNESS_OBSERVABILITY_DIR", "HARNESS_DATA_DIR", "HARNESS_KEY_DIR", "HARNESS_STORE", "HARNESS_CACHE_DIR", "HARNESS_REVIEWERS_FILE", "CODEX_HOME", "DSH_HOME"];
let savedEnv;

function setup(options) {
  const repo = makeRepo(options);
  repos.push(repo);
  return repo;
}

function useEnv(env, override = {}) {
  savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) {
    if (name === "HARNESS_DATA_DIR") continue;
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
  delete process.env.HARNESS_DATA_DIR;
  Object.assign(process.env, override);
}

afterEach(() => {
  if (savedEnv) {
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  }
  savedEnv = null;
  while (repos.length) repos.pop().cleanup();
});

function writeLedger(repo, events, actualGitDir = false) {
  const dir = actualGitDir ? join(repo.root, ".git", "harness") : repo.env.HARNESS_DATA_DIR;
  mkdirSync(dir, { recursive: true });
  if (actualGitDir) writeFileSync(join(dir, "owner.json"), "{\"tool\":\"harness\"}\n");
  writeFileSync(join(dir, "ledger.jsonl"), `${events.map((event) => typeof event === "string" ? event : JSON.stringify(event)).join("\n")}\n`);
}

describe("本机项目注册", () => {
  test("安装自动登记，Linked Worktree 与重复添加保持同一项目", () => {
    const repo = setup();
    useEnv(repo.env);
    const first = readProjects().projects;
    assert.equal(first.length, 1);
    assert.equal(first[0].status, "active");
    const added = repo.rawCli("projects", "add", repo.root);
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /已存在/);
    const linked = join(repo.root, "..", "linked");
    git(repo.root, "worktree", "add", "-q", "-b", "task/observed", linked);
    useEnv(repo.env);
    registerProject(linked, { version: "1.2.3" });
    const list = listProjects();
    assert.equal(list.length, 1);
    assert.equal(list[0].projectId, first[0].projectId);
    assert.equal(list[0].lastHarnessVersion, "1.2.3");
    const output = repo.rawCli("projects", "list", "--json");
    assert.equal(output.status, 0, output.stderr);
    assert.equal(JSON.parse(output.stdout).projects.length, 1);
    assert.equal((statSync(projectsFile()).mode & 0o777), 0o600);
  });

  test("卸载保留历史，移动后只能显式重新绑定", () => {
    const repo = setup();
    useEnv(repo.env);
    const before = readProjects().projects[0];
    assert.equal(repo.cli("uninstall").status, 0);
    assert.equal(readProjects().projects[0].status, "uninstalled");
    const moved = join(repo.root, "..", "moved");
    renameSync(repo.root, moved);
    useEnv(repo.env);
    assert.equal(listProjects()[0].status, "uninstalled");
    const rebound = rebindProject(before.projectId, moved);
    assert.equal(rebound.projectId, before.projectId);
    assert.equal(rebound.status, "active");
    assert.equal(readProjects().projects.length, 1);
  });

  test("并发登记不会丢失项目或产生重复", async () => {
    const first = setup();
    const second = setup();
    const shared = join(first.root, "..", "shared-observability");
    useEnv(first.env, { HARNESS_OBSERVABILITY_DIR: shared });
    const script = join(PACKAGE_ROOT, "bin", "harness.mjs");
    const env = { ...process.env, HARNESS_OBSERVABILITY_DIR: shared };
    const run = (root) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, "projects", "add", root], { env });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (status) => status === 0 ? resolve() : reject(new Error(stderr)));
    });
    await Promise.all(Array.from({ length: 8 }, (_, index) => run(index % 2 === 0 ? first.root : second.root)));
    const projects = readProjects().projects;
    assert.equal(projects.length, 2);
    assert.equal(new Set(projects.map((project) => project.projectId)).size, 2);
  });
});

describe("只读账本与跨项目快照", () => {
  test("读取账本、记录和健康快照不创建项目数据或密钥", () => {
    const repo = setup({ install: false });
    useEnv(repo.env);
    registerProject(repo.root);
    const dataDir = join(repo.root, ".git", "harness");
    assert.equal(existsSync(dataDir), false);
    assert.equal(readObservedLedger(repo.root).events.length, 0);
    assert.equal(readRecord(repo.root, "evidence", "missing").code, "missing");
    const snapshot = buildSnapshot({ days: 30, now: Date.parse("2026-11-30T00:00:00.000Z") });
    assert.equal(snapshot.projects.length, 1);
    assert.equal(snapshot.projects[0].state, "no_data");
    assert.equal(existsSync(dataDir), false);
    assert.equal(existsSync(repo.env.HARNESS_KEY_DIR), false);
  });

  test("旧事件、重复 ID、坏行和未知事件进入覆盖范围，敏感字段被过滤", () => {
    const repo = setup({ install: false });
    useEnv(repo.env, { HARNESS_DATA_DIR: repo.env.HARNESS_DATA_DIR });
    writeLedger(repo, [
      { at: "2026-11-01T00:00:00.000Z", event: "verify", tree: "t1", status: "failed", note: "token=do-not-return" },
      { id: "same", at: "2026-11-02T00:00:00.000Z", event: "verify", tree: "t1", status: "passed" },
      { id: "same", at: "2026-11-02T00:00:00.000Z", event: "verify", tree: "t1", status: "passed" },
      { at: "2026-11-03T00:00:00.000Z", event: "future.event", url: "https://user:password@example.test/private" },
      "not-json",
      { at: "invalid", event: "verify" },
    ]);
    const result = readObservedLedger(repo.root);
    assert.equal(result.events.length, 3);
    assert.equal(result.coverage.legacyEvents, 2);
    assert.equal(result.coverage.duplicateEvents, 1);
    assert.equal(result.coverage.unknownEvents, 1);
    assert.equal(result.coverage.invalidLines, 1);
    assert.equal(result.coverage.invalidTimestamps, 1);
    assert.doesNotMatch(JSON.stringify(result), /do-not-return|password@example/);
    assert.ok(result.warnings.every((warning) => typeof warning.code === "string"));
  });

  test("跨项目相同 tree 分开计算，先取完整历史首验再套滚动窗口", () => {
    const first = setup();
    const second = setup();
    const shared = join(first.root, "..", "shared-observability");
    first.env.HARNESS_OBSERVABILITY_DIR = shared;
    useEnv(first.env, { HARNESS_OBSERVABILITY_DIR: shared });
    registerProject(first.root);
    registerProject(second.root);
    writeLedger(first, [
      { at: "2026-10-01T00:00:00.000Z", event: "verify", tree: "same", status: "failed" },
      { at: "2026-11-29T00:00:00.000Z", event: "verify", tree: "same", status: "passed", durationMs: 100 },
    ], true);
    writeLedger(second, [
      { at: "2026-11-28T00:00:00.000Z", event: "verify", tree: "same", status: "passed", durationMs: 300 },
      { at: "2026-11-28T01:00:00.000Z", event: "review", outcome: "completed", verdict: "reject" },
    ], true);
    const snapshot = buildSnapshot({ days: 7, now: Date.parse("2026-11-30T00:00:00.000Z"), includeHealth: false });
    assert.equal(snapshot.projects.length, 2);
    assert.equal(snapshot.metrics.total.verifyRuns, 2);
    assert.equal(snapshot.metrics.total.verifyTrees, 1);
    assert.equal(snapshot.metrics.total.verifyFirstPassRate, 1);
    assert.equal(snapshot.metrics.total.reviewRejectRate, 1);
    assert.equal(snapshot.metrics.total.verifyDurationMedianMs, 200);
    assert.equal(snapshot.coverage.registeredProjects, 2);
    assert.equal(snapshot.schemaVersion, 1);
    assert.deepEqual(Object.keys(snapshot.timeRange), ["days", "since", "until", "weekBoundary"]);
    first.env.HARNESS_DATA_DIR = "";
    const cli = first.rawCli("metrics", "--all", "--days", "7", "--json");
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).metrics.total.verifyFirstPassRate, 1);
    const doctor = first.rawCli("doctor", "--json");
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(JSON.parse(doctor.stdout).root, realpathSync(first.root));
  });

  test("账本缓存命中后零读取，追加时只读新增内容且不重复计数", () => {
    const repo = setup({ install: false });
    useEnv(repo.env, { HARNESS_DATA_DIR: repo.env.HARNESS_DATA_DIR });
    const project = registerProject(repo.root).project;
    writeLedger(repo, [{ id: "one", at: "2026-11-01T00:00:00.000Z", event: "verify", tree: "t1", status: "passed" }]);
    const first = readObservedLedger(repo.root, { projectId: project.projectId });
    assert.equal(first.coverage.readMode, "full");
    assert.ok(first.coverage.bytesRead > 0);
    const second = readObservedLedger(repo.root, { projectId: project.projectId });
    assert.equal(second.coverage.readMode, "cache_hit");
    assert.equal(second.coverage.bytesRead, 0);
    writeFileSync(join(repo.env.HARNESS_DATA_DIR, "ledger.jsonl"), `${JSON.stringify({ id: "two", at: "2026-11-02T00:00:00.000Z", event: "review", outcome: "completed", verdict: "approve" })}\n`, { flag: "a" });
    const third = readObservedLedger(repo.root, { projectId: project.projectId });
    assert.equal(third.coverage.readMode, "append");
    assert.equal(third.events.length, 2);
    assert.equal(third.coverage.duplicateEvents, 0);
    assert.ok(third.coverage.bytesRead < third.coverage.bytes);
    const fourth = readObservedLedger(repo.root, { projectId: project.projectId });
    assert.equal(fourth.coverage.readMode, "cache_hit");
    assert.equal(fourth.events.length, 2);
  });

  test("健康历史只由显式采样生成并保留配置来源", () => {
    const repo = setup();
    useEnv(repo.env);
    registerProject(repo.root);
    const first = buildSnapshot({ days: 30, now: Date.parse("2026-11-01T00:00:00.000Z") });
    assert.equal(first.projects[0].healthHistory.length, 0);
    const second = buildSnapshot({ days: 30, now: Date.parse("2026-11-02T00:00:00.000Z"), captureHealth: true });
    assert.equal(second.projects[0].healthHistory.length, 1);
    assert.equal(second.projects[0].healthHistory[0].capturedAt, "2026-11-02T00:00:00.000Z");
    const third = buildSnapshot({ days: 30, now: Date.parse("2026-11-03T00:00:00.000Z"), captureHealth: true });
    assert.equal(third.projects[0].healthHistory.length, 2);
    assert.ok(third.projects[0].healthHistory.every((sample) => sample.config.sourceCommit));
    assert.ok(third.healthHistory.every((sample) => sample.projectId === third.projects[0].projectId));
  });

  test("任务漏斗只关联稳定 taskId，并区分无法关联事件", () => {
    const project = {
      projectId: "p1",
      displayName: "demo",
      mainWorktree: "/repo",
      _events: [
        { at: "2026-11-01T00:00:00.000Z", event: "verify", taskId: "feature/a@base", branch: "feature/a" },
        { at: "2026-11-02T00:00:00.000Z", event: "review", outcome: "completed", taskId: "feature/a@base", branch: "feature/a" },
        { at: "2026-11-03T00:00:00.000Z", event: "submit.ready", taskId: "feature/a@base", branch: "feature/a", head: "remote-head" },
        { at: "2026-11-04T00:00:00.000Z", event: "sync", from: "old-main", to: "new-main" },
        { at: "2026-11-01T00:00:00.000Z", event: "verify", taskId: "fix/b@base", branch: "fix/b" },
        { at: "2026-11-02T00:00:00.000Z", event: "merge", taskId: "fix/b@base", branch: "fix/b", head: "merge-head" },
        { at: "2026-11-03T00:00:00.000Z", event: "verify", branch: "legacy/no-id" },
      ],
    };
    const result = buildTaskFunnel(project, {
      isAncestor: (root, ancestor, descendant) => ancestor === "remote-head" && descendant === "new-main",
    });
    assert.equal(result.tasks.length, 2);
    assert.equal(result.unlinkedEvents, 1);
    const remote = result.tasks.find((task) => task.taskId === "feature/a@base");
    assert.deepEqual(remote.stages, { verify: true, review: true, delivery: true, sync: true });
    assert.equal(remote.syncAt, "2026-11-04T00:00:00.000Z");
    const local = result.tasks.find((task) => task.taskId === "fix/b@base");
    assert.equal(local.delivery.kind, "merge");
    assert.equal(local.stages.sync, false);
  });
});
