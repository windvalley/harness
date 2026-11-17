import { strict as assert } from "node:assert";
import { afterEach, describe, test } from "node:test";
import { commit, git, makeRepo } from "./helpers.mjs";
import { assertBranchPolicy, branchNameProblems, branchProblems, branchRuleErrorAt, resolveBranchRule, resolveBranchSource } from "../src/policy/branch-name.mjs";
import { resolvePolicy } from "../src/policy/resolve.mjs";

const RULE = {
  id: "branch-name",
  kind: "branch-name",
  pattern: "^(feature|fix|docs|refactor|test|chore)/[a-z0-9]+(?:-[a-z0-9]+)*$",
  example: "feature/add-policy-check",
  reason: "任务分支名称必须符合项目分支规范",
  fix: "使用类型前缀和小写 kebab-case 任务描述",
};

const policy = (rules = [RULE], disabled = []) => ({ version: 1, presets: [], rules, disabled });
const specFor = (rule = RULE) => resolveBranchRule(resolvePolicy(policy([rule])));
let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

function setup() {
  const repo = makeRepo({ install: false });
  repos.push(repo);
  return repo;
}

describe("分支命名规则的唯一判定", () => {
  test("默认格式接受任务类型和数字工单，拒绝其他前缀与非 kebab-case 描述", () => {
    const spec = specFor();
    for (const name of ["feature/add-policy-check", "fix/123-login-timeout", "docs/update-install-guide", "refactor/loader", "test/api", "chore/update-ci"]) {
      assert.deepEqual(branchNameProblems({ spec, name, mainRef: "main" }), [], name);
    }
    for (const name of ["temp", "feat/login", "codex/add-login", "Claude/add-login", "feature/", "feature/Add-Login", "fix/login_timeout", "fix/login--timeout", "release/1.2.3", "hotfix/payment"]) {
      assert.notEqual(branchNameProblems({ spec, name, mainRef: "main" }).length, 0, name);
    }
  });

  test("按项目正则定制规则，主分支按配置名称豁免", () => {
    const spec = specFor({ ...RULE, pattern: "^(team/ABC-[0-9]+|release/[0-9]+\\.[0-9]+\\.[0-9]+)$" });
    for (const name of ["team/ABC-123", "release/1.2.3", "stable"]) {
      assert.deepEqual(branchNameProblems({ spec, name, mainRef: "stable" }), [], name);
    }
    assert.notEqual(branchNameProblems({ spec, name: "main", mainRef: "stable" }).length, 0);
    assert.deepEqual(branchNameProblems({ spec: null, name: "anything", mainRef: "main" }), []);
  });

  test("缺少规则或通过 disabled 关闭时不启用命名判定", () => {
    assert.equal(resolveBranchRule(resolvePolicy(policy([]))), null);
    assert.equal(resolveBranchRule(resolvePolicy(policy([RULE], [RULE.id]))), null);
  });

  test("缺失字段、字段类型错误、未知字段和无效正则都明确报错", () => {
    for (const field of ["id", "pattern", "reason", "fix"]) {
      for (const value of [undefined, "", " ", false, 42]) {
        assert.throws(() => resolveBranchRule({ rules: [{ ...RULE, [field]: value }] }), new RegExp(field), `${field}=${value}`);
      }
    }
    assert.throws(() => specFor({ ...RULE, example: 42 }), /example/);
    assert.throws(() => specFor({ ...RULE, patern: "^ok$" }), /patern/);
    assert.throws(() => specFor({ ...RULE, pattern: "[" }), /正则/);
  });

  test("不能同时配置多条生效的分支命名规则", () => {
    assert.throws(() => resolveBranchRule(resolvePolicy(policy([RULE, { ...RULE, id: "other-branch-name" }]))), /一条|多条|重复/);
  });
});

describe("按真实 Git 引用识别分支名称", () => {
  test("HEAD、本地短名称和完整引用都解析为真实本地分支", () => {
    const repo = setup();
    git(repo.root, "checkout", "-q", "-b", "feature/add-policy-check");
    const expected = { name: "feature/add-policy-check", ref: "refs/heads/feature/add-policy-check", kind: "local" };
    for (const source of ["HEAD", "feature/add-policy-check", "refs/heads/feature/add-policy-check"]) {
      assert.deepEqual(resolveBranchSource(repo.root, source), expected, source);
    }
  });

  test("远程跟踪引用按实际 remote 名去前缀，不把远程名前缀当作任务类型", () => {
    const repo = setup();
    git(repo.root, "remote", "add", "origin", "https://example.invalid/repo.git");
    git(repo.root, "remote", "add", "team/upstream", "https://example.invalid/upstream.git");
    for (const [remote, name] of [["origin", "feature/add-policy-check"], ["origin", "main"], ["team/upstream", "fix/123-timeout"]]) {
      const ref = `refs/remotes/${remote}/${name}`;
      git(repo.root, "update-ref", ref, "HEAD");
      const expected = { name, ref, kind: "remote" };
      assert.deepEqual(resolveBranchSource(repo.root, `${remote}/${name}`), expected);
      assert.deepEqual(resolveBranchSource(repo.root, ref), expected);
    }
  });

  test("标签、提交号、提交表达式和 detached HEAD 都不是分支名", () => {
    const repo = setup();
    const head = git(repo.root, "rev-parse", "HEAD");
    git(repo.root, "tag", "feature/looks-like-a-branch");
    for (const source of [head, head.slice(0, 8), "HEAD~0", "feature/looks-like-a-branch", "refs/tags/feature/looks-like-a-branch"]) {
      assert.equal(resolveBranchSource(repo.root, source), null, source);
    }
    git(repo.root, "checkout", "-q", "--detach", head);
    assert.equal(resolveBranchSource(repo.root, "HEAD"), null);
    assert.throws(() => resolveBranchSource(repo.root, "missing-branch"), /分支|引用|commit|rev-parse/);
  });

  test("分支和标签同名时拒绝模糊名称，完整引用仍可明确识别", () => {
    const repo = setup();
    const name = "feature/same-name";
    git(repo.root, "branch", name);
    git(repo.root, "tag", name);
    assert.throws(() => resolveBranchSource(repo.root, name), /歧义|ambiguous|引用/);
    assert.deepEqual(resolveBranchSource(repo.root, `refs/heads/${name}`), { name, ref: `refs/heads/${name}`, kind: "local" });
    assert.equal(resolveBranchSource(repo.root, `refs/tags/${name}`), null);
  });
});

describe("分支规则与项目配置集成", () => {
  test("公共判定只校验命名分支，交付要求明确分支来源", () => {
    const repo = setup();
    const project = { root: repo.root, config: { mainBranch: "main" }, policy: policy() };
    git(repo.root, "branch", "feature/add-policy-check");
    git(repo.root, "branch", "task/invalid");
    assert.deepEqual(branchProblems({ project, branch: "feature/add-policy-check", requireBranch: true }), []);
    assert.deepEqual(branchProblems({ project, branch: "main", requireBranch: true }), []);
    const bad = branchProblems({ project, branch: "task/invalid", requireBranch: true });
    assert.match(bad.join("\n"), /task\/invalid/);
    assert.match(bad.join("\n"), /feature\/add-policy-check/);
    const head = git(repo.root, "rev-parse", "HEAD");
    assert.deepEqual(branchProblems({ project, branch: head }), []);
    assert.notEqual(branchProblems({ project, branch: head, requireBranch: true }).length, 0);
    assert.deepEqual(branchProblems({ project: { ...project, policy: policy([RULE], [RULE.id]) }, branch: head, requireBranch: true }), []);
  });

  test("检查提交里的规则有效性，不误用当前工作区中的规则", () => {
    const repo = setup();
    const before = git(repo.root, "rev-parse", "HEAD");
    assert.equal(branchRuleErrorAt(repo.root, before), null);
    const good = commit(repo.root, "chore: 配置分支规范\n\n- 添加命名规则", { ".harness/policy.json": JSON.stringify(policy()) });
    assert.equal(branchRuleErrorAt(repo.root, good), null);
    const bad = commit(repo.root, "chore: 修改分支规范\n\n- 写入错误正则", { ".harness/policy.json": JSON.stringify(policy([{ ...RULE, pattern: "[" }])) });
    assert.match(branchRuleErrorAt(repo.root, bad), /正则/);
    assert.equal(branchRuleErrorAt(repo.root, good), null);
    const invalid = commit(repo.root, "chore: 修改分支规范\n\n- 写入错误配置", { ".harness/policy.json": "{" });
    assert.match(branchRuleErrorAt(repo.root, invalid), /JSON/);
  });

  test("统一断言分别报告命名错误、来源错误和配置错误", () => {
    const repo = setup();
    const project = { root: repo.root, config: { mainBranch: "main" }, policy: policy() };
    git(repo.root, "branch", "feature/add-policy-check");
    git(repo.root, "branch", "task/invalid");
    assert.equal(assertBranchPolicy({ project, branch: "feature/add-policy-check" }).source.name, "feature/add-policy-check");
    assert.throws(() => assertBranchPolicy({ project, branch: "task/invalid" }), (error) => {
      assert.equal(error.code, "bad_branch_name");
      for (const text of ["task/invalid", RULE.reason, RULE.fix, RULE.example]) assert.ok(error.message.includes(text), text);
      return true;
    });
    assert.throws(() => assertBranchPolicy({ project, branch: "missing-branch" }), { code: "bad_branch_name" });
    assert.throws(() => assertBranchPolicy({ project, branch: git(repo.root, "rev-parse", "HEAD"), requireBranch: true }), { code: "bad_branch_name" });
    const badProject = { ...project, policy: policy([{ ...RULE, pattern: "[" }]) };
    assert.throws(() => assertBranchPolicy({ project: badProject }), { code: "branch_name_rule_invalid" });
  });

  test("拟议的无效规则先于执行被拒绝，提交前可只检查生效规则", () => {
    const repo = setup();
    const project = { root: repo.root, config: { mainBranch: "main" }, policy: policy() };
    git(repo.root, "checkout", "-q", "-b", "feature/bad-rule");
    commit(repo.root, "chore: 配置分支规范\n\n- 写入错误正则", { ".harness/policy.json": JSON.stringify(policy([{ ...RULE, pattern: "[" }])) });
    assert.throws(() => assertBranchPolicy({ project, branch: "feature/bad-rule" }), { code: "branch_name_rule_invalid" });
    assert.equal(assertBranchPolicy({ project, branch: "feature/bad-rule", checkRule: false }).source.name, "feature/bad-rule");
    assert.throws(() => assertBranchPolicy({ project: { ...project, policy: policy([]) }, branch: "feature/bad-rule" }), { code: "branch_name_rule_invalid" });
  });
});
