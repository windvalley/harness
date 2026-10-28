import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, commit, fakeReviewer, git, makeRepo, write, writeReview } from "./helpers.mjs";
import { planChecks, reusableChecks } from "../src/verify/verify.mjs";

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
