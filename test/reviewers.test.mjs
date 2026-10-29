import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, CONFIG, fakeClaudes, fakeCodex, git, makeRepo, PACKAGE_ROOT, readReviewRecord, sh, writeReviewers } from "./helpers.mjs";
import { describePlan, planReviewers, reviewerArgs, reviewerLines, reviewerSummary } from "../src/review/review.mjs";
import { loadLocalReviewers, maskKey, orderReviewers, parseReviewers } from "../src/review/reviewers.mjs";
import { detectSessionModel, normalizeModel, sameModel } from "../src/review/session.mjs";

let repos = [];
let dirs = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  repos = [];
  dirs = [];
});
function setup(opts = {}) {
  const repo = makeRepo(opts);
  repos.push(repo);
  return repo;
}
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "harness-reviewers-"));
  dirs.push(dir);
  return dir;
}

const KEY = "sk-test-0123456789abcdef-SECRET";
const FLASH = { name: "flash", client: "claude", model: "deepseek/deepseek-v4.1-flash", baseUrl: "https://llm.example.test", apiKey: KEY, effort: "high" };
const SONNET = { name: "sonnet", client: "claude", model: "sonnet" };

// 建一个已经验证过、可以评审的任务分支，返回分支名与提交号。
function readyBranch(repo, name = "task/a") {
  const oid = repo.branch(name, { "a.txt": "a\n" });
  assert.equal(repo.cli("verify", "--branch", name).status, 0);
  return { name, oid };
}

describe("模型名比较", () => {
  test("不同来源的写法归一化后判为同一个模型", () => {
    assert.equal(normalizeModel("anthropic/claude-opus-5.5-cpr[1M]"), "claude-opus-5-5");
    assert.equal(normalizeModel("claude-opus-5-5"), "claude-opus-5-5");
    assert.equal(normalizeModel("coding-anthropic/claude-opus-5.5"), "claude-opus-5-5");
    assert.ok(sameModel("anthropic/claude-opus-5.5-cpr[1M]", "claude-opus-5-5"));
    assert.ok(sameModel("DeepSeek/DeepSeek-V4.1-Flash", "deepseek-v4-1-flash"));
  });

  test("按具体模型比较：同一厂商的不同模型算不同，空值不算相同", () => {
    assert.equal(sameModel("claude-opus-5-5", "claude-sonnet-5-5"), false);
    assert.equal(sameModel("deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro"), false);
    assert.equal(sameModel("", ""), false);
    assert.equal(sameModel(undefined, "claude-opus-5-5"), false);
  });
});

describe("本机评审者文件的校验", () => {
  const ok = { reviewers: [FLASH, SONNET, { name: "codex", client: "codex" }] };

  test("合法内容规整后返回，preferDifferentModel 默认开启", () => {
    const parsed = parseReviewers(ok);
    assert.equal(parsed.preferDifferentModel, true);
    assert.deepEqual(parsed.reviewers.map((item) => item.name), ["flash", "sonnet", "codex"]);
    assert.equal(parseReviewers({ ...ok, preferDifferentModel: false }).preferDifferentModel, false);
  });

  test("不认识的字段、非法取值与缺项都报错", () => {
    const bad = (reviewer, pattern) => assert.throws(() => parseReviewers({ reviewers: [reviewer] }), pattern);
    assert.throws(() => parseReviewers({ reviewers: [SONNET], extra: 1 }), /不认识的字段 extra/);
    assert.throws(() => parseReviewers({ reviewers: [] }), /非空数组/);
    bad({ ...SONNET, color: "red" }, /不认识的字段 color/);
    bad({ ...SONNET, client: "gemini" }, /client 必须是/);
    bad({ name: "x", client: "claude" }, /必须写 model/);
    bad({ ...SONNET, effort: "ultra" }, /effort 必须是 low、medium、high、xhigh、max/);
    bad({ ...SONNET, effort: "minimal" }, /effort 必须是/);
    bad({ ...SONNET, timeoutMinutes: 0 }, /timeoutMinutes/);
    bad({ ...SONNET, maxBudgetUsd: -1 }, /maxBudgetUsd/);
    bad({ ...SONNET, baseUrl: "not a url" }, /baseUrl 必须是 http 或 https/);
    bad({ name: "c", client: "command" }, /必须在 command 里给出命令数组/);
    bad({ ...SONNET, command: ["x"] }, /command 只对 command 客户端有效/);
    bad({ name: "c", client: "codex", baseUrl: "https://x.test" }, /baseUrl 目前只对 claude 客户端有效/);
    bad({ name: "c", client: "codex", apiKey: "k" }, /apiKey 目前只对 claude 客户端有效/);
    bad({ name: "bad name", client: "codex" }, /name 必须是/);
    assert.throws(() => parseReviewers({ reviewers: [SONNET, SONNET] }), /名字 sonnet 重复/);
  });

  test("校验失败的信息里不回显 apiKey", () => {
    for (const reviewer of [{ ...FLASH, effort: "ultra" }, { ...FLASH, baseUrl: "bad" }, { ...FLASH, timeoutMinutes: "x" }]) {
      try {
        parseReviewers({ reviewers: [reviewer] });
        assert.fail("应当报错");
      } catch (error) {
        assert.doesNotMatch(error.message, /SECRET/);
      }
    }
    assert.equal(maskKey(KEY), "****CRET");
    assert.equal(maskKey("short"), "****");
  });

  test("文件不存在返回 null，内容不是 JSON 时报错而不是当作不存在", () => {
    const dir = tempDir();
    assert.equal(loadLocalReviewers({ file: join(dir, "none.json") }), null);
    writeFileSync(join(dir, "bad.json"), "{ not json");
    assert.throws(() => loadLocalReviewers({ file: join(dir, "bad.json") }), /不是合法的 JSON/);
  });
});

describe("按会话模型调整顺序", () => {
  const entries = [
    { name: "opus", client: "claude", model: "anthropic/claude-opus-5.5" },
    { name: "flash", client: "claude", model: "deepseek/deepseek-v4.1-flash" },
    { name: "sonnet", client: "claude", model: "sonnet" },
    { name: "codex", client: "codex" },
  ];
  const names = (list) => list.map((item) => item.name);

  test("与会话同模型的排到最后，其余保持原有先后；没写模型的无法判断，留在原位", () => {
    const { ordered, reordered } = orderReviewers(entries, "claude-opus-5-5");
    assert.deepEqual(names(ordered), ["flash", "sonnet", "codex", "opus"]);
    assert.equal(reordered, true);
  });

  test("会话模型不在列表里、未知或关闭时保持原顺序", () => {
    assert.deepEqual(names(orderReviewers(entries, "gpt-9").ordered), ["opus", "flash", "sonnet", "codex"]);
    assert.equal(orderReviewers(entries, "gpt-9").reordered, false);
    assert.equal(orderReviewers(entries, null).reordered, false);
    assert.equal(orderReviewers(entries, "claude-opus-5-5", false).reordered, false);
    assert.deepEqual(names(orderReviewers(entries, "claude-opus-5-5", false).ordered), names(entries));
  });

  test("按具体模型比较：会话用 opus 时 sonnet 不被后移", () => {
    const { ordered } = orderReviewers([{ name: "sonnet", client: "claude", model: "claude-sonnet-5-5" }, entries[0]], "claude-opus-5-5");
    assert.deepEqual(names(ordered), ["sonnet", "opus"]);
  });
});

describe("读取会话模型", () => {
  function transcript(lines) {
    const home = tempDir();
    const dir = join(home, ".claude", "projects", "-some-project");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sess-1.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    return home;
  }
  const assistant = (model) => ({ type: "assistant", message: { model, content: [] } });

  test("取最后一条真实的 assistant 消息，跳过合成消息；中途切换模型以最后一次为准", () => {
    const home = transcript([assistant("claude-opus-5-5"), assistant("DeepSeek-V4.1-Flash"), { type: "user" }, assistant("<synthetic>")]);
    const found = detectSessionModel({ env: { CLAUDE_CODE_SESSION_ID: "sess-1" }, home });
    assert.deepEqual(found, { model: "DeepSeek-V4.1-Flash", client: "claude", reason: null });
  });

  test("没有会话编号、找不到记录或没有模型信息时返回未知并说明原因", () => {
    const home = transcript([{ type: "user" }]);
    assert.equal(detectSessionModel({ env: {}, home }).model, null);
    assert.match(detectSessionModel({ env: {}, home }).reason, /没有会话编号/);
    assert.match(detectSessionModel({ env: { CLAUDE_CODE_SESSION_ID: "nope" }, home }).reason, /找不到当前会话的记录/);
    assert.match(detectSessionModel({ env: { CLAUDE_CODE_SESSION_ID: "sess-1" }, home }).reason, /没有可用的模型信息/);
    assert.match(detectSessionModel({ env: { CLAUDE_CODE_SESSION_ID: "../etc" }, home }).reason, /不合法/);
  });
});

describe("评审计划", () => {
  const has = (bin) => bin !== "codex";
  const detect = () => ({ model: "claude-opus-5-5", client: "claude", reason: null });
  const local = (reviewers, prefer = true) => ({ file: "/x/reviewers.json", preferDifferentModel: prefer, reviewers });

  test("启动前能判断的不可用直接标记跳过：写了 baseUrl 没有 key、命令不在 PATH 里", () => {
    const plan = planReviewers(
      {},
      {
        local: local([{ name: "nokey", client: "claude", model: "m", baseUrl: "https://x.test" }, { name: "codex", client: "codex" }, { name: "cmd", client: "command", command: ["/nonexistent/reviewer"] }, SONNET]),
        has: (bin) => bin === "claude",
        overrideBin: undefined,
        detect,
      },
    );
    const by = Object.fromEntries(plan.candidates.map((item) => [item.name, item.skip]));
    assert.match(by.nokey, /没有 apiKey，不用客户端的默认账号顶替/);
    assert.match(by.codex, /codex 不在 PATH/);
    assert.match(by.cmd, /不在 PATH/);
    assert.equal(by.sonnet, null);
  });

  test("超时按评审者配置，默认 20 分钟", () => {
    const plan = planReviewers({}, { local: local([{ ...SONNET, timeoutMinutes: 30 }]), has, overrideBin: undefined, detect });
    assert.equal(plan.candidates[0].timeoutMinutes, 30);
    const defaults = planReviewers({}, { local: local([SONNET]), has, overrideBin: undefined, detect });
    assert.equal(defaults.candidates[0].timeoutMinutes, undefined);
  });

  test("计划说明写出顺序、会话模型和是否调整过", () => {
    const entries = [{ name: "opus", client: "claude", model: "anthropic/claude-opus-5.5" }, SONNET];
    const text = describePlan(planReviewers({}, { local: local(entries), has, overrideBin: undefined, detect }));
    assert.match(text, /sonnet\(sonnet\) -> opus\(anthropic\/claude-opus-5\.5\)；与会话模型 claude-opus-5-5 相同的排到了后面/);
    const unknown = describePlan(planReviewers({}, { local: local(entries), has, overrideBin: undefined, detect: () => ({ model: null, reason: "当前环境没有会话编号" }) }));
    assert.match(unknown, /会话模型未知（当前环境没有会话编号），按文件里的顺序/);
  });

  test("没有本机文件时按项目旧字段，只有一个评审者", () => {
    const plan = planReviewers({ backend: "claude", model: "opus" }, { local: null, has, overrideBin: undefined, detect });
    assert.equal(plan.source, "project");
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].model, "opus");
  });
});

describe("claude 参数", () => {
  test("预算不配就不传，推理强度配了才传", () => {
    const bare = reviewerArgs({ model: "sonnet" });
    assert.ok(!bare.includes("--max-budget-usd"));
    assert.ok(!bare.includes("--effort"));
    const full = reviewerArgs({ model: "sonnet", maxBudgetUsd: 3, effort: "xhigh" });
    assert.equal(full[full.indexOf("--effort") + 1], "xhigh");
    assert.equal(full[full.indexOf("--max-budget-usd") + 1], "3");
  });
});

describe("多个评审者的回退", () => {
  test("前一个失败后换下一个，记录里写明谁完成、前面为什么失败，并在输出里点出备选", () => {
    const repo = setup();
    const { name, oid } = readyBranch(repo);
    const claude = fakeClaudes(repo, { "deepseek/deepseek-v4.1-flash": { mode: "fail", message: `Failed to authenticate. API Error: 401 ${KEY}` } });
    writeReviewers(repo, { reviewers: [FLASH, SONNET] });

    const review = repo.cli("review", "--branch", name);
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stderr, /flash 失败，换下一个/);
    assert.match(review.stderr, /评审者: sonnet/);
    assert.match(review.stderr, /由备选 sonnet 完成/);
    assert.match(review.stderr, /flash: 失败/);
    assert.deepEqual(claude.calls().map((call) => call.model), ["deepseek/deepseek-v4.1-flash", "sonnet"]);

    const record = readReviewRecord(repo, oid);
    assert.equal(record.reviewer.name, "sonnet");
    assert.equal(record.reviewer.source, "local");
    assert.deepEqual(record.reviewer.actualModels, ["sonnet"]);
    assert.deepEqual(record.attempts.map((item) => [item.name, item.outcome]), [["flash", "failed"], ["sonnet", "done"]]);
    assert.match(record.attempts[0].reason, /401/);
    assert.equal(record.backend, "claude");
  });

  test("给出结论就停：评审拒绝时不换下一个评审者重评", () => {
    const repo = setup();
    const { name } = readyBranch(repo);
    const reject = {
      ...APPROVE,
      verdict: "reject",
      findings: [{ severity: "high", file: "a.txt", summary: "有问题", scenario: "输入 x 时崩溃" }],
    };
    const claude = fakeClaudes(repo, { "deepseek/deepseek-v4.1-flash": { structured: reject } });
    writeReviewers(repo, { reviewers: [FLASH, SONNET] });

    const review = repo.cli("review", "--branch", name);
    assert.equal(review.status, 1);
    assert.match(review.stderr, /评审结论: reject/);
    assert.equal(claude.calls().length, 1);
  });

  test("输出不符合结构按失败处理，换下一个", () => {
    const repo = setup();
    const { name } = readyBranch(repo);
    const claude = fakeClaudes(repo, { "deepseek/deepseek-v4.1-flash": { structured: { verdict: "maybe", findings: [] } } });
    writeReviewers(repo, { reviewers: [FLASH, SONNET] });
    const review = repo.cli("review", "--branch", name);
    assert.equal(review.status, 0, review.stderr);
    assert.equal(claude.calls().length, 2);
    assert.match(review.stderr, /由备选 sonnet 完成/);
  });

  test("跳过的评审者不启动进程；全部不可用时逐条列出原因，错误里没有 key", () => {
    const repo = setup();
    const { name } = readyBranch(repo);
    const claude = fakeClaudes(repo, { "*": { mode: "fail", message: `denied ${KEY}` } });
    writeReviewers(repo, { reviewers: [{ ...FLASH, apiKey: undefined }, FLASH, SONNET] .map((item, index) => (index === 1 ? { ...item, name: "flash2" } : item)) });

    const review = repo.cli("review", "--branch", name);
    assert.equal(review.status, 1);
    assert.match(review.stderr, /没有评审者给出结论/);
    assert.match(review.stderr, /- flash: 跳过，写了 baseUrl 但没有 apiKey/);
    assert.match(review.stderr, /- flash2: 失败/);
    assert.match(review.stderr, /- sonnet: 失败/);
    assert.match(review.stderr, /harness reviewer list/);
    // 第一个只是跳过，没有启动进程。
    assert.deepEqual(claude.calls().map((call) => call.model), ["deepseek/deepseek-v4.1-flash", "sonnet"]);
    assert.doesNotMatch(review.stdout + review.stderr, /SECRET/);
  });

  test("超时的评审者被终止并换下一个，原因里写明超时分钟数", () => {
    const repo = setup();
    const { name, oid } = readyBranch(repo);
    const claude = fakeClaudes(repo);
    // exec 让 sleep 取代 shell 本身，超时终止时不会留下占着管道的子进程。
    writeReviewers(repo, { reviewers: [{ name: "slow", client: "command", command: ["sh", "-c", "exec sleep 30"], timeoutMinutes: 0.005 }, SONNET] });
    const started = Date.now();
    const review = repo.cli("review", "--branch", name);
    assert.equal(review.status, 0, review.stderr);
    assert.ok(Date.now() - started < 20_000, "超时后应当很快换下一个");
    assert.match(review.stderr, /slow 失败，换下一个: 评审进程超过 0\.005 分钟没有结束/);
    assert.deepEqual(claude.calls().map((call) => call.model), ["sonnet"]);
    const record = readReviewRecord(repo, oid);
    assert.equal(record.attempts[0].outcome, "failed");
    assert.match(record.attempts[0].reason, /超过 0\.005 分钟/);
  });

  test("本机文件不合法时报错，不退回项目旧字段", () => {
    const repo = setup();
    const { name } = readyBranch(repo);
    const claude = fakeClaudes(repo);
    writeReviewers(repo, { reviewers: [{ ...SONNET, effort: "ultra" }] });
    const review = repo.cli("review", "--branch", name);
    assert.equal(review.status, 1);
    assert.match(review.stderr, /effort 必须是/);
    assert.equal(claude.calls().length, 0);

    writeFileSync(repo.env.HARNESS_REVIEWERS_FILE, "{ broken");
    const broken = repo.cli("review", "--branch", name);
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /不是合法的 JSON/);
    assert.equal(claude.calls().length, 0);
  });
});

describe("评审者的环境与参数", () => {
  test("指定了端点的评审者：清掉继承的 ANTHROPIC_*，key 只走环境变量，推理强度与重试次数传下去", () => {
    const repo = setup();
    const { name, oid } = readyBranch(repo);
    const claude = fakeClaudes(repo);
    repo.env.ANTHROPIC_BASE_URL = "http://inherited.invalid";
    repo.env.ANTHROPIC_AUTH_TOKEN = "inherited-token";
    repo.env.ANTHROPIC_MODEL = "inherited-model";
    repo.env.CLAUDE_EFFORT = "low";
    writeReviewers(repo, { reviewers: [FLASH] });

    const review = repo.cli("review", "--branch", name);
    assert.equal(review.status, 0, review.stderr);
    const [call] = claude.calls();
    assert.deepEqual(Object.keys(call.env).filter((key) => key.startsWith("ANTHROPIC_")), []);
    assert.equal(call.env.HARNESS_REVIEW_API_KEY, KEY);
    assert.equal(call.env.CLAUDE_CODE_MAX_RETRIES, "2");
    assert.equal(call.args[call.args.indexOf("--effort") + 1], "high");
    assert.ok(!call.args.includes("--max-budget-usd"), "没配预算就不传");
    // settings 里有端点和读 key 的命令，但没有 key 本身；key 也不在命令行参数里。
    const settings = JSON.parse(call.settings);
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://llm.example.test");
    assert.match(settings.apiKeyHelper, /HARNESS_REVIEW_API_KEY/);
    assert.ok(!call.settings.includes(KEY));
    assert.ok(!call.args.join(" ").includes(KEY));
    // 记录里有端点主机，没有 key。
    const record = readReviewRecord(repo, oid);
    assert.equal(record.reviewer.endpointHost, "llm.example.test");
    assert.equal(record.reviewer.endpointFrom, "reviewer");
    assert.equal(record.reviewer.effort, "high");
    assert.equal(record.reviewer.requestedModel, "deepseek/deepseek-v4.1-flash");
    assert.ok(!JSON.stringify(record).includes(KEY));
    assert.ok(!readFileSync(join(repo.env.HARNESS_DATA_DIR, "ledger.jsonl"), "utf8").includes(KEY));
    assert.ok(!review.stdout.includes(KEY) && !review.stderr.includes(KEY));
  });

  test("没有指定端点的评审者继承当前环境，不生成评审者 settings", () => {
    const repo = setup();
    const { name, oid } = readyBranch(repo);
    const claude = fakeClaudes(repo);
    repo.env.ANTHROPIC_BASE_URL = "http://gateway.example.test:8080/path";
    writeReviewers(repo, { reviewers: [SONNET] });
    assert.equal(repo.cli("review", "--branch", name).status, 0);
    const [call] = claude.calls();
    assert.equal(call.env.ANTHROPIC_BASE_URL, "http://gateway.example.test:8080/path");
    assert.ok(!call.settings || !call.settings.includes("apiKeyHelper"));
    assert.ok(!("HARNESS_REVIEW_API_KEY" in call.env));
    const record = readReviewRecord(repo, oid);
    assert.equal(record.reviewer.endpointHost, "gateway.example.test:8080");
    assert.equal(record.reviewer.endpointFrom, "environment");
  });

  test("配了预算才传 --max-budget-usd，超出预算时点名评审者和调整办法", () => {
    const repo = setup();
    const { name } = readyBranch(repo);
    const claude = fakeClaudes(repo);
    writeReviewers(repo, { reviewers: [{ ...SONNET, maxBudgetUsd: 3 }] });
    assert.equal(repo.cli("review", "--branch", name).status, 0);
    const [call] = claude.calls();
    assert.equal(call.args[call.args.indexOf("--max-budget-usd") + 1], "3");

    const budget = setup();
    const branch = readyBranch(budget);
    fakeClaudes(budget, { "*": { mode: "fail" } });
    const script = join(budget.root, "..", "fake-claude-multi.mjs");
    writeFileSync(
      script,
      `#!/usr/bin/env node\nimport { readFileSync } from "node:fs";\nreadFileSync(0);\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ is_error: true, subtype: "error_max_budget_usd", total_cost_usd: 3.2 }))});\nprocess.exit(1);\n`,
    );
    chmodSync(script, 0o755);
    writeReviewers(budget, { reviewers: [{ ...SONNET, maxBudgetUsd: 3 }] });
    const over = budget.cli("review", "--branch", branch.name);
    assert.equal(over.status, 1);
    assert.match(over.stderr, /评审者 sonnet 的 maxBudgetUsd（3 美元，本次已花 3\.2）/);
    assert.match(over.stderr, /harness reviewer set sonnet --max-budget-usd/);
  });

  test("codex 评审者：模型用 --model，推理强度用 -c model_reasoning_effort", () => {
    const repo = setup();
    const { name } = readyBranch(repo);
    const log = fakeCodex(repo, APPROVE);
    writeReviewers(repo, { reviewers: [{ name: "codex", client: "codex", model: "gpt-x", effort: "xhigh" }] });
    const review = repo.cli("review", "--branch", name);
    assert.equal(review.status, 0, review.stderr);
    const call = JSON.parse(readFileSync(log, "utf8"));
    assert.equal(call.args[call.args.indexOf("--model") + 1], "gpt-x");
    const at = call.args.indexOf("-c");
    assert.equal(call.args[at + 1], 'model_reasoning_effort="xhigh"');
  });

  test("codex 评审者写了 baseUrl 在读取时就报错", () => {
    const repo = setup();
    const { name } = readyBranch(repo);
    fakeCodex(repo, APPROVE);
    writeReviewers(repo, { reviewers: [{ name: "codex", client: "codex", baseUrl: "https://x.test" }] });
    const review = repo.cli("review", "--branch", name);
    assert.equal(review.status, 1);
    assert.match(review.stderr, /baseUrl 目前只对 claude 客户端有效/);
  });

  test("command 评审者通过环境变量拿到推理强度与模型", () => {
    const repo = setup();
    const { name } = readyBranch(repo);
    const out = join(repo.root, "..", "env-seen.txt");
    const script = `cat >/dev/null; printf '%s|%s' "$HARNESS_REVIEW_EFFORT" "$HARNESS_REVIEW_MODEL" > "$0"; printf '%s' '${JSON.stringify(APPROVE)}'`;
    writeReviewers(repo, { reviewers: [{ name: "mine", client: "command", model: "my-model", effort: "medium", command: ["sh", "-c", script, out] }] });
    const review = repo.cli("review", "--branch", name);
    assert.equal(review.status, 0, review.stderr);
    assert.equal(readFileSync(out, "utf8"), "medium|my-model");
  });
});

describe("优先使用与会话不同的模型", () => {
  function sessionHome(repo, model) {
    const home = tempDir();
    const dir = join(home, ".claude", "projects", "-proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sess-9.jsonl"), `${JSON.stringify({ type: "assistant", message: { model, content: [] } })}\n`);
    repo.env.HOME = home;
    repo.env.CLAUDE_CODE_SESSION_ID = "sess-9";
  }
  const OPUS = { name: "opus", client: "claude", model: "anthropic/claude-opus-5.5" };

  test("与会话同模型的评审者后移，记录里写明会话模型与前后顺序", () => {
    const repo = setup();
    const { name, oid } = readyBranch(repo);
    const claude = fakeClaudes(repo);
    sessionHome(repo, "claude-opus-5-5");
    writeReviewers(repo, { reviewers: [OPUS, SONNET] });

    const review = repo.cli("review", "--branch", name);
    assert.equal(review.status, 0, review.stderr);
    assert.deepEqual(claude.calls().map((call) => call.model), ["sonnet"]);
    assert.match(review.stderr, /与会话模型 claude-opus-5-5 相同的排到了后面/);
    const record = readReviewRecord(repo, oid);
    assert.equal(record.reviewerSelection.sessionModel, "claude-opus-5-5");
    assert.equal(record.reviewerSelection.reordered, true);
    assert.deepEqual(record.reviewerSelection.configuredOrder, ["opus", "sonnet"]);
    assert.deepEqual(record.reviewerSelection.order, ["sonnet", "opus"]);
  });

  test("只有同模型的评审者时仍然使用它，作为最后的备选", () => {
    const repo = setup();
    const { name } = readyBranch(repo);
    const claude = fakeClaudes(repo);
    sessionHome(repo, "claude-opus-5-5");
    writeReviewers(repo, { reviewers: [OPUS] });
    assert.equal(repo.cli("review", "--branch", name).status, 0);
    assert.deepEqual(claude.calls().map((call) => call.model), ["anthropic/claude-opus-5.5"]);
  });

  test("关闭开关或识别不出会话模型时按文件里的顺序", () => {
    const off = setup();
    const a = readyBranch(off);
    const offClaude = fakeClaudes(off);
    sessionHome(off, "claude-opus-5-5");
    writeReviewers(off, { preferDifferentModel: false, reviewers: [OPUS, SONNET] });
    assert.equal(off.cli("review", "--branch", a.name).status, 0);
    assert.deepEqual(offClaude.calls().map((call) => call.model), ["anthropic/claude-opus-5.5"]);

    const unknown = setup();
    const b = readyBranch(unknown);
    const unknownClaude = fakeClaudes(unknown);
    writeReviewers(unknown, { reviewers: [OPUS, SONNET] });
    const review = unknown.cli("review", "--branch", b.name);
    assert.equal(review.status, 0, review.stderr);
    assert.deepEqual(unknownClaude.calls().map((call) => call.model), ["anthropic/claude-opus-5.5"]);
    assert.match(review.stderr, /会话模型未知/);
    assert.equal(readReviewRecord(unknown, git(unknown.root, "rev-parse", b.name)).reviewerSelection.sessionModel, null);
  });
});

describe("没有本机文件", () => {
  test("按项目旧字段运行，记录写明来源是项目配置；旧字段没配预算时不传预算", () => {
    const noBudget = { ...CONFIG, review: { model: "sonnet", blockSeverities: ["high", "critical"] } };
    const repo = setup({ project: { ".harness/config.json": noBudget } });
    const { name, oid } = readyBranch(repo);
    const claude = fakeClaudes(repo);
    const review = repo.cli("review", "--branch", name);
    assert.equal(review.status, 0, review.stderr);
    const [call] = claude.calls();
    assert.ok(!call.args.includes("--max-budget-usd"));
    assert.ok(!("CLAUDE_CODE_MAX_RETRIES" in call.env) || call.env.CLAUDE_CODE_MAX_RETRIES === process.env.CLAUDE_CODE_MAX_RETRIES);
    const record = readReviewRecord(repo, oid);
    assert.equal(record.reviewer.source, "project");
    assert.equal(record.reviewer.name, "claude");
    assert.equal(record.reviewerSelection.source, "project");
  });

  test("旧字段配了预算照旧传", () => {
    const repo = setup();
    const { name } = readyBranch(repo);
    const claude = fakeClaudes(repo);
    assert.equal(repo.cli("review", "--branch", name).status, 0);
    const [call] = claude.calls();
    assert.equal(call.args[call.args.indexOf("--max-budget-usd") + 1], "1");
  });
});

// harness reviewer 不依赖仓库，直接用源码里的入口运行；key 经标准输入传入。
function reviewerCli(repo, args, input) {
  return sh(repo.root, process.execPath, [join(PACKAGE_ROOT, "bin", "harness.mjs"), "reviewer", ...args], repo.env, input);
}
const fileOf = (repo) => repo.env.HARNESS_REVIEWERS_FILE;
const readFile = (repo) => JSON.parse(readFileSync(fileOf(repo), "utf8"));

describe("harness reviewer 命令", () => {
  test("set 新增评审者：key 从标准输入读，文件权限 600，输出和 list 里 key 只露末 4 位", () => {
    const repo = setup();
    const created = reviewerCli(
      repo,
      ["set", "flash", "--client", "claude", "--model", "deepseek/deepseek-v4.1-flash", "--base-url", "https://llm.example.test", "--api-key-stdin", "--effort", "high", "--timeout-minutes", "30"],
      `${KEY}\n`,
    );
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /已新增评审者 flash/);
    assert.doesNotMatch(created.stdout + created.stderr, /sk-test-0123456789abcdef-SECRET/);
    assert.equal(statSync(fileOf(repo)).mode & 0o777, 0o600);
    assert.deepEqual(readFile(repo).reviewers[0], {
      name: "flash",
      client: "claude",
      model: "deepseek/deepseek-v4.1-flash",
      baseUrl: "https://llm.example.test",
      apiKey: KEY,
      effort: "high",
      timeoutMinutes: 30,
    });

    const listed = reviewerCli(repo, ["list"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /1\. flash\s+claude，deepseek\/deepseek-v4\.1-flash，effort high，端点 llm\.example\.test，key \*\*\*\*CRET，超时 30 分钟/);
    assert.doesNotMatch(listed.stdout, /sk-test-0123456789abcdef-SECRET/);
  });

  test("新评审者必须指明 --client；非法取值被拒绝且文件原样不动", () => {
    const repo = setup();
    const missing = reviewerCli(repo, ["set", "x", "--model", "m"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /必须用 --client/);
    assert.equal(existsSync(fileOf(repo)), false);

    assert.equal(reviewerCli(repo, ["set", "sonnet", "--client", "claude", "--model", "sonnet"]).status, 0);
    const before = readFileSync(fileOf(repo), "utf8");
    const bad = reviewerCli(repo, ["set", "sonnet", "--effort", "ultra"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /effort 必须是/);
    assert.equal(readFileSync(fileOf(repo), "utf8"), before);
  });

  test("修改已有评审者只改给出的字段，--clear 清字段，--first 调到最前", () => {
    const repo = setup();
    reviewerCli(repo, ["set", "flash", "--client", "claude", "--model", "m1", "--effort", "low"]);
    reviewerCli(repo, ["set", "sonnet", "--client", "claude", "--model", "sonnet"]);
    reviewerCli(repo, ["set", "flash", "--model", "m2"]);
    assert.deepEqual(readFile(repo).reviewers.map((item) => [item.name, item.model, item.effort]), [["flash", "m2", "low"], ["sonnet", "sonnet", undefined]]);

    reviewerCli(repo, ["set", "flash", "--clear", "effort"]);
    assert.equal(readFile(repo).reviewers[0].effort, undefined);
    assert.match(reviewerCli(repo, ["set", "flash", "--clear", "client"]).stderr, /--clear 只能清/);

    reviewerCli(repo, ["set", "sonnet", "--first"]);
    assert.deepEqual(readFile(repo).reviewers.map((item) => item.name), ["sonnet", "flash"]);
  });

  test("remove 删除评审者，删掉最后一个时移除文件，回到项目旧字段", () => {
    const repo = setup();
    reviewerCli(repo, ["set", "a", "--client", "claude", "--model", "m"]);
    reviewerCli(repo, ["set", "b", "--client", "codex"]);
    assert.match(reviewerCli(repo, ["remove", "nope"]).stderr, /没有评审者 nope/);
    assert.match(reviewerCli(repo, ["remove", "a"]).stdout, /还剩 b/);
    const last = reviewerCli(repo, ["remove", "b"]);
    assert.equal(last.status, 0);
    assert.match(last.stdout, /本机文件已移除/);
    assert.equal(existsSync(fileOf(repo)), false);
  });

  test("prefer 切换优先使用不同模型的开关，没有文件时提示先新增", () => {
    const repo = setup();
    assert.match(reviewerCli(repo, ["prefer", "off"]).stderr, /先用 harness reviewer set/);
    reviewerCli(repo, ["set", "a", "--client", "claude", "--model", "m"]);
    assert.equal(reviewerCli(repo, ["prefer", "off"]).status, 0);
    assert.equal(readFile(repo).preferDifferentModel, false);
    assert.match(reviewerCli(repo, ["list"]).stdout, /优先使用与会话模型不同的评审者: 关/);
    reviewerCli(repo, ["prefer", "on"]);
    assert.equal(readFile(repo).preferDifferentModel, true);
    assert.match(reviewerCli(repo, ["prefer", "maybe"]).stderr, /on 或 off/);
  });

  test("没有本机文件时 list 说明当前按旧字段运行，并给出配置示例", () => {
    const repo = setup();
    fakeClaudes(repo);
    const listed = reviewerCli(repo, ["list"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /（不存在）/);
    assert.match(listed.stdout, /当前按项目配置里的旧字段运行/);
    assert.match(listed.stdout, /harness reviewer set flash --client claude/);
  });

  test("list 标出不可用的评审者和原因；全部不可用时退出码为 1", () => {
    const repo = setup();
    writeReviewers(repo, { reviewers: [{ ...FLASH, apiKey: undefined }] });
    const listed = reviewerCli(repo, ["list"]);
    assert.equal(listed.status, 1);
    assert.match(listed.stdout, /\[不可用: 写了 baseUrl 但没有 apiKey/);
    assert.match(listed.stdout, /没有可用的评审者/);
  });

  test("test 实际跑一次：可用时报耗时和实际模型，不可用时给出原因且不带 key", () => {
    const repo = setup();
    const claude = fakeClaudes(repo, { "deepseek/deepseek-v4.1-flash": { actual: "DeepSeek-V4.1-Flash" } });
    writeReviewers(repo, { reviewers: [FLASH, { ...SONNET, name: "broken" }] });
    const ok = reviewerCli(repo, ["test", "flash"]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /可用。耗时 .* 秒，实际模型 DeepSeek-V4\.1-Flash/);
    assert.equal(claude.calls().length, 1);
    assert.doesNotMatch(ok.stdout + ok.stderr, /sk-test-0123456789abcdef-SECRET/);

    fakeClaudes(repo, { "*": { mode: "fail", message: `401 ${KEY}` } });
    const bad = reviewerCli(repo, ["test", "broken"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /不可用: .*401/);
    assert.match(reviewerCli(repo, ["test", "nope"]).stderr, /没有评审者 nope/);
  });
});

describe("评审者的显示", () => {
  test("doctor 列出本机评审者；全部不可用时失败；项目里的旧字段提示可删", () => {
    const repo = setup();
    fakeClaudes(repo);
    writeReviewers(repo, { reviewers: [{ ...FLASH, apiKey: undefined }, SONNET] });
    const ok = repo.cli("doctor");
    assert.match(ok.stdout, /\[ok\] review: 独立评审者（本机文件）: flash\(.*\)\[不可用\] -> sonnet\(sonnet\)/);
    assert.match(ok.stdout, /不可用 flash: 写了 baseUrl 但没有 apiKey/);
    assert.match(ok.stdout, /review:legacy: 项目配置的 review\.model、maxBudgetUsd 已被本机评审者文件取代/);

    writeReviewers(repo, { reviewers: [{ ...FLASH, apiKey: undefined }] });
    const none = repo.cli("doctor");
    assert.notEqual(none.status, 0);
    assert.match(none.stdout, /\[!!\] review: 本机评审者全部不可用/);

    writeFileSync(fileOf(repo), "{ broken");
    assert.match(repo.cli("doctor").stdout, /\[!!\] review: .*不是合法的 JSON/);
  });

  test("doctor 在没有本机文件时提示可以用 harness reviewer 配置", () => {
    const repo = setup();
    fakeClaudes(repo);
    const report = repo.cli("doctor");
    assert.match(report.stdout, /review:config: 没有本机评审者文件.*harness reviewer set/);
  });

  test("status 写出评审者与模型，旧记录显示未记录", () => {
    const repo = setup();
    const { name } = readyBranch(repo);
    fakeClaudes(repo);
    writeReviewers(repo, { reviewers: [{ ...SONNET, effort: "high" }] });
    assert.equal(repo.cli("review", "--branch", name).status, 0);
    assert.match(repo.cli("status", "--branch", name).stdout, /评审通过（.*评审者 sonnet \/ sonnet \/ effort high）/);

    assert.equal(reviewerSummary({ verdict: "approve" }), "未记录");
    assert.deepEqual(reviewerLines({ verdict: "approve" }), ["  评审者: 未记录"]);
  });

  test("摘要与明细标出备选完成、实际模型与请求模型不同、端点来自环境变量", () => {
    const record = {
      reviewer: { name: "sonnet", client: "claude", requestedModel: "sonnet", actualModels: ["anthropic/claude-sonnet-5.5"], effort: "high", endpointHost: "gw.test", endpointFrom: "environment", durationMs: 12_345 },
      attempts: [{ name: "flash", outcome: "failed", reason: "401\n多行" }, { name: "sonnet", outcome: "done" }],
      reviewerSelection: { reordered: true, sessionModel: "claude-opus-5-5", order: ["flash", "sonnet", "opus"] },
    };
    assert.equal(reviewerSummary(record), "sonnet / sonnet（实际 anthropic/claude-sonnet-5.5） / effort high，由备选完成");
    const lines = reviewerLines(record).join("\n");
    assert.match(lines, /评审者: sonnet（claude，模型 sonnet（实际 anthropic\/claude-sonnet-5\.5），effort high，端点 gw\.test（来自环境变量）），耗时 12\.3 秒/);
    assert.match(lines, /由备选 sonnet 完成/);
    assert.match(lines, /flash: 失败，401$/m);
    assert.match(lines, /顺序已按会话模型 claude-opus-5-5 调整: flash -> sonnet -> opus/);
  });

  test("init 不再往项目配置写评审者相关的旧字段，结束时说明怎样配置本机评审者", () => {
    const fresh = makeRepo({ install: false, project: { ".harness/config.json": null, ".harness/policy.json": null, ".harness/verify.json": null } });
    repos.push(fresh);
    const init = fresh.rawCli("init");
    assert.equal(init.status, 0, init.stderr);
    const generated = JSON.parse(readFileSync(join(fresh.root, ".harness/config.json"), "utf8"));
    assert.deepEqual(Object.keys(generated.review).sort(), ["blockSeverities", "maxDiffChars"]);
    assert.match(init.stdout, /评审者: 本机还没有 .*reviewers\.json/);
    assert.match(init.stdout, /harness reviewer set <名称> --client claude --model <模型>/);

    writeReviewers(fresh, { reviewers: [SONNET] });
    const again = fresh.rawCli("init");
    assert.match(again.stdout, /评审者: 本机文件 .* 里配了 1 个：sonnet\(sonnet\)/);
  });
});
