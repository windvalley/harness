import { strict as assert } from "node:assert";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, CONFIG, commit, fakeReviewer, git, makeRepo, sh, write } from "./helpers.mjs";
import { cleanCommitMessage } from "../src/githook.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

describe("提交信息按 git 的清理规则判定", () => {
  const STRICT = "^[a-z]+\\([^)]+\\): .+\\n\\n(- .+\\n?){2,}$";
  const strictPolicy = {
    version: 1,
    presets: ["secrets", "git-safety", "gate-self"],
    disabled: [],
    rules: [{ id: "commit-message", kind: "commit-message", pattern: STRICT, forbidPatterns: ["^Co-Authored-By:"], reason: "提交信息必须符合规范", fix: "按规范改写" }],
  };

  function commitWithEditor(repo, message) {
    const source = join(repo.root, "..", "editor-message.txt");
    const editor = join(repo.root, "..", "fake-editor.sh");
    write(repo.root, "../editor-message.txt", message);
    write(repo.root, "../fake-editor.sh", '#!/bin/sh\ncat "$MSG_SOURCE" > "$1"\n');
    chmodSync(editor, 0o755);
    return sh(repo.root, "git", ["commit", "-q", "-v"], { ...repo.env, GIT_EDITOR: editor, MSG_SOURCE: source });
  }

  test("用编辑器写的提交信息带注释行和剪刀线，校验按 git 最终写入的内容", () => {
    const repo = makeRepo({ project: { ".harness/policy.json": strictPolicy } });
    repos.push(repo);
    git(repo.root, "checkout", "-q", "-b", "task/editor");
    write(repo.root, "a.txt", "a\n");
    git(repo.root, "add", "a.txt");
    const message = [
      "feat(demo): 编辑器里写的提交信息",
      "",
      "- 第一条",
      "- 第二条",
      "",
      "# Please enter the commit message for your changes. Lines starting",
      "# with '#' will be ignored.",
      "# ------------------------ >8 ------------------------",
      "# Do not modify or remove the line above.",
      "diff --git a/a.txt b/a.txt",
      "+a",
      "",
    ].join("\n");
    const result = commitWithEditor(repo, message);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(repo.root, "log", "-1", "--format=%B"), "feat(demo): 编辑器里写的提交信息\n\n- 第一条\n- 第二条");

    write(repo.root, "b.txt", "b\n");
    git(repo.root, "add", "b.txt");
    const refused = commitWithEditor(repo, "feat(demo): 只有标题\n\n# Please enter the commit message\n");
    assert.notEqual(refused.status, 0, "去掉注释后不满足规范仍要拒绝");
    assert.match(refused.stderr, /不符合规范/);
  });

  test("清理规则：剪刀线以下、注释行、行尾空白、多余空行", () => {
    assert.equal(cleanCommitMessage("a: b  \r\n\r\n\r\n- x\n# note\n- y\n\n"), "a: b\n\n- x\n- y");
    assert.equal(cleanCommitMessage("a: b\n\n- x\n# ------------------------ >8 ------------------------\n- 不算\n"), "a: b\n\n- x");
    assert.equal(cleanCommitMessage("a: b\n; note\n# kept\n", ";"), "a: b\n# kept");
  });
});

describe("提交信息规范只有一处定义，钩子、verify、review、status 与合并结论一致", () => {
  const GOOD = "feat(login): 支持短信验证码登录\n\n- 新增验证码发送与校验接口\n- 登录页增加验证码输入";
  const STRUCTURED = {
    id: "commit-message",
    kind: "commit-message",
    lang: "zh",
    types: ["feat", "fix", "docs", "chore"],
    header: { maxLength: 72, noTrailingPeriod: true },
    body: { required: true, leadingBlank: true, bullets: true },
    example: GOOD,
    reason: "提交信息必须符合项目提交规范",
    fix: "按示例改写",
  };
  // [说明, 提交信息, 是否合规]
  const SAMPLES = [
    ["合规", GOOD, true],
    ["只有标题", "feat(login): 支持短信验证码登录", false],
    ["标题与正文之间没有空行", "feat(login): 支持短信验证码登录\n- 新增接口", false],
    ["正文不是要点", "feat(login): 支持短信验证码登录\n\n新增验证码发送与校验接口", false],
    ["描述是英文", "feat(login): support sms login\n\n- 新增接口", false],
    ["夹杂英文术语与代码", "fix(ci): 修复 `npm test` 在 Node 22 下的报错\n\n- 调整 lint 配置", true],
    ["类型不在范围内", "feature(login): 支持登录\n\n- 新增接口", false],
    ["署名行", "feat(login): 支持登录\n\n- 新增接口\n\nCo-Authored-By: X <x@y>", false],
    ["fixup 提交", "fixup! feat(login): 支持登录", false],
    ["git revert 生成的标题", 'Revert "feat(login): 支持登录"\n\nThis reverts commit 1234567.', true],
  ];

  /** 只在 policy.json 里写结构化规则；configMerge 给出时原样写进 config.json 的 merge 段。 */
  function structuredRepo({ rule = STRUCTURED, configMerge } = {}) {
    const { commitMessagePattern, forbidMessagePatterns, ...merge } = CONFIG.merge;
    const config = { ...CONFIG, merge: configMerge ?? merge };
    const policy = { version: 1, presets: ["secrets", "git-safety", "gate-self"], disabled: [], rules: [rule] };
    const repo = makeRepo({ project: { ".harness/config.json": config, ".harness/policy.json": policy } });
    repos.push(repo);
    return repo;
  }

  let seq = 0;
  /** 在当前分支经过真实的 commit-msg 钩子提交；被拒时把暂存的文件撤掉，不影响下一次。 */
  function hookCommit(repo, message) {
    const name = `probe-${seq++}.txt`;
    write(repo.root, name, `${name}\n`);
    git(repo.root, "add", name);
    const result = sh(repo.root, "git", ["commit", "-q", "-m", message], repo.env);
    if (result.status !== 0) git(repo.root, "reset", "-q", "--hard", "HEAD");
    return result;
  }

  test("同一批提交信息，钩子与 status 的结论一致，merge 只拒绝不合规的", () => {
    const repo = structuredRepo();
    git(repo.root, "checkout", "-q", "-b", "task/hook");
    const byHook = SAMPLES.map(([label, message]) => [label, hookCommit(repo, message).status === 0]);
    git(repo.root, "checkout", "-q", "main");
    const byStatus = SAMPLES.map(([label, message], index) => {
      const branch = `task/range-${index}`;
      repo.branch(branch, { [`range-${index}.txt`]: "r\n" }, message);
      return [label, /\[ok\] commit-message/.test(repo.cli("status", "--branch", branch).stdout)];
    });
    const expected = SAMPLES.map(([label, , ok]) => [label, ok]);
    assert.deepEqual(byHook, expected, "钩子");
    assert.deepEqual(byStatus, expected, "status");
    assert.match(repo.cli("merge", "--dry-run", "--branch", "task/range-1").stderr, /合并被拒绝\(bad_commit_message\)/);
    assert.doesNotMatch(repo.cli("merge", "--dry-run", "--branch", "task/range-0").stderr, /bad_commit_message/);
  });

  test("钩子拒绝时逐条列出不符合的地方，附上示例与正确做法", () => {
    const repo = structuredRepo();
    git(repo.root, "checkout", "-q", "-b", "task/msg");
    const result = hookCommit(repo, "feat(login): support sms login");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /提交信息不符合规范: feat\(login\): support sms login/);
    assert.match(result.stderr, /- 要有正文/);
    assert.match(result.stderr, /- 描述要用中文/);
    assert.match(result.stderr, /示例:\n\s+feat\(login\): 支持短信验证码登录/);
    assert.match(result.stderr, /正确做法: 按示例改写/);
    assert.match(result.stderr, /规则: commit-message/);
  });

  test("git merge 生成的合并提交不检查格式，status 也不计入", () => {
    const repo = structuredRepo();
    git(repo.root, "checkout", "-q", "-b", "task/merge");
    assert.equal(hookCommit(repo, GOOD).status, 0);
    git(repo.root, "checkout", "-q", "main");
    commit(repo.root, "chore: 主分支前进\n\n- 另一个改动", { "main.txt": "m\n" });
    git(repo.root, "checkout", "-q", "task/merge");
    const merged = sh(repo.root, "git", ["merge", "-q", "--no-edit", "main"], repo.env);
    assert.equal(merged.status, 0, merged.stderr);
    assert.match(git(repo.root, "log", "-1", "--format=%s"), /^Merge branch 'main'/);
    git(repo.root, "checkout", "-q", "main");
    assert.match(repo.cli("status", "--branch", "task/merge").stdout, /\[ok\] commit-message/);
  });

  test("旧写法取两处的并集：合并会拒绝的只有标题的提交，钩子当场就拒绝", () => {
    const repo = makeRepo();
    repos.push(repo);
    git(repo.root, "checkout", "-q", "-b", "task/legacy");
    const titleOnly = hookCommit(repo, "feat(demo): 只有标题");
    assert.notEqual(titleOnly.status, 0, "以前钩子放行、合并才拒绝");
    assert.match(titleOnly.stderr, /不符合格式/);
    assert.equal(hookCommit(repo, "feat(demo): 增加示例\n\n- 增加一个文件\n- 补充说明").status, 0);
    assert.match(repo.cli("doctor").stdout, /\[ok\] project:commit-message: 提交信息规范还在用旧写法/);
  });

  test("提交信息不合规时 verify、review 在动手前拒绝：不跑检查、不调评审者、不写记录", () => {
    const repo = structuredRepo();
    const head = repo.branch("task/bad", { "src/a.js": "export const a = 1;\n" }, "update code");
    fakeReviewer(repo, APPROVE);

    const verified = repo.cli("verify", "--branch", "task/bad");
    assert.equal(verified.status, 1);
    assert.match(verified.stderr, /验证被拒绝\(bad_commit_message\)/);
    assert.match(verified.stderr, /update code/);
    assert.equal(existsSync(join(repo.env.HARNESS_DATA_DIR, "evidence", `${head}.json`)), false, "没有写证据");

    const reviewed = repo.cli("review", "--branch", "task/bad");
    assert.equal(reviewed.status, 1);
    assert.match(reviewed.stderr, /评审被拒绝\(bad_commit_message\)/);
    assert.equal(existsSync(join(repo.root, "..", "prompt.log")), false, "没有调用评审者");
    assert.equal(existsSync(join(repo.env.HARNESS_DATA_DIR, "review", `${head}.json`)), false, "没有写评审记录");

    const status = repo.cli("status", "--branch", "task/bad");
    assert.equal(status.status, 1);
    assert.match(status.stdout, /\[FAIL\] commit-message: .*update code/);
    assert.match(status.stdout, /还差 .*提交信息不符合规范/);
    assert.match(repo.cli("merge", "--branch", "task/bad").stderr, /合并被拒绝\(bad_commit_message\)/);
  });

  test("结构化规则与 config.json 的旧字段并存时报错，doctor 与 status 都指出", () => {
    const repo = structuredRepo({ configMerge: CONFIG.merge });
    git(repo.root, "checkout", "-q", "-b", "task/conflict");
    const result = hookCommit(repo, GOOD);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /同时写在两处/);
    git(repo.root, "checkout", "-q", "main");
    assert.match(repo.cli("doctor").stdout, /\[!!\] project:commit-message: .*同时写在两处/);
    repo.branch("task/conflict-2", { "c.txt": "c\n" }, GOOD);
    assert.match(repo.cli("status", "--branch", "task/conflict-2").stdout, /\[FAIL\] commit-message: 无法判定提交信息/);
  });

  test("任务分支把规则改成结构化却留着 config.json 的旧字段时，verify、status 与合并都拒绝，不让它进主分支", () => {
    const repo = makeRepo();
    repos.push(repo);
    const policy = { version: 1, presets: ["secrets", "git-safety", "gate-self"], disabled: [], rules: [STRUCTURED] };
    repo.branch("task/rule", { ".harness/policy.json": `${JSON.stringify(policy, null, 2)}\n` }, GOOD);

    const verified = repo.cli("verify", "--branch", "task/rule");
    assert.equal(verified.status, 1);
    assert.match(verified.stderr, /验证被拒绝\(branch_commit_rule_invalid\)/);
    assert.match(verified.stderr, /同时写在两处/);

    const status = repo.cli("status", "--branch", "task/rule");
    assert.match(status.stdout, /\[ok\] commit-message/, "主分支的规则照常判定提交信息");
    assert.match(status.stdout, /\[FAIL\] commit-rule: .*同时写在两处/);
    assert.match(status.stdout, /本分支的提交信息规则有误/);

    const merged = repo.cli("merge", "--dry-run", "--branch", "task/rule");
    assert.match(merged.stderr, /合并被拒绝\(branch_commit_rule_invalid\)/, "在要求人工确认之前就拒绝");
  });

  test("规范写法正常时 doctor 不提示", () => {
    const repo = structuredRepo();
    assert.doesNotMatch(repo.cli("doctor").stdout, /project:commit-message/);
  });

  test("init 只在 policy.json 里生成结构化规则，生成的示例能通过生成的规则", () => {
    const repo = makeRepo({ install: false, project: { ".harness/config.json": null, ".harness/policy.json": null, ".harness/verify.json": null } });
    repos.push(repo);
    const init = repo.rawCli("init");
    assert.equal(init.status, 0, init.stderr);
    const policy = JSON.parse(readFileSync(join(repo.root, ".harness/policy.json"), "utf8"));
    const rule = policy.rules.find((item) => item.kind === "commit-message");
    assert.equal(rule.lang, "any");
    assert.deepEqual(rule.body, { required: true, leadingBlank: true, bullets: true });
    const config = JSON.parse(readFileSync(join(repo.root, ".harness/config.json"), "utf8"));
    assert.equal(config.merge.commitMessagePattern, undefined);
    assert.equal(config.merge.forbidMessagePatterns, undefined);

    // 钩子只在主分支有配置后生效：把 init 写出的文件提交到主分支，模拟接入完成。
    git(repo.root, "checkout", "-q", "-b", "chore/onboard");
    commit(repo.root, "chore: 接入门禁\n\n- 写入配置与入口\n- 采用本地交付", {});
    git(repo.root, "checkout", "-q", "main");
    git(repo.root, "merge", "-q", "--ff-only", "chore/onboard");
    git(repo.root, "checkout", "-q", "-b", "task/init");
    assert.equal(hookCommit(repo, rule.example).status, 0);
    assert.notEqual(hookCommit(repo, "feat(demo): 只有标题").status, 0);
  });
});
