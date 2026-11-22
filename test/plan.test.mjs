import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, CONFIG, commit, fakeReviewer, git, makeRepo, sh, write } from "./helpers.mjs";
import { writeRecord } from "../src/lib/store.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

const POLICY = { version: 1, presets: ["secrets", "git-safety", "gate-self", "plan-first"], disabled: [], rules: [] };
const BRANCH = "feat/login";
const ACCEPTANCE = ".harness/acceptance/feat-login.md";
const PLAN = "docs/changes/login/plan.md";
const QUOTE = "可以，开始实施";
const code = (lines) => `${Array.from({ length: lines }, (_, i) => `export const v${i} = ${i};`).join("\n")}\n`;
const sha = (text) => createHash("sha256").update(text).digest("hex");

function setup() {
  const config = { ...CONFIG, intent: { ...CONFIG.intent, plan: { maxLines: 5 } } };
  const repo = makeRepo({ project: { ".harness/config.json": config, ".harness/policy.json": POLICY } });
  repos.push(repo);
  return repo;
}

/** 会话停在 Linked Worktree 里的任务分支上。 */
function linkedTask(repo) {
  const linked = join(realpathSync(repo.root), "..", "task");
  git(repo.root, "worktree", "add", "-q", "-b", BRANCH, linked, "main");
  return linked;
}

function claudeHook(repo, payload) {
  return sh(repo.root, join(repo.root, ".harness/bin/harness"), ["hook", "--client", "claude"], repo.env, JSON.stringify(payload));
}
const writeHook = (repo, cwd, file) => claudeHook(repo, { tool_name: "Write", tool_input: { file_path: join(cwd, file), content: "x\n" }, cwd });
const bashHook = (repo, cwd, command) => claudeHook(repo, { tool_name: "Bash", tool_input: { command }, cwd });

function landed(repo, branch) {
  fakeReviewer(repo, APPROVE);
  for (const step of ["verify", "review"]) {
    const result = repo.cli(step, "--branch", branch);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  return repo.cli("merge", "--branch", branch);
}

describe("先方案后实施", () => {
  test("已授权任务更换实现路径和更新计划后按原验收直接交付", () => {
    const repo = setup();
    const linked = linkedTask(repo);
    commit(linked, "docs(login): 方案\n\n- 写明验收与实施路径", { [PLAN]: "# 方案\n\n用组件 A。\n", [ACCEPTANCE]: "- 登录成功后进入首页\n" });
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE).status, 0);
    commit(linked, "feat(login): 完成登录\n\n- 复用组件 B\n- 按同一验收交付", { [PLAN]: "# 方案\n\n实测后改用组件 B。\n", "src/app.js": code(10) });
    const result = landed(repo, BRANCH);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /已有实施授权/);
  });

  test("核心契约允许实施细节持续修订，核心变化须由人绑定新 hash 确认", () => {
    const repo = setup();
    const linked = linkedTask(repo);
    const contract = "docs/changes/login/contract.md";
    commit(linked, "docs(login): 核心契约与实施方案\n\n- 明确授权边界", {
      [PLAN]: "# 实施方案\n\n使用组件 A。\n",
      [contract]: "## 目标与主要方案\n\n- 用卡片展示入口\n\n## 验收底线\n\n- 保留现有权限\n",
      [ACCEPTANCE]: "- 登录成功后进入首页\n",
    });
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE).status, 0);

    commit(linked, "feat(login): 细化实现与验收\n\n- 不改变核心契约", {
      [PLAN]: "# 实施方案\n\n改用组件 B，已补充执行进度。\n",
      [ACCEPTANCE]: "- 登录成功后进入首页\n- 加载失败时可以重试\n",
    });
    assert.match(repo.cli("status", "--branch", BRANCH).stdout, /已有实施授权/);
    assert.equal(repo.cli("amend", "--branch", BRANCH, "--reason", "组件 B 已验证，补充失败恢复验收").status, 0);

    const changed = "## 目标与主要方案\n\n- 改回表格展示入口\n\n## 验收底线\n\n- 保留现有权限\n";
    commit(linked, "docs(login): 调整主要方案\n\n- 需要新的用户确认", { [contract]: changed });
    assert.match(repo.cli("status", "--branch", BRANCH).stdout, /核心授权契约在授权后改过/);
    const unconfirmed = repo.cli("approve", "--branch", BRANCH, "--yes", "--note", "确认新方案");
    assert.notEqual(unconfirmed.status, 0);
    assert.match(unconfirmed.stderr, /--confirm-contract/);
    assert.match(unconfirmed.stderr, /由人在自己的终端执行：harness approve --branch feat\/login --yes --note/);
    const denied = bashHook(repo, linked, `.harness/bin/harness approve --branch ${BRANCH} --yes --note "确认新方案" --confirm-contract ${sha(changed)}`);
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /contract-reapproval-human-only/);
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", "确认新方案", "--confirm-contract", sha(changed)).status, 0);
    assert.match(repo.cli("status", "--branch", BRANCH).stdout, /已有实施授权/);
  });

  test("工作区契约修改或删除后，实时写入门禁立即使授权失效", () => {
    const repo = setup();
    const linked = linkedTask(repo);
    const contract = "docs/changes/login/contract.md";
    const original = "# 核心契约\n\n- 保持权限边界\n";
    commit(linked, "docs(login): 核心契约\n\n- 明确权限边界", { [PLAN]: "# 实施方案\n", [contract]: original, [ACCEPTANCE]: "- 保持原行为\n" });
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE).status, 0);
    write(linked, contract, "# 核心契约\n\n- 改为扩大权限\n");
    assert.equal(writeHook(repo, linked, "src/app.js").status, 2);
    write(linked, contract, original);
    assert.equal(writeHook(repo, linked, "src/app.js").status, 0);
    rmSync(join(linked, contract));
    assert.equal(writeHook(repo, linked, "src/app.js").status, 2);
  });

  test("授权差异列出必需证据 ID 与阶段变化，不误报为纯排版", () => {
    const repo = setup();
    repo.branch(BRANCH, {
      "src/big.js": code(10),
      [ACCEPTANCE]: '## 应该发生\n\n- 甲\n\n<!-- harness:evidence id="browser" phase="pre-merge" -->\n',
    });
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE).status, 0);
    git(repo.root, "checkout", "-q", BRANCH);
    commit(repo.root, "docs(login): 调整必需证据\n\n- 更换检查并后置", {
      [ACCEPTANCE]: '## 应该发生\n\n- 甲\n\n<!-- harness:evidence id="smoke" phase="post-merge" -->\n',
    });
    git(repo.root, "checkout", "-q", "main");
    const text = repo.cli("status", "--branch", BRANCH).stdout;
    assert.match(text, /删除必需证据 browser\(pre-merge\)/);
    assert.match(text, /新增必需证据 smoke\(post-merge\)/);
    assert.doesNotMatch(text, /（没有内容行变化（只有空行、标题或排版变化））/);
  });

  test("旧任务新增核心契约也须由人确认，不能静默改变授权来源", () => {
    const repo = setup();
    const contract = "docs/changes/login/contract.md";
    repo.branch(BRANCH, { [PLAN]: "# 实施方案\n", [ACCEPTANCE]: "- 保持原行为\n" });
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE).status, 0);
    git(repo.root, "checkout", "-q", BRANCH);
    commit(repo.root, "docs(login): 引入核心契约\n\n- 明确唯一授权来源", { [contract]: "# 核心契约\n\n- 保持原行为\n" });
    git(repo.root, "checkout", "-q", "main");
    assert.notEqual(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", "确认契约").status, 0);
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", "确认契约", "--confirm-contract", sha("# 核心契约\n\n- 保持原行为\n")).status, 0);
  });

  test("写了实施方案后，记录授权前只能写方案文件；记录后放行，清单再改又要重新记录", () => {
    const repo = setup();
    const linked = linkedTask(repo);
    assert.equal(writeHook(repo, linked, "src/app.js").status, 0, "还没写方案时按直接实施处理");

    write(linked, PLAN, "# 实施方案\n");
    write(linked, ACCEPTANCE, "- 登录成功后进入首页\n");
    const denied = writeHook(repo, linked, "src/app.js");
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /plan-before-code/);
    assert.match(denied.stderr, /用户还没有同意实施时.*停下等待/);
    assert.match(denied.stderr, /harness approve --branch <任务分支> --yes --note/);
    assert.equal(writeHook(repo, linked, "src/app.test.js").status, 2, "测试同样要等授权");
    assert.equal(writeHook(repo, linked, "docs/changes/login/spec.md").status, 0);
    assert.equal(writeHook(repo, linked, ACCEPTANCE).status, 0);

    const early = repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE);
    assert.notEqual(early.status, 0, "方案没提交到分支时不能记录授权");
    assert.match(early.stderr, /先把方案提交到任务分支/);

    commit(linked, "docs(login): 方案\n\n- 验收清单与实施方案", {});
    const summary = repo.cli("approve", "--branch", BRANCH);
    assert.equal(summary.status, 0, summary.stderr);
    assert.match(summary.stdout, /docs\/changes\/login\/plan\.md/);
    assert.match(summary.stdout, /登录成功后进入首页/);
    assert.match(summary.stdout, /还没有记录用户的实施授权/);
    assert.match(summary.stdout, /用户在对话中明确同意实施该方案后，由 Agent 执行：harness approve --branch feat\/login --yes --note/);
    const approved = repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE);
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(repo.cli("approve", "--branch", BRANCH).stdout, new RegExp(`已记录实施授权（依据：${QUOTE}`));
    assert.equal(writeHook(repo, linked, "src/app.js").status, 0, "记录授权后可以写测试与实现");

    write(linked, ACCEPTANCE, "- 登录成功后进入首页\n- 新加一条\n");
    assert.equal(writeHook(repo, linked, "src/app.js").status, 2, "授权后清单又改了");
  });

  test("用户同意后由 Agent 记录授权，不需要用户执行命令，但必须照录原话", () => {
    const repo = setup();
    const linked = linkedTask(repo);
    commit(linked, "docs(login): 方案\n\n- 验收清单与实施方案", { [PLAN]: "# 实施方案\n", [ACCEPTANCE]: "- 登录成功后进入首页\n" });
    const agent = bashHook(repo, linked, `.harness/bin/harness approve --branch ${BRANCH} --yes --note "${QUOTE}"`);
    assert.equal(agent.status, 0, `Agent 可以记录授权: ${agent.stderr}`);

    for (const args of [["--yes"], ["--yes", "--note", "  "]]) {
      const refused = repo.cli("approve", "--branch", BRANCH, ...args);
      assert.notEqual(refused.status, 0, "没写依据时不记录");
      assert.match(refused.stderr, /--note/);
    }
    assert.match(repo.cli("status", "--branch", BRANCH).stdout, /待实施授权/);
  });

  test("小改动直接合并，不需要授权记录", () => {
    const repo = setup();
    repo.branch("fix/small", { "src/a.js": code(3) });
    const status = repo.cli("status", "--branch", "fix/small");
    assert.match(status.stdout, /\[ok\] plan: 属于直接实施的范围/);
    const merged = landed(repo, "fix/small");
    assert.equal(merged.status, 0, merged.stderr);
  });

  test("超过阈值或改了库表、没有授权记录时拒绝合并，记录后放行并显示依据", () => {
    const repo = setup();
    repo.branch(BRANCH, { "src/big.js": code(10), "src/big.test.js": code(50), [ACCEPTANCE]: "- 大改动\n" });
    const refused = landed(repo, BRANCH);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /plan_unapproved/);
    assert.match(refused.stderr, /代码改动 10 行，超过 5 行/, "测试文件不计入行数");
    assert.match(refused.stderr, /先向用户说明/);
    assert.match(repo.cli("status", "--branch", BRANCH).stdout, /待实施授权/);

    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE).status, 0);
    assert.match(repo.cli("status", "--branch", BRANCH).stdout, new RegExp(`已有实施授权.*依据：${QUOTE}`));
    const verified = repo.cli("verify", "--branch", BRANCH);
    assert.equal(verified.status, 0, verified.stderr);
    assert.doesNotMatch(verified.stderr, /RISK 要实施授权|RISK 实施授权已失效/);
    const merged = repo.cli("merge", "--branch", BRANCH);
    assert.equal(merged.status, 0, merged.stderr);
    assert.match(merged.stderr, new RegExp(`已有实施授权\\(依据: ${QUOTE}\\)`));

    repo.branch("feat/schema", { "db/migrations/0002_add_user.sql": "alter table t add c int;\n" });
    const schema = landed(repo, "feat/schema");
    assert.notEqual(schema.status, 0);
    assert.match(schema.stderr, /改了库表相关文件 db\/migrations\/0002_add_user\.sql/);
  });

  test("授权后改验收清单时，失效原因说明改了哪个章节、增删几条", () => {
    const repo = setup();
    repo.branch(BRANCH, { "src/big.js": code(10), [ACCEPTANCE]: "## 应该发生\n\n- 甲\n- 乙\n" });
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE).status, 0);

    git(repo.root, "checkout", "-q", BRANCH);
    commit(repo.root, "docs(login): 调整验收\n\n- 改掉一条验收\n- 补一条新验收", { [ACCEPTANCE]: "## 应该发生\n\n- 甲\n- 丙\n" });
    git(repo.root, "checkout", "-q", "main");

    const status = repo.cli("status", "--branch", BRANCH);
    assert.match(status.stdout, /合并前「应该发生 新增 1 条、删除 1 条」/, "要说出增删条数，不能让用户自己 diff");
    assert.match(status.stdout, /授权之后验收清单又改过/);

    const verify = repo.cli("verify", "--branch", BRANCH);
    assert.match(verify.stderr, /RISK 实施授权已失效: 授权之后验收清单又改过（合并前「应该发生 新增 1 条、删除 1 条」）/, "verify 也要显示失效，而不是只给静态提示");
  });

  test("只有排版变化时说清楚没有条目增删", () => {
    const repo = setup();
    repo.branch(BRANCH, { "src/big.js": code(10), [ACCEPTANCE]: "## 应该发生\n\n- 甲\n" });
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE).status, 0);

    git(repo.root, "checkout", "-q", BRANCH);
    commit(repo.root, "docs(login): 调整排版\n\n- 只加空行\n- 不改条目", { [ACCEPTANCE]: "## 应该发生\n\n\n- 甲\n" });
    git(repo.root, "checkout", "-q", "main");

    assert.match(repo.cli("status", "--branch", BRANCH).stdout, /没有内容行变化（只有空行、标题或排版变化）/);
  });

  test("授权后把条目移进「绝对不能发生」时说明两个章节", () => {
    const repo = setup();
    repo.branch(BRANCH, { "src/big.js": code(10), [ACCEPTANCE]: "## 应该发生\n\n- 甲\n- 会话自动续期\n" });
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE).status, 0);

    git(repo.root, "checkout", "-q", BRANCH);
    commit(repo.root, "docs(login): 反转一条验收\n\n- 从应该发生移到绝对不能发生\n- 需求已经变化", {
      [ACCEPTANCE]: "## 应该发生\n\n- 甲\n\n## 绝对不能发生\n\n- 会话自动续期\n",
    });
    git(repo.root, "checkout", "-q", "main");

    const stdout = repo.cli("status", "--branch", BRANCH).stdout;
    assert.match(stdout, /应该发生 删除 1 条/, "需求被反转，不能报成排版变化");
    assert.match(stdout, /绝对不能发生 新增 1 条/);
  });

  test("删除验收清单后说明清单缺失，不退化成通用授权提示", () => {
    const repo = setup();
    repo.branch(BRANCH, { "src/big.js": code(10), [ACCEPTANCE]: "## 应该发生\n\n- 甲\n" });
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE).status, 0);

    git(repo.root, "checkout", "-q", BRANCH);
    git(repo.root, "rm", "-q", ACCEPTANCE);
    commit(repo.root, "docs(login): 删除验收清单\n\n- 清单需要重写\n- 先看提示", {});
    git(repo.root, "checkout", "-q", "main");

    const line = repo.cli("verify", "--branch", BRANCH).stderr.split("\n").find((item) => item.includes("实施授权已失效")) ?? "";
    assert.match(line, /缺少验收清单/, "已有授权但清单没了，与从未授权是两件事");
  });

  test("旧授权记录没有章节摘要时，按授权时的提交还原清单再比对", () => {
    const repo = setup();
    repo.branch(BRANCH, { "src/big.js": code(10), [ACCEPTANCE]: "## 应该发生\n\n- 甲\n- 乙\n" });
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE).status, 0);

    // 把记录改写成 0.23 的格式（重新签名，模拟旧版本写下的记录）：没有 acceptanceLines，也没有 acceptancePath。
    const file = join(repo.env.HARNESS_DATA_DIR, "plan", "feat-login.json");
    const record = JSON.parse(readFileSync(file, "utf8"));
    delete record.acceptanceLines;
    delete record.acceptancePath;
    delete record.keyId;
    delete record.signature;
    writeRecord(repo.root, "plan", "feat-login", record);

    git(repo.root, "checkout", "-q", BRANCH);
    commit(repo.root, "docs(login): 改一条验收\n\n- 改掉乙\n- 换成丙", { [ACCEPTANCE]: "## 应该发生\n\n- 甲\n- 丙\n" });
    git(repo.root, "checkout", "-q", "main");

    assert.match(repo.cli("status", "--branch", BRANCH).stdout, /应该发生 新增 1 条、删除 1 条/);
  });

  test("approve 摘要列出合并后检查及本次改动是否命中", () => {
    const verify = {
      version: 1,
      docOnly: { match: ["docs/**", "**/*.md"], exclude: [] },
      checks: [
        { id: "unit", tier: "gate", when: ["src/**"], cmd: ["node", "-e", "process.exit(0)"] },
        { id: "login-smoke", tier: "extended", phase: "post-merge", when: ["src/other/**"], reason: "需要合入后环境", howToVerify: "部署后实测" },
      ],
      fullSuiteTriggers: { paths: [] },
    };
    const repo = makeRepo({ project: { ".harness/verify.json": verify } });
    repos.push(repo);
    repo.branch(BRANCH, { "src/big.js": code(10), [ACCEPTANCE]: "- 大改动\n" });
    const summary = repo.cli("approve", "--branch", BRANCH);
    assert.equal(summary.status, 0, summary.stderr);
    assert.match(summary.stdout, /login-smoke: 本次改动没有命中/, "交付时才发现会白干一轮，登记授权时就要看到");
  });

  test("账本记下授权的原话与清单指纹，记录被覆盖后仍可核对", () => {
    const repo = setup();
    repo.branch(BRANCH, { "src/big.js": code(10), [ACCEPTANCE]: "## 应该发生\n\n- 甲\n" });
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", QUOTE).status, 0);

    git(repo.root, "checkout", "-q", BRANCH);
    commit(repo.root, "docs(login): 改验收\n\n- 追加一条验收\n- 说明改动原因", { [ACCEPTANCE]: "## 应该发生\n\n- 甲\n- 乙\n" });
    git(repo.root, "checkout", "-q", "main");
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", "确认改成两条", "--confirm-contract", sha("## 应该发生\n\n- 甲\n- 乙\n")).status, 0);

    const ledger = readFileSync(join(repo.env.HARNESS_DATA_DIR, "ledger.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "plan.approve");
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0].note, QUOTE, "旧授权被覆盖后，账本里仍要留下当时的原话");
    assert.match(ledger[0].acceptanceHash, /^[0-9a-f]{16}$/);
    assert.notEqual(ledger[0].acceptanceHash, ledger[1].acceptanceHash, "两次授权的清单指纹要能区分");
  });

  test("授权原话里的凭据在写入记录与账本前就被遮掉", () => {
    const repo = setup();
    repo.branch(BRANCH, { "src/big.js": code(10), [ACCEPTANCE]: "## 应该发生\n\n- 甲\n" });
    const said = "确认：API_KEY=sk-live-abcdef123456 和 --token ghp-deadbeef 都可以跑";
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", said).status, 0);

    const record = JSON.parse(readFileSync(join(repo.env.HARNESS_DATA_DIR, "plan", "feat-login.json"), "utf8"));
    assert.doesNotMatch(record.note, /sk-live-abcdef123456/, "授权记录不能留下明文凭据");
    assert.doesNotMatch(record.note, /ghp-deadbeef/);
    assert.match(record.note, /确认：/);
    assert.match(record.note, /都可以跑/, "遮掉的只是凭据值，授权措辞要保留");

    const ledger = readFileSync(join(repo.env.HARNESS_DATA_DIR, "ledger.jsonl"), "utf8");
    assert.doesNotMatch(ledger, /sk-live-abcdef123456/);
    assert.doesNotMatch(ledger, /ghp-deadbeef/);
  });

  test("再次授权覆盖记录后，整份账本仍不含凭据", () => {
    const repo = setup();
    repo.branch(BRANCH, { "src/big.js": code(10), [ACCEPTANCE]: "## 应该发生\n\n- 甲\n" });
    const first = "先按这个跑，token=sk-first-abcdef123456";
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", first).status, 0);

    git(repo.root, "checkout", "-q", BRANCH);
    commit(repo.root, "docs(login): 补一条验收\n\n- 追加一条\n- 说明原因", { [ACCEPTANCE]: "## 应该发生\n\n- 甲\n- 乙\n" });
    git(repo.root, "checkout", "-q", "main");
    const second = "确认，password=hunter2-secret 这次也一样";
    assert.equal(repo.cli("approve", "--branch", BRANCH, "--yes", "--note", second, "--confirm-contract", sha("## 应该发生\n\n- 甲\n- 乙\n")).status, 0);

    const ledger = readFileSync(join(repo.env.HARNESS_DATA_DIR, "ledger.jsonl"), "utf8");
    assert.doesNotMatch(ledger, /sk-first-abcdef123456/, "被覆盖的那次授权同样不能留明文");
    assert.doesNotMatch(ledger, /hunter2-secret/);
    const approvals = ledger.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.event === "plan.approve");
    assert.equal(approvals.length, 2, "两次授权都要留在账本里，措辞与指纹仍可追溯");
    assert.ok(approvals.every((event) => /^[0-9a-f]{16}$/.test(event.acceptanceHash)));
  });

  test("未启用 plan-first 的项目不受影响", () => {
    const repo = makeRepo();
    repos.push(repo);
    repo.branch("feat/big", { "src/big.js": code(800) });
    const merged = landed(repo, "feat/big");
    assert.equal(merged.status, 0, merged.stderr);
  });

  test("升级会刷新 AGENTS.md 的托管块，块外内容保留", () => {
    const repo = setup();
    write(repo.root, "AGENTS.md", "# 项目规范\n\n自己的规则\n\n<!-- harness:start -->\n旧内容\n<!-- harness:end -->\n");
    assert.equal(repo.cli("upgrade").status, 0);
    const text = readFileSync(join(repo.root, "AGENTS.md"), "utf8");
    assert.match(text, /自己的规则/);
    assert.doesNotMatch(text, /旧内容/);
    assert.match(text, /先判断任务分级/);
    assert.match(text, /用户表达开始实施的意思才算授权/);
    assert.match(text, /已授权的任务连续推进到交付/);
    assert.match(text, /每一轮以工具调用推进/);
    assert.match(text, /回应客户端的进度提醒后继续调用工具，不结束这一轮/);
    assert.match(text, /先红后绿/);
  });
});
