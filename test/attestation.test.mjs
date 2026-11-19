import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, CONFIG, commit, fakeReviewer, git, makeRepo } from "./helpers.mjs";
import { verifyConfigProblems } from "../src/verify/verify.mjs";
import { attestCheck } from "../src/verify/attestation.mjs";
import { acceptanceDigest, describeAcceptanceChange, splitAcceptance } from "../src/lib/acceptance.mjs";
import { redact } from "../src/lib/redact.mjs";
import { readdirSync } from "node:fs";
import { PACKAGE_ROOT, sh } from "./helpers.mjs";

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

function setup(verify = VERIFY) {
  const repo = makeRepo({ project: { ".harness/verify.json": verify } });
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

/** 已登记的 attestation 记录，按创建时间排序。 */
function attestationRecords(repo) {
  const dir = join(repo.env.HARNESS_DATA_DIR, "attestation");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** 全仓库到期且未关闭的合并后义务，用 CLI 的只读视图核对。 */
function pendingObligations(repo) {
  const list = repo.cli("status", "--post-merge");
  return { status: list.status, text: list.stdout };
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

  test("主分支只改外部检查范围时，合并重算并把过期登记降为未执行", () => {
    const repo = setup({
      ...VERIFY,
      checks: [{ ...VERIFY.checks[0], when: ["src/task.js"] }, VERIFY.checks[1]],
    });
    const head = repo.branch("task/a", { "src/task.js": "task\n" });
    assert.equal(attest(repo).status, 0);
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    assert.equal(evidence(repo, head).attested[0].id, "browser");
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("review", "--branch", "task/a").status, 0);

    commit(repo.root, "feat(main): 更新共享实现\n\n- 只影响外部检查范围\n- 保持任务单元检查范围不变", { "src/shared.js": "shared\n" });
    const status = repo.cli("status", "--branch", "task/a");
    assert.match(status.stdout, /外部证据需重新核对.*browser/);
    assert.doesNotMatch(status.stdout, /已登记 1 项外部证据/);
    const merged = repo.cli("merge", "--branch", "task/a");
    assert.equal(merged.status, 0, merged.stderr);
    const record = evidence(repo, head);
    assert.equal(record.status, "passed", "外部证据过期不阻断 gate");
    assert.equal(record.attested.length, 0, "不能沿用未覆盖当前集成结果的外部证据");
    assert.equal(record.notExecuted[0].id, "browser");
    assert.match(record.notExecuted[0].reason, /证据已过期/);
    assert.equal(record.checks[0].reused, true, "未受影响的 gate 继续复用");
    assert.match(merged.stderr, /外部证据 browser 已过期.*未执行/);
  });

  test("主分支无关变化时，合并保留可复用的外部证据", () => {
    const repo = setup({
      ...VERIFY,
      checks: [{ ...VERIFY.checks[0], when: ["src/task.js"] }, VERIFY.checks[1]],
    });
    const head = repo.branch("task/a", { "src/task.js": "task\n" });
    assert.equal(attest(repo).status, 0);
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    const original = evidence(repo, head);
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("review", "--branch", "task/a").status, 0);

    commit(repo.root, "docs(main): 补充无关文档\n\n- 不修改检查覆盖文件\n- 保留已有验证证据", { "docs/main.md": "note\n" });
    const merged = repo.cli("merge", "--branch", "task/a");
    assert.equal(merged.status, 0, merged.stderr);
    const record = evidence(repo, head);
    assert.equal(record.attested[0].id, "browser");
    assert.equal(record.signature, original.signature, "无需重算未受影响的证据");
    assert.match(merged.stderr, /复用已验证证据/);
    assert.doesNotMatch(merged.stderr, /外部证据 browser 已过期/);
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

  test("任务分支私有的检查不能登记：门禁判定读主分支配置", () => {
    const repo = setup();
    // 分支自己加一个 extended 检查；主分支没有它，verify 不会消费，登记了也没有任何消费者。
    const branchVerify = {
      ...VERIFY,
      checks: [...VERIFY.checks, { id: "branch-only", tier: "extended", when: ["src/**"], reason: "分支自加", howToVerify: "跑一下" }],
    };
    repo.branch("task/a", {
      "src/a.js": "a\n",
      ".harness/verify.json": `${JSON.stringify(branchVerify, null, 2)}\n`,
      ".harness/acceptance/task-a.md": ACCEPTANCE,
    });
    const report = join(repo.root, "..", "branch-only-report.md");
    writeFileSync(report, "passed\n");
    const denied = repo.cli("attest", "--branch", "task/a", "--check", "branch-only", "--command", "run branch only", "--report", report);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /不存在.*extended 检查/);
    assert.match(denied.stderr, /门禁配置只从主分支读取/);
  });

  test("登记用主分支的检查定义，任务分支改了定义不算数", () => {
    const repo = setup();
    const changed = {
      ...VERIFY,
      checks: VERIFY.checks.map((check) => (check.id === "browser" ? { ...check, howToVerify: "分支上改过的验收方式" } : check)),
    };
    repo.branch("task/a", {
      "src/a.js": "a\n",
      ".harness/verify.json": `${JSON.stringify(changed, null, 2)}\n`,
      ".harness/acceptance/task-a.md": ACCEPTANCE,
    });
    const registered = attest(repo);
    assert.equal(registered.status, 0, registered.stderr);
    const verified = repo.cli("verify", "--branch", "task/a");
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stderr, /ATTESTED browser/, "用主分支定义登记，verify 才认这份证据");
    assert.doesNotMatch(verified.stderr, /NOT_EXECUTED browser/);
  });

  test("主分支后来删掉合并后检查，仍可凭历史定义关闭已有义务", () => {
    const repo = setup();
    task(repo);
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("review", "--branch", "task/a").status, 0);
    assert.equal(repo.cli("merge", "--branch", "task/a").status, 0);
    assert.match(repo.cli("status", "--branch", "task/a").stdout, /合并后验收待完成/);

    // 另一个任务从主分支删掉这项检查：义务仍然待办，登记不能被“主分支没有该检查”卡死。
    const without = { ...VERIFY, checks: VERIFY.checks.filter((check) => check.id !== "integrated-smoke") };
    commit(repo.root, "chore(harness): 移除旧的合并后检查\n\n- 该检查已被新的部署验证替代\n- 义务仍需登记", {
      ".harness/verify.json": `${JSON.stringify(without, null, 2)}\n`,
    });
    const closed = attest(repo, "integrated-smoke", "部署环境冒烟通过\n");
    assert.equal(closed.status, 0, closed.stderr);
    assert.match(repo.cli("status", "--branch", "task/a").stdout, /交付与合并后验收均完成/);
  });

  test("同名检查从合并后改成合并前，登记仍按合并后关闭旧义务", () => {
    const repo = setup();
    task(repo);
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("review", "--branch", "task/a").status, 0);
    assert.equal(repo.cli("merge", "--branch", "task/a").status, 0);
    assert.match(repo.cli("status", "--branch", "task/a").stdout, /合并后验收待完成/);

    // 主分支把同名检查前移成合并前验收：义务已经写下，登记不能改成写合并前证据。
    const moved = {
      ...VERIFY,
      checks: VERIFY.checks.map((check) =>
        check.id === "integrated-smoke"
          ? { id: check.id, tier: "extended", when: check.when, reason: "改成合并前人工验收", howToVerify: "在任务分支执行" }
          : check,
      ),
    };
    commit(repo.root, "chore(harness): 把冒烟验收前移\n\n- 不再依赖合入后环境\n- 改在任务分支登记", {
      ".harness/verify.json": `${JSON.stringify(moved, null, 2)}\n`,
    });

    const closed = attest(repo, "integrated-smoke", "冒烟通过\n");
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(attestationRecords(repo).filter((record) => record.checkId === "integrated-smoke").at(-1).phase, "post-merge", "要按义务当时的状态登记，不能写成同名合并前证据");
    assert.match(repo.cli("status", "--branch", "task/a").stdout, /交付与合并后验收均完成/);
  });

  test("任务分支已删除时，仍能凭义务里的分支顶端关闭旧义务", () => {
    const repo = setup();
    task(repo);
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("review", "--branch", "task/a").status, 0);
    assert.equal(repo.cli("merge", "--branch", "task/a").status, 0);
    git(repo.root, "branch", "-D", "task/a");

    const closed = attest(repo, "integrated-smoke", "部署环境冒烟通过\n");
    assert.equal(closed.status, 0, closed.stderr);
    // 分支已经删除，按仓库级视图核对：义务不能再待办。
    const pending = pendingObligations(repo);
    assert.equal(pending.status, 0, pending.text);
    assert.doesNotMatch(pending.text, /integrated-smoke/);
  });

  test("任务分支创建于接入之前时，按主分支定义就能登记", () => {
    const repo = setup();
    // 从接入前的提交建分支：那个提交里还没有 .harness 配置，模拟“分支创建于项目接入之前”。
    git(repo.root, "checkout", "-q", "-b", "task/legacy", "HEAD~1");
    writeFileSync(join(repo.root, "a.js"), "a\n");
    git(repo.root, "add", "-A");
    commit(repo.root, "feat(demo): 旧分支的实现\n\n- 分支不带门禁配置\n- 沿用主分支的检查", { "src/a.js": "a\n" });
    git(repo.root, "checkout", "-q", "main");
    git(repo.root, "checkout", "-q", "task/legacy");
    mkdirSync(join(repo.root, ".harness/acceptance"), { recursive: true });
    writeFileSync(join(repo.root, ".harness/acceptance/task-legacy.md"), "# 验收清单\n\n## 应该发生\n\n- 行为正确。\n");
    git(repo.root, "add", "-A");
    commit(repo.root, "docs(demo): 补验收清单\n\n- 写清单\n- 不改门禁", {});
    git(repo.root, "checkout", "-q", "main");

    const verified = repo.cli("verify", "--branch", "task/legacy");
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stderr, /NOT_EXECUTED browser/, "主分支配置已经把 browser 选中为待登记");

    const report = join(repo.root, "..", "legacy-browser.md");
    writeFileSync(report, "passed\n");
    const registered = repo.cli("attest", "--branch", "task/legacy", "--check", "browser", "--command", "run browser", "--report", report);
    assert.equal(registered.status, 0, `分支没有门禁配置不该挡住登记: ${registered.stderr}`);
  });

  test("--at 早于任务合入点时义务继续待办", () => {
    const repo = setup();
    task(repo);
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("review", "--branch", "task/a").status, 0);
    const before = git(repo.root, "rev-parse", "main").trim();
    assert.equal(repo.cli("merge", "--branch", "task/a").status, 0);

    const report = join(repo.root, "..", "early-smoke.md");
    writeFileSync(report, "passed\n");
    const early = repo.cli("attest", "--branch", "task/a", "--check", "integrated-smoke", "--at", before, "--command", "run smoke", "--report", report);
    assert.notEqual(early.status, 0, "被测提交还没包含这次合入，不能用来关闭义务");
    assert.match(early.stderr, /必须在分支合入 main 后执行并登记/);
    assert.match(repo.cli("status", "--branch", "task/a").stdout, /合并后验收待完成/);
  });

  test("验收章节只识别真实标题，注释里的示例不生效", () => {
    const split = splitAcceptance("# 验收\n\n- 合并前\n\n<!--\n## 合并后验收\n- 示例\n-->\n");
    assert.match(split.preMergeText, /合并前/);
    assert.equal(split.postMergeText, "");
  });

  test("授权摘要按章节比出增删条数，排版变化不误报条目变化", () => {
    const before = acceptanceDigest("# 验收\n\n## 应该发生\n\n- 甲\n- 乙\n\n## 合并后验收\n\n- 冒烟通过\n");
    const sameLines = acceptanceDigest("# 验收\n\n## 应该发生\n\n\n- 甲\n\n- 乙\n\n### 小标题\n\n## 合并后验收\n\n- 冒烟通过\n");
    assert.equal(describeAcceptanceChange(before, sameLines), "没有内容行变化（只有空行、标题或排版变化）", "空行和标题不算条目变化");

    const changed = acceptanceDigest("# 验收\n\n## 应该发生\n\n- 甲\n- 丙\n\n## 合并后验收\n");
    assert.equal(describeAcceptanceChange(before, changed), "合并前「应该发生 新增 1 条、删除 1 条」；合并后验收 删除 1 条");
    assert.equal(describeAcceptanceChange(before, null), null);
  });

  test("同一条从「应该发生」移到「绝对不能发生」时指出两个章节的变化", () => {
    const before = acceptanceDigest("# 验收\n\n## 应该发生\n\n- 甲\n- 会话自动续期\n\n## 绝对不能发生\n\n- 乙\n");
    const moved = acceptanceDigest("# 验收\n\n## 应该发生\n\n- 甲\n\n## 绝对不能发生\n\n- 乙\n- 会话自动续期\n");
    const described = describeAcceptanceChange(before, moved);
    assert.match(described, /应该发生 删除 1 条/, "需求被反转，不能报成排版变化");
    assert.match(described, /绝对不能发生 新增 1 条/);
  });

  test("没有章节的清单仍按未分类比较，旧摘要给不出章节差异时返回 null", () => {
    const flat = acceptanceDigest("- 甲\n- 乙\n");
    assert.equal(describeAcceptanceChange(flat, acceptanceDigest("- 甲\n- 丙\n")), "合并前「(未分类) 新增 1 条、删除 1 条」");
    // 0.23 及更早的记录只存了粗粒度数组，没有章节信息：交给调用方按原文还原，不在这里猜。
    assert.equal(describeAcceptanceChange({ preMerge: ["a"], postMerge: [] }, flat), null);
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

  test("合并后清单没有对应检查时验证失败，不允许静默跳过", () => {
    const repo = makeRepo();
    repos.push(repo);
    repo.branch("task/a", {
      "src/a.js": "a\n",
      ".harness/acceptance/task-a.md": ACCEPTANCE,
    });
    const plan = repo.cli("verify", "--plan", "--branch", "task/a");
    assert.notEqual(plan.status, 0);
    assert.match(plan.stdout, /acceptance:post-merge/);
    assert.match(plan.stdout, /门禁检查配置只从主分支读取，改在任务分支不会生效/, "改法要指出现有实现读的是主分支");
    // 改法要能照着做：三条路径各自给出命令级动作，而不是只描述目标。
    assert.match(plan.stdout, /harness attest 登记/);
    assert.match(plan.stdout, /harness confirm/);
    const result = repo.cli("verify", "--branch", "task/a");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /合并后验收.*没有对应.*post-merge/s);
  });

  test("已有合并后义务时提示不能靠删除章节取消义务", () => {
    const repo = setup();
    task(repo);
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("review", "--branch", "task/a").status, 0);
    assert.equal(repo.cli("merge", "--branch", "task/a").status, 0);

    // 合入后追加一次只改验收清单的提交：这次没有命中 post-merge 检查，但义务已经写在账上。
    git(repo.root, "checkout", "-q", "task/a");
    commit(repo.root, "docs(demo): 调整合并后验收\n\n- 补充环境说明\n- 条目本身不变", {
      ".harness/acceptance/task-a.md": ACCEPTANCE.replace("主 Worktree 集成后的冒烟测试通过。", "主 Worktree 集成后的冒烟测试通过，环境见报告。"),
    });
    git(repo.root, "checkout", "-q", "main");

    const result = repo.cli("verify", "--branch", "task/a");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /这条分支已经有合并后验收义务，删除章节不会取消它/);
    assert.doesNotMatch(result.stderr, /确认不需要后置验收：删除「合并后验收」章节/, "已有义务时不能再建议删除");
  });

  test("首次接入阶段按分支自己的配置检查，提示不指向主分支", () => {
    const verify = {
      ...VERIFY,
      checks: VERIFY.checks.map((check) => (check.id === "integrated-smoke" ? { ...check, when: ["src/other/**"] } : check)),
    };
    const repo = makeRepo();
    repos.push(repo);
    // 主分支退回首次接入状态：还没有 .harness/config.json。
    git(repo.root, "rm", "-q", ".harness/config.json");
    commit(repo.root, "chore(demo): 回到首次接入\n\n- 主分支还没有接入配置\n- 由接入分支提议", {});
    repo.branch("task/a", {
      "src/a.js": "a\n",
      ".harness/config.json": `${JSON.stringify(CONFIG, null, 2)}\n`,
      ".harness/verify.json": `${JSON.stringify(verify, null, 2)}\n`,
      ".harness/acceptance/task-a.md": ACCEPTANCE,
    });

    const plan = repo.cli("verify", "--plan", "--branch", "task/a");
    assert.notEqual(plan.status, 0, "章节有内容但本次没有命中检查，仍然要报错");
    assert.match(plan.stdout, /首次接入阶段配置从本分支读取/, "首次接入时分支配置才是判定来源");
    assert.doesNotMatch(plan.stdout, /门禁检查配置只从主分支读取/);
  });

  test("主分支后来修改检查定义，不影响已登记的任务证据", () => {
    const repo = setup();
    task(repo);
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("review", "--branch", "task/a").status, 0);
    assert.equal(repo.cli("merge", "--branch", "task/a").status, 0);
    assert.equal(attest(repo, "integrated-smoke", "integrated smoke passed\n").status, 0);
    assert.match(repo.cli("status", "--branch", "task/a").stdout, /交付与合并后验收均完成/);

    const changed = {
      ...VERIFY,
      checks: [VERIFY.checks[0], VERIFY.checks[1], { ...VERIFY.checks[2], howToVerify: "运行更新后的冒烟测试" }],
    };
    commit(repo.root, "chore(main): 更新检查说明\n\n- 主分支后来修改检查\n- 模拟其他任务合入", { ".harness/verify.json": `${JSON.stringify(changed, null, 2)}\n` });
    assert.match(repo.cli("status", "--branch", "task/a").stdout, /交付与合并后验收均完成/);
    assert.equal(attest(repo, "integrated-smoke", "integrated smoke passed\n").status, 0);
    assert.match(repo.cli("status", "--branch", "task/a").stdout, /交付与合并后验收均完成/);
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

describe("命令与备注脱敏", () => {
  const SECRETS = ["tok-9f8e7d", "pw-1a2b3c", "key-77aa88", "bearer-zz99yy", "env-secret-55"];
  const COMMAND = `deploy --token ${SECRETS[0]} --password=${SECRETS[1]} API_KEY=${SECRETS[2]} -H "Authorization: Bearer ${SECRETS[3]}" DB_PASSWORD="${SECRETS[4]}" --grep login`;

  const allText = (dir) => {
    const out = [];
    const walk = (path) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) walk(file);
        else out.push(readFileSync(file, "utf8"));
      }
    };
    walk(dir);
    return out.join("\n");
  };

  function registerWithSecrets(repo) {
    const report = join(repo.root, "..", "browser-report.md");
    writeFileSync(report, "224/224 passed\nAuthorization: Bearer report-secret-123\n");
    return repo.cli("attest", "--branch", "task/a", "--check", "browser", "--command", COMMAND, "--report", report, "--note", `用 --token ${SECRETS[0]} 跑过`);
  }

  test("登记、验证输出、证据与评审提示里都看不到命令和备注里的凭据", () => {
    const repo = setup();
    const head = task(repo);
    const registered = registerWithSecrets(repo);
    assert.equal(registered.status, 0, registered.stderr);
    const verified = repo.cli("verify", "--branch", "task/a");
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stderr, /ATTESTED browser: deploy --token \*\*\*/);
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("review", "--branch", "task/a").status, 0);

    const record = evidence(repo, head).attested[0];
    assert.match(record.command, /--grep login/, "没有凭据的部分保持原样");
    const everything = [registered.stdout, registered.stderr, verified.stdout, verified.stderr, allText(repo.env.HARNESS_DATA_DIR), readFileSync(join(repo.root, "..", "prompt.log"), "utf8")].join("\n");
    for (const secret of [...SECRETS, "report-secret-123"]) assert.equal(everything.includes(secret), false, `不应出现 ${secret}`);
  });

  test("0.16.0 留下的原始命令在写进评审提示与验证输出时同样脱敏", () => {
    const repo = setup();
    const head = task(repo);
    assert.equal(attest(repo).status, 0);
    const dir = join(repo.env.HARNESS_DATA_DIR, "attestation");
    const file = join(dir, readdirSync(dir).find((name) => name.endsWith(".json")));
    const { schema, kind, key, signature, keyId, ...payload } = JSON.parse(readFileSync(file, "utf8"));
    payload.command = COMMAND;
    payload.report = { ...payload.report, excerpt: "Authorization: Bearer report-secret-123" };
    const script = `import { writeRecord } from ${JSON.stringify(join(PACKAGE_ROOT, "src/lib/store.mjs"))}; writeRecord(process.argv[1], "attestation", process.argv[2], JSON.parse(process.argv[3]));`;
    assert.equal(sh(repo.root, process.execPath, ["--input-type=module", "-e", script, repo.root, key, JSON.stringify(payload)], repo.env).status, 0);

    const verified = repo.cli("verify", "--branch", "task/a", "--no-reuse");
    assert.equal(verified.status, 0, verified.stderr);
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("review", "--branch", "task/a").status, 0);
    const shown = `${verified.stderr}\n${readFileSync(join(repo.root, "..", "prompt.log"), "utf8")}`;
    for (const secret of [...SECRETS, "report-secret-123"]) assert.equal(shown.includes(secret), false, `不应出现 ${secret}`);
    assert.ok(head);
  });

  test("规则只遮凭据，不误伤普通命令参数", () => {
    const masked = [
      ["tool --token abc123", "tool --token ***"],
      ["tool --token=abc123 --x 1", "tool --token=*** --x 1"],
      ["tool --client-secret 'a b c' go", "tool --client-secret *** go"],
      ["tool --api-key K1", "tool --api-key ***"],
      ["GITHUB_TOKEN=ghp_x pnpm e2e", "GITHUB_TOKEN=*** pnpm e2e"],
      ["AWS_SECRET_ACCESS_KEY=abc run", "AWS_SECRET_ACCESS_KEY=*** run"],
      ['PASSWORD="a b" run', "PASSWORD=*** run"],
      ['curl -H "Authorization: Bearer abc.def" url', 'curl -H "Authorization: ***" url'],
      ["curl -H 'Authorization: Basic dXNlcjpwdw==' url", "curl -H 'Authorization: ***' url"],
      ["echo Bearer abcdefgh12345", "echo Bearer ***"],
      ["git clone https://user:tok@host/repo", "git clone https://***@host/repo"],
      ["open https://h/?access_token=abc&x=1", "open https://h/?access_token=***&x=1"],
    ];
    for (const [input, expected] of masked) assert.equal(redact(input), expected, input);
    for (const text of ["pnpm e2e --grep login", "tool --token-count 5", "tool --tokenizer fast", "KEYBOARD=us run", "run --key-file a.pem", "monkey=1 run"]) {
      assert.equal(redact(text), text, `不应改动 ${text}`);
    }
    for (const [input] of masked) assert.equal(redact(redact(input)), redact(input), `重复脱敏结果不变: ${input}`);
  });
});
