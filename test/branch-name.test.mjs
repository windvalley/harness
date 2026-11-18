import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, CONFIG, commit, fakeReviewer, git, makeRepo, sh, write, writeReview } from "./helpers.mjs";
import { branchRuleErrorAt } from "../src/policy/branch-name.mjs";

const MESSAGE = "feat(demo): 调整示例\n\n- 增加示例文件\n- 补充对应说明";
const RULE = {
  id: "branch-name",
  kind: "branch-name",
  pattern: "^(feature|fix|docs|refactor|test|chore)/[a-z0-9]+(?:-[a-z0-9]+)*$",
  example: "feature/add-policy-check",
  reason: "任务分支名称必须符合项目分支规范",
  fix: "使用类型前缀和小写 kebab-case 任务描述",
};

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

function setup({ rule = RULE, disabled = [], config = {}, verify } = {}) {
  const repo = makeRepo({
    project: {
      ".harness/config.json": { ...CONFIG, ...config },
      ".harness/policy.json": { version: 1, presets: ["secrets", "git-safety", "gate-self"], disabled, rules: [rule] },
      ...(verify ? { ".harness/verify.json": verify } : {}),
    },
  });
  repos.push(repo);
  return repo;
}

function hookCommit(repo, branch) {
  git(repo.root, "checkout", "-q", "-b", branch);
  write(repo.root, "probe.txt", "probe\n");
  git(repo.root, "add", "probe.txt");
  return sh(repo.root, "git", ["commit", "-q", "-m", MESSAGE], repo.env);
}

function assertDenied(result, code = "bad_branch_name") {
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, new RegExp(code));
}

function withRemote(repo) {
  const base = join(repo.root, "..");
  const remote = join(base, "remote.git");
  const result = sh(base, "git", ["init", "-q", "--bare", "-b", "main", remote], repo.env);
  assert.equal(result.status, 0, result.stderr);
  const url = "https://code.example.com/acme/demo.git";
  git(repo.root, "remote", "add", "origin", url);
  git(repo.root, "config", `url.${remote}.insteadOf`, url);
  git(repo.root, "push", "-q", "origin", "main");
  const bin = join(base, "platform-bin");
  const calls = join(base, "platform-calls.txt");
  mkdirSync(bin);
  write(repo.root, "../platform-bin/gh", `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, args.join(" ") + "\\n");
if (args[0] === "pr" && args[1] === "list") process.stdout.write("[]\\n");
else if (args[0] === "pr" && args[1] === "create") process.stdout.write("https://code.example.com/acme/demo/pull/1\\n");
else process.exit(99);
`);
  chmodSync(join(bin, "gh"), 0o755);
  repo.env.PATH = `${bin}:${process.env.PATH}`;
  return { remote, calls };
}

describe("分支命名 policy 的真实入口", () => {
  test("首次接入先采用项目已有命名规范，并保留自定义 policy", () => {
    const projectRules = "# 项目规范\n\n任务分支统一使用 team/ABC-<工单号> 格式，例如 team/ABC-123。\n";
    const repo = makeRepo({
      install: false,
      project: { ".harness/config.json": null, ".harness/policy.json": null, ".harness/verify.json": null },
      files: { "AGENTS.md": projectRules },
    });
    repos.push(repo);
    git(repo.root, "checkout", "-q", "-b", "team/ABC-123");
    const init = repo.rawCli("init");
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /默认分支命名仅为起始值/);
    assert.match(init.stdout, /项目已有明确命名规范时优先沿用/);

    // init 只提供默认起始配置，由 Agent 在首次提交前将项目规范转换成唯一执行规则。
    const policyFile = join(repo.root, ".harness/policy.json");
    const policy = JSON.parse(readFileSync(policyFile, "utf8"));
    const existingRules = policy.rules.filter((rule) => rule.kind !== "branch-name");
    const branchRule = policy.rules.find((rule) => rule.kind === "branch-name");
    assert.ok(branchRule);
    assert.ok(existingRules.some((rule) => rule.kind === "commit-message"), "保留生成的提交规范");
    const presets = [...policy.presets];
    policy.disabled = ["main-worktree-commit"];
    branchRule.pattern = "^team/ABC-[0-9]+$";
    branchRule.example = "team/ABC-123";
    branchRule.fix = "使用 team/ABC-<工单号> 格式，例如 team/ABC-123";
    write(repo.root, ".harness/policy.json", `${JSON.stringify(policy, null, 2)}\n`);
    git(repo.root, "add", "-A");
    const onboard = sh(repo.root, "git", ["commit", "-q", "-m", "chore(harness): 接入门禁\n\n- 将项目已有命名规范写入 policy\n- 保留起始提交规范与预设"], repo.env);
    assert.equal(onboard.status, 0, onboard.stderr);
    git(repo.root, "checkout", "-q", "main");
    git(repo.root, "merge", "-q", "--ff-only", "team/ABC-123");

    const accepted = hookCommit(repo, "team/ABC-456");
    assert.equal(accepted.status, 0, accepted.stderr);
    git(repo.root, "checkout", "-q", "main");
    const repeated = repo.rawCli("init");
    assert.equal(repeated.status, 0, repeated.stderr);
    const after = JSON.parse(readFileSync(policyFile, "utf8"));
    assert.deepEqual(after.presets, presets);
    assert.deepEqual(after.rules.filter((rule) => rule.kind !== "branch-name"), existingRules);
    assert.equal(after.rules.find((rule) => rule.kind === "branch-name").pattern, "^team/ABC-[0-9]+$");
    assert.ok(readFileSync(join(repo.root, "AGENTS.md"), "utf8").startsWith(`${projectRules}\n`), "项目原有规范保留在托管块外");
    const refused = hookCommit(repo, "feature/default");
    assertDenied(refused);
    assert.match(refused.stderr, /team\/ABC-/);
  });

  test("真实提交在合法任务分支通过，在非法分支拒绝", () => {
    const good = setup();
    const accepted = hookCommit(good, "feature/add-login");
    assert.equal(accepted.status, 0, accepted.stderr);

    const bad = setup();
    const before = git(bad.root, "rev-parse", "HEAD");
    const refused = hookCommit(bad, "task/bad-name");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /branch-name|bad_branch_name/);
    assert.match(refused.stderr, /task\/bad-name/);
    assert.equal(git(bad.root, "rev-parse", "HEAD"), before, "拒绝时没有产生提交");
  });

  test("非法名称不阻止内容验证和评审，但通过后仍不能交付", () => {
    const repo = setup();
    const head = repo.branch("task/bad-name", { "src/a.js": "export const a = 1;\n" });
    fakeReviewer(repo, APPROVE);
    for (const command of ["verify", "review"]) {
      const result = repo.cli(command, "--branch", "task/bad-name");
      assert.equal(result.status, 0, result.stderr);
    }
    assert.equal(existsSync(join(repo.env.HARNESS_DATA_DIR, "evidence", `${head}.json`)), true);
    assert.equal(existsSync(join(repo.env.HARNESS_DATA_DIR, "review", `${head}.json`)), true);
    assert.equal(existsSync(join(repo.root, "..", "prompt.log")), true);
    assertDenied(repo.cli("merge", "--branch", "task/bad-name"));
  });

  test("绕过提交钩子后 status、merge 与 submit 仍拒绝，远程没有写入", () => {
    const local = setup();
    const before = git(local.root, "rev-parse", "main");
    local.branch("task/bypass", { "src/a.js": "export const a = 1;\n" });
    const status = local.cli("status", "--branch", "task/bypass");
    assert.notEqual(status.status, 0);
    assert.match(status.stdout, /\[FAIL\] branch-name:/);
    assert.match(status.stdout, /task\/bypass/);
    assertDenied(local.cli("merge", "--branch", "task/bypass"));
    assert.equal(git(local.root, "rev-parse", "main"), before);

    const remoteRepo = setup({ config: { delivery: { mode: "remote", provider: "github", remote: "origin" } } });
    const { remote, calls } = withRemote(remoteRepo);
    remoteRepo.branch("task/bypass", { "src/a.js": "export const a = 1;\n" });
    assertDenied(remoteRepo.cli("submit", "--branch", "task/bypass"));
    assert.equal(existsSync(calls), false, "命名失败之前不调用平台");
    const pushed = sh(remote, "git", ["rev-parse", "--verify", "refs/heads/task/bypass"]);
    assert.notEqual(pushed.status, 0, "没有把非法任务分支推到远程");
  });

  test("验证后改成非法名称，即使提交没有变化也拒绝交付", () => {
    const repo = setup();
    const head = repo.branch("feature/verified", { "src/a.js": "export const a = 1;\n" });
    const verified = repo.cli("verify", "--branch", "feature/verified");
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(writeReview(repo, head, "approve").status, 0);
    git(repo.root, "branch", "-m", "feature/verified", "task/renamed");
    assert.equal(git(repo.root, "rev-parse", "task/renamed"), head);
    const status = repo.cli("status", "--branch", "task/renamed");
    assert.match(status.stdout, /\[FAIL\] branch-name:/);
    assertDenied(repo.cli("merge", "--branch", "task/renamed"));
  });

  test("HEAD 和完整引用按实际分支名称显示交付阻塞", () => {
    const repo = setup();
    repo.branch("task/actual-name", { "src/a.js": "export const a = 1;\n" });
    git(repo.root, "checkout", "-q", "task/actual-name");
    for (const branch of ["HEAD", "refs/heads/task/actual-name"]) {
      const result = repo.cli("status", "--branch", branch);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /\[FAIL\] branch-name:/);
      assert.match(result.stdout, /task\/actual-name/);
    }
  });

  test("本地完整引用和远程跟踪引用校验真实分支名，远程主分支流程保留", () => {
    const repo = setup();
    const head = repo.branch("feature/local", { "src/a.js": "export const a = 1;\n" });
    git(repo.root, "remote", "add", "origin", join(repo.root, "..", "unused.git"));
    git(repo.root, "update-ref", "refs/remotes/origin/feature/remote", head);
    git(repo.root, "update-ref", "refs/remotes/origin/task/bad", head);
    git(repo.root, "update-ref", "refs/remotes/origin/main", head);
    for (const branch of ["refs/heads/feature/local", "origin/feature/remote", "refs/remotes/origin/main"]) {
      const result = repo.cli("status", "--branch", branch);
      assert.match(result.stdout, /\[ok\] branch-name:/, result.stdout + result.stderr);
    }
    const bad = repo.cli("status", "--branch", "refs/remotes/origin/task/bad");
    assert.match(bad.stdout, /\[FAIL\] branch-name:/);
  });

  test("提交号与 tag 可做内容验证，但不能绕过交付中的分支命名检查", () => {
    const repo = setup();
    const head = repo.branch("task/bad-name", { "src/a.js": "export const a = 1;\n" });
    git(repo.root, "tag", "v1.0.0", head);
    for (const source of [head, "v1.0.0"]) {
      const result = repo.cli("verify", "--head", source);
      assert.equal(result.status, 0, result.stderr);
      assertDenied(repo.cli("merge", "--branch", source));
    }
  });

  test("detached HEAD 提交被拒绝，主分支名称豁免后仍受引用保护", () => {
    const detached = setup();
    git(detached.root, "checkout", "-q", "--detach");
    write(detached.root, "probe.txt", "probe\n");
    git(detached.root, "add", "probe.txt");
    const head = git(detached.root, "rev-parse", "HEAD");
    assertDenied(sh(detached.root, "git", ["commit", "-q", "-m", MESSAGE], detached.env));
    assert.equal(git(detached.root, "rev-parse", "HEAD"), head);

    const main = setup();
    write(main.root, "probe.txt", "probe\n");
    git(main.root, "add", "probe.txt");
    const staged = main.cli("githook", "pre-commit");
    assert.equal(staged.status, 0, staged.stderr);
    const refused = sh(main.root, "git", ["commit", "-q", "-m", MESSAGE], main.env);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /本地主分支只允许由 harness merge 更新/);
    assert.doesNotMatch(refused.stderr, /bad_branch_name/);
  });

  test("任务分支修改 policy 放宽自身命名不会生效", () => {
    const repo = setup();
    repo.branch("task/self-relax", {
      ".harness/policy.json": `${JSON.stringify({ version: 1, presets: [], disabled: ["branch-name"], rules: [RULE] }, null, 2)}\n`,
    });
    assertDenied(repo.cli("merge", "--branch", "task/self-relax"));
    assert.match(repo.cli("status", "--branch", "task/self-relax").stdout, /\[FAIL\] branch-name:/);
  });

  test("主分支上无效的规则由 doctor、提交与验证共同报告", () => {
    const repo = setup({ rule: { ...RULE, pattern: "[" } });
    const head = repo.branch("feature/config-error", { "src/a.js": "export const a = 1;\n" });
    const doctor = repo.cli("doctor");
    assert.notEqual(doctor.status, 0);
    assert.match(doctor.stdout, /\[!!\] project:branch-name:/);
    assertDenied(repo.cli("verify", "--branch", "feature/config-error"), "branch_name_rule_invalid");
    git(repo.root, "checkout", "-q", "feature/config-error");
    write(repo.root, "probe.txt", "probe\n");
    git(repo.root, "add", "probe.txt");
    assertDenied(sh(repo.root, "git", ["commit", "-q", "-m", MESSAGE], repo.env), "branch_name_rule_invalid");
    assert.equal(git(repo.root, "rev-parse", "HEAD"), head);
  });

  test("任务分支提出的无效规则在验证、评审和交付前拒绝", () => {
    for (const rule of [{ ...RULE, pattern: "[" }, { ...RULE, pattren: RULE.pattern }]) {
      const repo = setup();
      const head = repo.branch("feature/config-error", {
        ".harness/policy.json": `${JSON.stringify({ version: 1, presets: [], disabled: [], rules: [rule] }, null, 2)}\n`,
      });
      fakeReviewer(repo, APPROVE);
      for (const command of ["verify", "review", "merge"]) {
        assertDenied(repo.cli(command, "--branch", "feature/config-error"), "branch_name_rule_invalid");
      }
      const status = repo.cli("status", "--branch", "feature/config-error");
      assert.match(status.stdout, /\[FAIL\] branch-name/);
      assert.equal(existsSync(join(repo.env.HARNESS_DATA_DIR, "evidence", `${head}.json`)), false);
      assert.equal(existsSync(join(repo.root, "..", "prompt.log")), false);
    }
  });

  test("自定义正则与 disabled 通过 policy 决定命名要求", () => {
    const custom = setup({ rule: { ...RULE, pattern: "^team/ABC-[0-9]+$", example: "team/ABC-123" } });
    const accepted = hookCommit(custom, "team/ABC-123");
    assert.equal(accepted.status, 0, accepted.stderr);
    const disabled = setup({
      disabled: ["branch-name"],
      config: { merge: { ...CONFIG.merge, requireEvidence: false, requireReview: false } },
    });
    const committed = hookCommit(disabled, "task/allowed");
    assert.equal(committed.status, 0, committed.stderr);
    git(disabled.root, "checkout", "-q", "main");
    const merged = disabled.cli("merge", "--branch", "task/allowed");
    assert.equal(merged.status, 0, merged.stderr);
  });

  test("启用命名规则的合法分支能完成本地合并和远程提交", () => {
    const merge = { ...CONFIG.merge, requireEvidence: false, requireReview: false };
    const local = setup({ config: { merge } });
    const head = local.branch("feature/merge", { "src/a.js": "export const a = 1;\n" });
    const merged = local.cli("merge", "--branch", "feature/merge");
    assert.equal(merged.status, 0, merged.stderr);
    assert.equal(git(local.root, "rev-parse", "main"), head);

    const remoteRepo = setup({ config: { merge, delivery: { mode: "remote", provider: "github", remote: "origin" } } });
    const { remote, calls } = withRemote(remoteRepo);
    const before = git(remoteRepo.root, "rev-parse", "main");
    const submittedHead = remoteRepo.branch("feature/submit", { "src/a.js": "export const a = 1;\n" });
    const submitted = remoteRepo.cli("submit", "--branch", "feature/submit");
    assert.equal(submitted.status, 0, submitted.stderr);
    assert.equal(git(remote, "rev-parse", "refs/heads/feature/submit"), submittedHead);
    assert.equal(git(remoteRepo.root, "rev-parse", "main"), before, "远程提交不改本地主分支");
    const platform = readFileSync(calls, "utf8");
    assert.match(platform, /pr list/);
    assert.match(platform, /pr create/);
  });

  test("合法的新命名规则按旧信任规则交付，合入后才约束新任务", () => {
    const repo = setup({ config: { merge: { ...CONFIG.merge, requireEvidence: false, requireReview: false } } });
    const nextRule = { ...RULE, pattern: "^fix/[a-z0-9]+$", example: "fix/change" };
    const head = repo.branch("feature/change-rule", {
      ".harness/policy.json": `${JSON.stringify({ version: 1, presets: ["secrets", "git-safety", "gate-self"], disabled: [], rules: [nextRule] }, null, 2)}\n`,
    });
    const confirmed = repo.cli("confirm", "--branch", "feature/change-rule", "--yes");
    assert.equal(confirmed.status, 0, confirmed.stderr);
    const merged = repo.cli("merge", "--branch", "feature/change-rule");
    assert.equal(merged.status, 0, merged.stderr);
    assert.equal(git(repo.root, "rev-parse", "main"), head);
    const refused = hookCommit(repo, "feature/blocked");
    assertDenied(refused);
    assert.match(refused.stderr, /fix\//, "合入后的 policy 开始约束后续任务");
  });

  test("双方各自有效但组合出重复规则的合并结果不能进入主分支", () => {
    // 两端改动位于不同规则中，Git 可以自动合并，合并结果却不能有两条 branch-name。
    const left = { ...RULE, id: "left", kind: "shell-forbid" };
    const right = { ...RULE, id: "right", kind: "shell-forbid" };
    const middle = { id: "middle", kind: "write-protect", paths: ["generated/**"], reason: "生成目录禁止修改", fix: "修改源文件" };
    const base = { version: 1, presets: ["secrets", "git-safety", "gate-self"], disabled: [], rules: [left, middle, right] };
    const repo = makeRepo({ project: { ".harness/policy.json": base } });
    repos.push(repo);
    repo.branch("feature/add-right", {
      ".harness/policy.json": `${JSON.stringify({ ...base, rules: [left, middle, { ...right, kind: "branch-name" }] }, null, 2)}\n`,
    });
    const main = commit(repo.root, MESSAGE, {
      ".harness/policy.json": `${JSON.stringify({ ...base, rules: [{ ...left, kind: "branch-name" }, middle, right] }, null, 2)}\n`,
    });
    assert.equal(branchRuleErrorAt(repo.root, "main"), null);
    assert.equal(branchRuleErrorAt(repo.root, "feature/add-right"), null);
    const merged = repo.cli("merge", "--branch", "feature/add-right");
    assertDenied(merged, "branch_name_rule_invalid");
    assert.match(merged.stderr, /合并结果/);
    assert.equal(git(repo.root, "rev-parse", "main"), main);
    const status = repo.cli("status", "--branch", "feature/add-right");
    assert.match(status.stdout, /\[FAIL\] branch-name:/);
    assert.match(status.stdout, /合并结果/);
  });

  test("普通内容合并冲突不被 status 误报为分支命名错误", () => {
    const repo = setup();
    repo.branch("feature/conflict", { "README.md": "task change\n" });
    commit(repo.root, MESSAGE, { "README.md": "main change\n" });
    const conflict = sh(repo.root, "git", ["merge-tree", "--write-tree", "main", "feature/conflict"], repo.env);
    assert.notEqual(conflict.status, 0, "夹具确实存在内容冲突");
    const status = repo.cli("status", "--branch", "feature/conflict");
    assert.match(status.stdout, /\[ok\] branch-name:/);
    assert.doesNotMatch(status.stdout, /\[FAIL\] branch-name:/);
    const merged = repo.cli("merge", "--dry-run", "--branch", "feature/conflict");
    assert.notEqual(merged.status, 0);
    assert.match(merged.stderr, /conflict|冲突/);
    assert.doesNotMatch(merged.stderr, /bad_branch_name|branch_name_rule_invalid/);
  });
});
