import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, commit, fakeReviewer, git, makeRepo } from "./helpers.mjs";
import { verifyConfigProblems } from "../src/verify/verify.mjs";
import { attestCheck } from "../src/verify/attestation.mjs";
import { splitAcceptance } from "../src/lib/acceptance.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

const VERIFY = {
  version: 1,
  docOnly: { match: ["docs/**", "**/*.md"], exclude: [] },
  checks: [
    { id: "unit", tier: "gate", when: ["src/**"], cmd: ["node", "-e", "process.exit(0)"] },
    { id: "browser", tier: "extended", when: ["src/**"], reason: "需要真实浏览器", howToVerify: "运行本地浏览器验收" },
    { id: "integrated-smoke", tier: "extended", phase: "post-merge", when: ["src/**"], reason: "需要目标分支集成状态", howToVerify: "在合并后的主 Worktree 运行冒烟测试" },
  ],
  fullSuiteTriggers: { paths: [] },
};

const ACCEPTANCE = `# 验收清单

## 应该发生

- 本地行为正确。

## 合并后验收

- 主 Worktree 集成后的冒烟测试通过。
`;

function setup() {
  const repo = makeRepo({ project: { ".harness/verify.json": VERIFY } });
  repos.push(repo);
  return repo;
}

function task(repo) {
  return repo.branch("task/a", { "src/a.js": "a\n", ".harness/acceptance/task-a.md": ACCEPTANCE });
}

function extend(repo, files, message = "docs(demo): 补充说明\n\n- 只更新文档\n- 不改检查覆盖文件") {
  git(repo.root, "checkout", "-q", "task/a");
  const head = commit(repo.root, message, files);
  git(repo.root, "checkout", "-q", "main");
  return head;
}

function attest(repo, check = "browser", content = "224/224 passed\n") {
  const report = join(repo.root, "..", `${check}-report.md`);
  writeFileSync(report, content);
  return repo.cli("attest", "--branch", "task/a", "--check", check, "--command", "run browser acceptance", "--report", report);
}

function evidence(repo, head) {
  return JSON.parse(readFileSync(join(repo.env.HARNESS_DATA_DIR, "evidence", `${head}.json`), "utf8"));
}

describe("外部证据登记", () => {
  test("extended 检查登记后进入正式证据和评审输入，不再显示未执行", () => {
    const repo = setup();
    const head = task(repo);
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    assert.equal(evidence(repo, head).notExecuted[0].id, "browser");

    const registered = attest(repo);
    assert.equal(registered.status, 0, registered.stderr);
    const verified = repo.cli("verify", "--branch", "task/a");
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stderr, /ATTESTED browser/);
    assert.doesNotMatch(verified.stderr, /NOT_EXECUTED browser/);
    const record = evidence(repo, head);
    assert.equal(record.attested[0].id, "browser");
    assert.match(record.attested[0].report.excerpt, /224\/224 passed/);
    assert.equal(record.postMerge[0].id, "integrated-smoke");

    fakeReviewer(repo, APPROVE);
    const reviewed = repo.cli("review", "--branch", "task/a");
    assert.equal(reviewed.status, 0, reviewed.stderr);
    const prompt = readFileSync(join(repo.root, "..", "prompt.log"), "utf8");
    assert.match(prompt, /外部证据 browser/);
    assert.match(prompt, /224\/224 passed/);
    assert.match(prompt, /合并后验收.*不作为本次需求符合度判定/s);
    const preMerge = prompt.split("## 合并后验收")[0];
    assert.doesNotMatch(preMerge, /主 Worktree 集成后的冒烟测试通过/);
  });

  test("证据绑定检查覆盖文件的内容，文档提交可复用，源码变化后失效", () => {
    const repo = setup();
    task(repo);
    assert.equal(attest(repo).status, 0);
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);

    const docsHead = extend(repo, { "docs/note.md": "note\n" });
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    assert.equal(evidence(repo, docsHead).attested[0].id, "browser");

    const sourceHead = extend(repo, { "src/a.js": "changed\n" }, "fix(demo): 修改源码\n\n- 改变检查覆盖文件\n- 外部证据应失效");
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    assert.equal(evidence(repo, sourceHead).attested.length, 0);
    assert.match(evidence(repo, sourceHead).notExecuted[0].reason, /证据已过期/);
  });

  test("只接受已配置 extended 检查的真实报告", () => {
    const repo = setup();
    task(repo);
    const unknown = attest(repo, "unknown");
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /不存在.*extended 检查/);
    const gate = attest(repo, "unit");
    assert.notEqual(gate.status, 0);
    assert.match(gate.stderr, /不存在.*extended 检查/);
    const missing = repo.cli("attest", "--branch", "task/a", "--check", "browser", "--command", "run browser", "--report", join(repo.root, "..", "missing.md"));
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /报告不存在/);
  });

  test("验收章节只识别真实标题，注释里的示例不生效", () => {
    const split = splitAcceptance("# 验收\n\n- 合并前\n\n<!--\n## 合并后验收\n- 示例\n-->\n");
    assert.match(split.preMergeText, /合并前/);
    assert.equal(split.postMergeText, "");
  });
});

describe("合并后验收", () => {
  test("本地合并前不强制外部部署证据，合并后跟踪到登记完成", () => {
    const repo = setup();
    task(repo);
    const early = attest(repo, "integrated-smoke");
    assert.notEqual(early.status, 0);
    assert.match(early.stderr, /合入 main/);

    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("review", "--branch", "task/a").status, 0);
    const merged = repo.cli("merge", "--branch", "task/a");
    assert.equal(merged.status, 0, merged.stderr);
    assert.equal(JSON.parse(merged.stdout).postMergeChecks[0].id, "integrated-smoke");

    const pending = repo.cli("status", "--branch", "task/a");
    assert.match(pending.stdout, /合并后验收.*integrated-smoke/s);
    assert.match(pending.stdout, /已合入主分支/);
    assert.equal(attest(repo, "integrated-smoke", "integrated smoke passed\n").status, 0);
    const complete = repo.cli("status", "--branch", "task/a");
    assert.match(complete.stdout, /交付与合并后验收均完成/);
  });

  test("非快进合并的外部证据绑定实际主分支集成结果", () => {
    const repo = setup();
    const branchHead = task(repo);
    commit(repo.root, "feat(main): 推进主分支\n\n- 增加另一处改动\n- 制造三方合并", { "src/main.js": "main\n" });
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("review", "--branch", "task/a").status, 0);
    const merged = repo.cli("merge", "--branch", "task/a");
    assert.equal(merged.status, 0, merged.stderr);
    const integrationHead = git(repo.root, "rev-parse", "main");
    assert.notEqual(integrationHead, branchHead);
    const report = join(repo.root, "..", "integrated-report.md");
    writeFileSync(report, "passed\n");
    const record = attestCheck({ cwd: repo.root, branch: "task/a", checkId: "integrated-smoke", command: "run integrated", report });
    assert.equal(record.branchHead, branchHead);
    assert.equal(record.head, integrationHead);
    assert.equal(record.tree, git(repo.root, "rev-parse", "main^{tree}"));
  });

  test("post-merge 只允许 extended，非法阶段按配置错误报告", () => {
    const problems = verifyConfigProblems({
      checks: [
        { id: "bad-gate", tier: "gate", phase: "post-merge", when: ["src/**"], cmd: ["node", "-e", "process.exit(0)"] },
        { id: "bad-phase", tier: "extended", phase: "after-release", when: ["src/**"] },
      ],
    });
    assert.equal(problems.length, 2);
    assert.match(problems[0].reason, /必须使用 tier extended/);
    assert.match(problems[1].reason, /phase 只能是/);
  });
});
