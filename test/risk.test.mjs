import { strict as assert } from "node:assert";
import { afterEach, describe, test } from "node:test";
import { APPROVE, CONFIG, commit, fakeReviewer, git, makeRepo } from "./helpers.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
function ledgerEvents(repo) {
  const file = join(repo.env.HARNESS_DATA_DIR, "ledger.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}
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

  test("T1 与 T2 取并集：确认不能替代授权，授权也不能替代确认", () => {
    const repo = setup();
    const branch = "feat/both";
    repo.branch(branch, { "src/big.js": code(10), [WORKFLOW]: "name: ci\n", [acceptanceOf(branch)]: "- 大改动\n" });
    const first = landed(repo, branch);
    assert.match(first.stderr, /plan_unapproved/);

    assert.equal(repo.cli("confirm", "--branch", branch, "--yes").status, 0);
    const second = repo.cli("merge", "--branch", branch);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /plan_unapproved/, "确认之后仍然需要实施授权");
    assert.doesNotMatch(second.stderr, /另外还差人确认/, "已确认的不再重复提示");

    assert.equal(repo.cli("approve", "--branch", branch, "--yes", "--note", QUOTE).status, 0);
    const merged = repo.cli("merge", "--branch", branch);
    assert.equal(merged.status, 0, merged.stderr);
    assert.match(merged.stderr, /已有实施授权/);
    assert.match(merged.stderr, /风险改动已确认/);
  });

  test("只有授权没有确认时，验证评审通过后仍报 risk_unconfirmed", () => {
    const repo = setup();
    const branch = "feat/both3";
    repo.branch(branch, { "src/big.js": code(10), [WORKFLOW]: "name: ci\n", [acceptanceOf(branch)]: "- 大改动\n" });
    landed(repo, branch);
    assert.equal(repo.cli("approve", "--branch", branch, "--yes", "--note", QUOTE).status, 0);
    const refused = repo.cli("merge", "--branch", branch);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /risk_unconfirmed/);
    assert.match(refused.stderr, /验证与评审已通过/);
  });

  test("同时缺授权和确认时一次说全，先授权后确认各自满足才放行", () => {
    const repo = setup();
    const branch = "feat/both2";
    repo.branch(branch, { "src/big.js": code(10), [WORKFLOW]: "name: ci\n", [acceptanceOf(branch)]: "- 大改动\n" });
    const refused = landed(repo, branch);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /plan_unapproved/);
    assert.match(refused.stderr, /另外还差人确认高风险改动.*harness confirm --branch feat\/both2/s, "授权被拒时同时说明还差确认");
    const status = repo.cli("status", "--branch", branch).stdout;
    assert.match(status, /待实施授权/);
    assert.match(status, /风险改动待确认/);
  });

  test("验证失败时不先请人确认风险改动", () => {
    const repo = setup();
    repo.branch("feat/ci-bad", { [WORKFLOW]: "name: ci\n" });
    fakeReviewer(repo, APPROVE);
    const refused = repo.cli("merge", "--branch", "feat/ci-bad", "--dry-run");
    assert.notEqual(refused.status, 0);
    assert.doesNotMatch(refused.stderr, /risk_unconfirmed/, "还没有评审记录时不该先问人");
  });

  test("risk.exclude 里的路径不算敏感，只改它们的分支自动放行", () => {
    const repo = setup({ risk: { ...RISK, exclude: ["deploy/**/*.md", "**/testdata/**"] } });
    repo.branch("docs/deploy", { "deploy/README.md": "说明\n", "pkg/testdata/Dockerfile": "FROM x\n" });
    const merged = landed(repo, "docs/deploy");
    assert.equal(merged.status, 0, merged.stderr);

    repo.branch("feat/deploy", { "deploy/run.sh": "echo\n", "deploy/README.md": "改\n" });
    const refused = landed(repo, "feat/deploy");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /risk_unconfirmed/);
    assert.match(refused.stderr, /deploy\/run\.sh/);
    assert.doesNotMatch(refused.stderr, /deploy\/README\.md/, "被排除的文件不进风险信号");
  });

  test("risk.exclude 写错形状时按需要人确认处理", () => {
    const repo = setup({ risk: { ...RISK, exclude: "deploy/**" } });
    repo.branch("feat/small", { "src/a.js": code(2) });
    const refused = landed(repo, "feat/small");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /风险配置无效/);
  });

  test("verify --plan 与 verify 在交付之前就提示命中的风险信号", () => {
    const repo = setup();
    const branch = "fix/tidy";
    repo.branch(branch, { "src/a.js": code(2), "package-lock.json": "{}\n", [WORKFLOW]: "name: ci\n" });
    const plan = repo.cli("verify", "--plan", "--branch", branch);
    assert.equal(plan.status, 0, plan.stderr);
    assert.match(plan.stdout, /RISK 要实施授权: 依赖清单变化 package-lock\.json/);
    assert.match(plan.stdout, /RISK 要人确认: 敏感路径 \.github\/workflows\/ci\.yml/);
    assert.match(plan.stdout, /harness approve --branch fix\/tidy/);

    fakeReviewer(repo, APPROVE);
    const verified = repo.cli("verify", "--branch", branch);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stderr, /RISK 要实施授权: 依赖清单变化 package-lock\.json/);
    assert.match(verified.stderr, /RISK 要人确认/);
  });

  test("没有命中风险信号时 verify 不输出 RISK 行", () => {
    const repo = setup();
    repo.branch("fix/small", { "src/a.js": code(2) });
    const plan = repo.cli("verify", "--plan", "--branch", "fix/small");
    assert.doesNotMatch(plan.stdout, /RISK/);
  });

  test("观察模式：命中信号只记录不拦截，输出与账本都留下记录", () => {
    const repo = setup({ risk: { ...RISK, mode: "observe" } });
    const branch = "feat/obs";
    repo.branch(branch, { [WORKFLOW]: "name: ci\n", "package-lock.json": "{}\n" });

    const plan = repo.cli("verify", "--plan", "--branch", branch);
    assert.match(plan.stdout, /RISK 观察（不拦截）: 敏感路径 \.github\/workflows\/ci\.yml/);
    assert.match(plan.stdout, /RISK 观察（不拦截）: 依赖清单变化 package-lock\.json/);
    assert.doesNotMatch(plan.stdout, /RISK 要人确认|RISK 要实施授权/);

    fakeReviewer(repo, APPROVE);
    for (const step of ["verify", "review"]) assert.equal(repo.cli(step, "--branch", branch).status, 0);
    const status = repo.cli("status", "--branch", branch).stdout;
    assert.match(status, /\[ok\] risk: 观察模式，命中 2 项（不拦截）/);
    assert.doesNotMatch(status, /风险改动待确认|待实施授权/);
    assert.match(repo.cli("confirm", "--branch", branch).stdout, /风险观察（不拦截）/);

    const merged = repo.cli("merge", "--branch", branch);
    assert.equal(merged.status, 0, merged.stderr);
    assert.match(merged.stderr, /风险观察（不拦截）: 敏感路径 \.github\/workflows\/ci\.yml；依赖清单变化 package-lock\.json/);

    const ledger = ledgerEvents(repo).filter((event) => event.event === "merge" && event.branch === branch);
    assert.equal(ledger.length, 1);
    assert.deepEqual(ledger[0].riskObserved, ["敏感路径 .github/workflows/ci.yml", "依赖清单变化 package-lock.json"]);
  });

  test("观察模式不影响原有的授权要求，也不影响没命中的改动", () => {
    const repo = setup({ risk: { ...RISK, mode: "observe" } });
    const branch = "feat/obs-big";
    repo.branch(branch, { "src/big.js": code(10), [acceptanceOf(branch)]: "- 大改动\n" });
    const refused = landed(repo, branch);
    assert.match(refused.stderr, /plan_unapproved/, "代码行数等原有信号仍然拦");

    repo.branch("fix/obs-small", { "src/a.js": code(2) });
    const merged = landed(repo, "fix/obs-small");
    assert.equal(merged.status, 0, merged.stderr);
    const event = ledgerEvents(repo).find((item) => item.event === "merge" && item.branch === "fix/obs-small");
    assert.deepEqual(event.riskObserved ?? [], []);
  });

  test("mode 写错值时按需要人确认处理；显式 enforce 与不写一样", () => {
    const bad = setup({ risk: { ...RISK, mode: "off" } });
    bad.branch("feat/small", { "src/a.js": code(2) });
    const refused = landed(bad, "feat/small");
    assert.match(refused.stderr, /risk_unconfirmed/);
    assert.match(refused.stderr, /risk\.mode/);

    const strict = setup({ risk: { ...RISK, mode: "enforce" } });
    strict.branch("feat/ci", { [WORKFLOW]: "name: ci\n" });
    assert.match(landed(strict, "feat/ci").stderr, /risk_unconfirmed/);
  });

  test("init 给新项目的默认：先观察不拦截，依赖只认声明依赖的清单，不含锁文件与 package.json", () => {
    const repo = makeRepo({
      install: false,
      project: { ".harness/config.json": null, ".harness/policy.json": null, ".harness/verify.json": null },
    });
    repos.push(repo);
    const init = repo.rawCli("init");
    assert.equal(init.status, 0, init.stderr + init.stdout);
    const { risk } = JSON.parse(readFileSync(join(repo.root, ".harness/config.json"), "utf8"));
    assert.equal(risk.mode, "observe");
    assert.ok(risk.paths.includes(".github/workflows/**"));
    assert.ok(risk.deps.includes("**/go.mod"));
    assert.ok(risk.deps.includes("**/requirements*.txt"));
    for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "go.sum", "Cargo.lock", "package.json"]) {
      assert.ok(!risk.deps.some((glob) => glob.endsWith(`/${name}`) || glob === name), `${name} 不该在默认依赖清单里`);
    }
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
