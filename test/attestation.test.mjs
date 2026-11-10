import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, commit, fakeReviewer, git, makeRepo } from "./helpers.mjs";
import { verifyConfigProblems } from "../src/verify/verify.mjs";
import { attestCheck } from "../src/verify/attestation.mjs";
import { splitAcceptance } from "../src/lib/acceptance.mjs";
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
    const result = repo.cli("verify", "--branch", "task/a");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /合并后验收.*没有对应.*post-merge/s);
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
