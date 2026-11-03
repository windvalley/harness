import { strict as assert } from "node:assert";
import { afterEach, describe, test } from "node:test";
import { APPROVE, CONFIG, commit, fakeReviewer, git, makeRepo } from "./helpers.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

const POLICY = { version: 1, presets: ["secrets", "git-safety", "gate-self", "plan-first"], disabled: [], rules: [] };
const RISK = { paths: [".github/workflows/**", "deploy/**"], deps: ["**/package-lock.json", "go.mod"] };
const QUOTE = "可以，开始实施";
const WORKFLOW = ".github/workflows/ci.yml";
const code = (lines) => `${Array.from({ length: lines }, (_, i) => `export const v${i} = ${i};`).join("\n")}\n`;
const acceptanceOf = (branch) => `.harness/acceptance/${branch.replace(/\//g, "-")}.md`;

function setup({ risk = RISK, policy = POLICY, config = {} } = {}) {
  const base = { ...CONFIG, intent: { ...CONFIG.intent, plan: { maxLines: 5 } }, ...config };
  if (risk !== null) base.risk = risk;
  const repo = makeRepo({ project: { ".harness/config.json": base, ".harness/policy.json": policy } });
  repos.push(repo);
  return repo;
}

/** verify、review 之后尝试合并，返回合并结果。 */
function landed(repo, branch) {
  fakeReviewer(repo, APPROVE);
  for (const step of ["verify", "review"]) {
    const result = repo.cli(step, "--branch", branch);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  return repo.cli("merge", "--branch", branch);
}

describe("风险分级", () => {
  test("没有命中任何信号的小改动自动放行", () => {
    const repo = setup();
    repo.branch("fix/small", { "src/a.js": code(3) });
    assert.match(repo.cli("status", "--branch", "fix/small").stdout, /\[ok\] risk: 没有命中需要人确认的风险信号/);
    const merged = landed(repo, "fix/small");
    assert.equal(merged.status, 0, merged.stderr);
  });

  test("命中敏感路径要人确认，确认后放行，确认绑定内容", () => {
    const repo = setup();
    repo.branch("feat/ci", { [WORKFLOW]: "name: ci\n" });
    const refused = landed(repo, "feat/ci");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /risk_unconfirmed/);
    assert.match(refused.stderr, /敏感路径 \.github\/workflows\/ci\.yml/);
    assert.match(refused.stderr, /harness confirm --branch feat\/ci/);
    const status = repo.cli("status", "--branch", "feat/ci").stdout;
    assert.match(status, /\[FAIL\] risk: .*敏感路径/);
    assert.match(status, /风险改动待确认/);

    const summary = repo.cli("confirm", "--branch", "feat/ci");
    assert.equal(summary.status, 0, summary.stderr);
    assert.match(summary.stdout, /风险分级: T2/);
    assert.match(summary.stdout, /敏感路径 \.github\/workflows\/ci\.yml/);
    assert.doesNotMatch(summary.stdout, /无需确认/);

    assert.equal(repo.cli("confirm", "--branch", "feat/ci", "--yes").status, 0);
    assert.match(repo.cli("status", "--branch", "feat/ci").stdout, /\[ok\] risk: .*已确认/);
    const merged = repo.cli("merge", "--branch", "feat/ci");
    assert.equal(merged.status, 0, merged.stderr);
    assert.match(merged.stderr, /风险改动已确认/);
  });

  test("删除敏感路径下的文件同样命中", () => {
    const repo = setup();
    commit(repo.root, "ci: 增加流水线\n\n- 初始流水线", { [WORKFLOW]: "name: ci\n" });
    git(repo.root, "checkout", "-q", "-b", "chore/rm-ci");
    git(repo.root, "rm", "-q", WORKFLOW);
    const bypass = { ...repo.env, HARNESS_MAIN_BYPASS: "1" };
    git(repo.root, "commit", "-q", "--no-verify", "-m", "chore: 删除流水线\n\n- 不再使用", bypass);
    git(repo.root, "checkout", "-q", "main");
    const refused = landed(repo, "chore/rm-ci");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /risk_unconfirmed/);
  });

  test("依赖清单变化要实施授权，锁文件不受代码行数排除影响", () => {
    const repo = setup();
    const branch = "feat/deps";
    repo.branch(branch, { "package-lock.json": "{}\n", [acceptanceOf(branch)]: "- 升级依赖\n" });
    const refused = landed(repo, branch);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /plan_unapproved/);
    assert.match(refused.stderr, /依赖清单变化 package-lock\.json/);

    assert.equal(repo.cli("approve", "--branch", branch, "--yes", "--note", QUOTE).status, 0);
    const merged = repo.cli("merge", "--branch", branch);
    assert.equal(merged.status, 0, merged.stderr);
  });

  test("T1 与 T2 取并集：确认不能替代授权", () => {
    const repo = setup();
    const branch = "feat/both";
    repo.branch(branch, { "src/big.js": code(10), [WORKFLOW]: "name: ci\n", [acceptanceOf(branch)]: "- 大改动\n" });
    const first = landed(repo, branch);
    assert.match(first.stderr, /risk_unconfirmed/);
    assert.equal(repo.cli("confirm", "--branch", branch, "--yes").status, 0);

    const second = repo.cli("merge", "--branch", branch);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /plan_unapproved/, "确认之后仍然需要实施授权");
    assert.equal(repo.cli("approve", "--branch", branch, "--yes", "--note", QUOTE).status, 0);
    const merged = repo.cli("merge", "--branch", branch);
    assert.equal(merged.status, 0, merged.stderr);
    assert.match(merged.stderr, /已有实施授权/);
    assert.match(merged.stderr, /风险改动已确认/);
  });

  test("没有 risk 配置的项目行为不变", () => {
    const repo = setup({ risk: null });
    repo.branch("feat/ci", { [WORKFLOW]: "name: ci\n", "package-lock.json": "{}\n" });
    const merged = landed(repo, "feat/ci");
    assert.equal(merged.status, 0, merged.stderr);
  });

  test("不依赖 plan-first 预设与 confirmOnGateChange", () => {
    const repo = setup({
      policy: { version: 1, presets: ["secrets", "git-safety", "gate-self"], disabled: [], rules: [] },
      config: { governance: { confirmOnGateChange: false, gatePaths: [] } },
    });
    repo.branch("feat/ci", { [WORKFLOW]: "name: ci\n" });
    const refused = landed(repo, "feat/ci");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /risk_unconfirmed/);
  });

  test("分支放宽不了自己的档位：判定读主分支配置，摘要列出风险配置的改动", () => {
    const repo = setup();
    const relaxed = { ...CONFIG, intent: { ...CONFIG.intent, plan: { maxLines: 5 } }, risk: { paths: [], deps: [] } };
    repo.branch("feat/relax", { ".harness/config.json": `${JSON.stringify(relaxed, null, 2)}\n`, [WORKFLOW]: "name: ci\n" });
    const refused = landed(repo, "feat/relax");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /gate_change_unconfirmed/);
    const summary = repo.cli("confirm", "--branch", "feat/relax").stdout;
    assert.match(summary, /风险配置有改动/);
    assert.match(summary, /敏感路径 \.github\/workflows\/ci\.yml/, "仍按主分支的配置判定为 T2");
    assert.equal(repo.cli("confirm", "--branch", "feat/relax", "--yes").status, 0);
    assert.equal(repo.cli("merge", "--branch", "feat/relax").status, 0);
  });

  test("风险配置写错形状时按需要确认处理", () => {
    const repo = setup({ risk: { paths: ".github/**", deps: [] } });
    repo.branch("feat/small", { "src/a.js": code(2) });
    const refused = landed(repo, "feat/small");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /risk_unconfirmed/);
    assert.match(refused.stderr, /风险配置无效/);
  });
});
