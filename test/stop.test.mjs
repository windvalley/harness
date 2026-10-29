import { strict as assert } from "node:assert";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { APPROVE, CONFIG, commit, fakeReviewer, git, makeRepo, sh, write, writeReview } from "./helpers.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

function setup(opts = {}) {
  const repo = makeRepo(opts);
  repos.push(repo);
  return repo;
}

const SESSION = "session-1";
const BRANCH = "task/a";

/** 任务 Worktree 建在主 Worktree 旁边；会话停在主 Worktree，用绝对路径去那里干活，和真实使用一致。 */
function linkedTask(repo, branch = BRANCH) {
  const dir = join(realpathSync(repo.root), "..", branch.replace(/\//g, "-"));
  git(repo.root, "worktree", "add", "-q", "-b", branch, dir, "main");
  return dir;
}

function hook(repo, client, args, payload) {
  return sh(repo.root, join(repo.root, ".harness/bin/harness"), ["hook", "--client", client, ...args], repo.env, JSON.stringify(payload));
}

/** 客户端在 PreToolUse 上调用门禁，载荷带会话标识。 */
function toolCall(repo, call, { client = "claude", session = SESSION } = {}) {
  const payload = { session_id: session, cwd: repo.root, hook_event_name: "PreToolUse", ...call };
  const result = hook(repo, client, [], payload);
  assert.equal(result.status === 0 || client === "codex", true, result.stderr);
  return result;
}

const writeCall = (path, content = "x\n") => ({ tool_name: "Write", tool_input: { file_path: path, content } });
const bashCall = (command) => ({ tool_name: "Bash", tool_input: { command } });

/** 客户端在 Stop 上调用收尾检查，返回解析后的输出（放行时为 null）。 */
function stop(repo, { client = "claude", session = SESSION, active = false } = {}) {
  const payload = { session_id: session, cwd: repo.root, hook_event_name: "Stop", stop_hook_active: active, transcript_path: null };
  const result = hook(repo, client, ["--event", "stop"], payload);
  assert.equal(result.status, 0, result.stderr);
  const text = result.stdout.trim();
  return text ? JSON.parse(text) : null;
}

/** 在任务 Worktree 里写文件并提交，经过门禁的方式与 Agent 相同。 */
function agentCommit(repo, dir, files, message = "feat(demo): 调整示例\n\n- 增加示例文件\n- 补充对应说明") {
  for (const [rel, content] of Object.entries(files)) {
    toolCall(repo, writeCall(join(dir, rel), content));
    write(dir, rel, content);
  }
  toolCall(repo, bashCall(`cd ${dir} && git add -A && git commit -m "${message.split("\n")[0]}"`));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

function ledger(repo) {
  const file = join(repo.env.HARNESS_DATA_DIR, "ledger.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

describe("收尾检查", () => {
  test("会话推进过的任务没交付就结束时被拦下，按缺的步骤给出下一条命令，合并后放行", () => {
    const repo = setup();
    const dir = linkedTask(repo);
    agentCommit(repo, dir, { "src/a.js": "export const a = 1;\n" });

    const first = stop(repo);
    assert.equal(first?.decision, "block", "实现提交后就结束，被拦下");
    assert.match(first.reason, /task\/a：还差 缺验证证据、缺独立评审；下一步 harness verify --branch task\/a/);
    assert.match(first.reason, /轮次长短、耗时与上下文大小都不是停下的理由/);
    assert.match(first.reason, /harness escalate open/);

    toolCall(repo, bashCall(`.harness/bin/harness verify --branch ${BRANCH}`));
    assert.equal(repo.cli("verify", "--branch", BRANCH).status, 0);
    const second = stop(repo, { active: true });
    assert.equal(second?.decision, "block", "有进展但还没评审，继续拦");
    assert.match(second.reason, /下一步 harness review --branch task\/a/);

    writeReview(repo, git(repo.root, "rev-parse", BRANCH), "approve");
    const third = stop(repo, { active: true });
    assert.equal(third?.decision, "block", "门禁齐备但没合并");
    assert.match(third.reason, /门禁已经齐备，还没有合并；下一步 harness merge --branch task\/a/);

    assert.equal(repo.cli("merge", "--branch", BRANCH).status, 0);
    assert.equal(stop(repo, { active: true }), null, "合并后放行");
  });

  test("两次结束之间没有进展时放行，账本记一次未上报的结束，status 与 merge 都会提示", () => {
    const repo = setup();
    const dir = linkedTask(repo);
    const head = agentCommit(repo, dir, { "src/a.js": "export const a = 1;\n" });
    assert.equal(stop(repo)?.decision, "block");
    assert.equal(stop(repo, { active: true }), null, "同一状态只拦一次");
    const unresolved = ledger(repo).filter((event) => event.event === "stop.unresolved");
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].branch, BRANCH);
    assert.equal(unresolved[0].head, head);
    assert.equal(stop(repo, { active: true }), null);
    assert.equal(ledger(repo).filter((event) => event.event === "stop.unresolved").length, 1, "同一状态不重复记账");

    const status = repo.cli("status", "--branch", BRANCH);
    assert.match(status.stdout, /\[!!\] stop: 有会话在 .+ 没有上报阻塞就结束了（当时还差 缺验证证据、缺独立评审）/);

    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("verify", "--branch", BRANCH).status, 0);
    assert.equal(repo.cli("review", "--branch", BRANCH).status, 0);
    const merged = repo.cli("merge", "--branch", BRANCH);
    assert.equal(merged.status, 0, merged.stderr);
    assert.match(merged.stderr, /没有上报阻塞就结束了/);
  });

  test("只改文件没提交也算进展；新分支上改了文件就结束，按未提交拦下", () => {
    const repo = setup();
    const dir = linkedTask(repo);
    toolCall(repo, writeCall(join(dir, "src/a.js")));
    write(dir, "src/a.js", "export const a = 1;\n");
    const first = stop(repo);
    assert.equal(first?.decision, "block");
    assert.match(first.reason, /任务 Worktree 里有 1 个文件没有提交/);

    write(dir, "src/a.js", "export const a = 2;\n");
    assert.equal(stop(repo, { active: true })?.decision, "block", "内容变了算进展，再拦一次");
    assert.equal(stop(repo, { active: true }), null, "之后没有进展，放行");
  });

  test("只做分析的会话、其他会话、未经手的任务分支都不受影响", () => {
    const repo = setup();
    const dir = linkedTask(repo);
    agentCommit(repo, dir, { "src/a.js": "export const a = 1;\n" }, undefined);
    repo.branch("task/other", { "src/b.js": "b\n" });

    // 只读的 status、verify --plan 与引号里提到的命令都不算推进交付。
    const reader = "session-reader";
    toolCall(repo, bashCall(`.harness/bin/harness status --branch task/other`), { session: reader });
    toolCall(repo, bashCall(`.harness/bin/harness verify --plan --branch task/other`), { session: reader });
    toolCall(repo, bashCall(`echo "下一步 harness review --branch task/other"`), { session: reader });
    toolCall(repo, { tool_name: "Read", tool_input: { file_path: join(dir, "src/a.js") } }, { session: reader });
    assert.equal(stop(repo, { session: reader }), null);
    assert.equal(stop(repo, { session: "session-unknown" }), null, "没有任何记录的会话放行");

    const own = stop(repo);
    assert.equal(own?.decision, "block");
    assert.doesNotMatch(own.reason, /task\/other/, "只列本会话经手的分支");
  });

  test("提交说明里提到 harness 命令不算推进交付，cd 到任务 Worktree 里提交才算", () => {
    const repo = setup();
    const dir = linkedTask(repo);
    const session = "session-commit";
    toolCall(repo, bashCall(`git commit -m "docs: 说明 harness merge --branch task/zzz 的用法"`), { session });
    assert.equal(stop(repo, { session }), null, "主 Worktree 上的提交与引号里的命令都不记");
    write(dir, "src/a.js", "a\n");
    git(dir, "add", "-A");
    toolCall(repo, bashCall(`cd ${dir} && git commit -m "feat: 示例"`), { session });
    git(dir, "commit", "-q", "-m", "feat(demo): 示例\n\n- 新增文件\n- 补充说明");
    assert.equal(stop(repo, { session })?.decision, "block");
  });

  test("只差人工确认门禁改动时放行；上报阻塞后放行，之后又有提交时重新核对", () => {
    const repo = setup();
    const dir = linkedTask(repo);
    const policy = { version: 1, presets: ["secrets"], disabled: [], rules: [] };
    agentCommit(repo, dir, { ".harness/policy.json": `${JSON.stringify(policy, null, 2)}\n`, "src/a.js": "a\n" });
    assert.equal(repo.cli("verify", "--branch", BRANCH).status, 0);
    writeReview(repo, git(repo.root, "rev-parse", BRANCH), "approve");
    assert.match(repo.cli("status", "--branch", BRANCH).stdout, /门禁改动待确认/);
    assert.equal(stop(repo), null, "剩下的是人工确认，放行");

    const escalated = linkedTask(repo, "task/b");
    agentCommit(repo, escalated, { "src/b.js": "b\n" });
    assert.equal(stop(repo)?.decision, "block");
    const opened = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["escalate", "open"], repo.env, JSON.stringify({
      situation: "评审后端不可用",
      attempted: "重试三次",
      blocker: "评审进程报错",
      options: [{ id: "a", summary: "等恢复后重跑" }, { id: "b", summary: "改用 codex 后端" }],
      defaultAction: "a",
      context: { branch: "task/b" },
    }));
    assert.equal(opened.status, 0, opened.stderr);
    assert.equal(stop(repo, { active: true }), null, "已上报，放行");

    agentCommit(repo, escalated, { "src/b2.js": "b2\n" });
    assert.equal(stop(repo, { active: true })?.decision, "block", "上报之后又提交了，旧上报不再算数");
  });

  test("先方案后实施：只交了方案、等用户同意时放行；记录授权后开始实施就要推进到交付", () => {
    const config = { ...CONFIG, intent: { ...CONFIG.intent, plan: { maxLines: 5 } } };
    const policy = { version: 1, presets: ["secrets", "git-safety", "gate-self", "plan-first"], disabled: [], rules: [] };
    const repo = setup({ project: { ".harness/config.json": config, ".harness/policy.json": policy } });
    const dir = linkedTask(repo, "feat/login");
    agentCommit(repo, dir, { "docs/changes/login/plan.md": "# 实施方案\n", ".harness/acceptance/feat-login.md": "- 登录成功后进入首页\n" }, "docs(login): 交付方案\n\n- 验收清单\n- 实施方案");
    assert.equal(stop(repo), null, "方案交出后停下等授权");

    toolCall(repo, bashCall(`.harness/bin/harness approve --branch feat/login --yes --note "可以，开始实施"`));
    assert.equal(repo.cli("approve", "--branch", "feat/login", "--yes", "--note", "可以，开始实施").status, 0);
    agentCommit(repo, dir, { "src/login.js": "export const login = 1;\n" });
    const blocked = stop(repo);
    assert.equal(blocked?.decision, "block");
    assert.match(blocked.reason, /feat\/login：还差 缺验证证据、缺独立评审/);
  });

  test("远程交付下门禁齐备后提示 submit", () => {
    const config = { ...CONFIG, delivery: { mode: "remote", remote: "origin", provider: "github" } };
    const repo = setup({ project: { ".harness/config.json": config } });
    const dir = linkedTask(repo);
    agentCommit(repo, dir, { "src/a.js": "a\n" });
    assert.equal(repo.cli("verify", "--branch", BRANCH).status, 0);
    writeReview(repo, git(repo.root, "rev-parse", BRANCH), "approve");
    const blocked = stop(repo);
    assert.match(blocked?.reason ?? "", /还没有提交 PR\/MR；下一步 harness submit --branch task\/a/);
  });

  test("Codex 用同样的 Stop 协议：输出 decision 与 reason", () => {
    const repo = setup();
    const dir = linkedTask(repo);
    toolCall(repo, { tool_name: "apply_patch", tool_input: { input: `*** Begin Patch\n*** Add File: ${join(dir, "src/a.js")}\n+a\n*** End Patch\n` } }, { client: "codex", session: "codex-1" });
    write(dir, "src/a.js", "a\n");
    const result = stop(repo, { client: "codex", session: "codex-1" });
    assert.equal(result?.decision, "block");
    assert.match(result.reason, /task\/a/);
    assert.equal(stop(repo, { client: "claude", session: "codex-1" }), null, "按客户端区分会话");
  });

  test("收尾检查出错或输入无效时放行并提示，不把会话困住", () => {
    const repo = setup();
    const bad = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["hook", "--client", "claude", "--event", "stop"], repo.env, "not json");
    assert.equal(bad.status, 0);
    assert.match(JSON.parse(bad.stdout).systemMessage, /本次放行/);
    // 本机没装锁定的版本时，拦截一律拒绝，收尾检查只提示不拦。
    const missing = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["hook", "--client", "claude", "--event", "stop"], { ...repo.env, HARNESS_VERSION: "9.9.9" }, "{}");
    assert.equal(missing.status, 0);
    assert.match(missing.stderr, /没有安装门禁锁定的版本/);
    const guard = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["hook", "--client", "claude"], { ...repo.env, HARNESS_VERSION: "9.9.9" }, "{}");
    assert.equal(guard.status, 2);
  });
});

describe("收尾检查的接入", () => {
  test("install 为 Claude Code 与 Codex 写入 Stop 钩子，保留其他工具的 Stop 钩子，uninstall 只摘掉 harness 的", () => {
    const repo = setup();
    const settings = join(repo.root, ".claude/settings.json");
    const claude = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(claude.hooks.Stop.length, 1);
    assert.match(claude.hooks.Stop[0].hooks[0].command, /\.harness\/bin\/harness" hook --client claude --event stop$/);
    const codex = JSON.parse(readFileSync(join(repo.root, ".codex/hooks.json"), "utf8"));
    assert.match(codex.hooks.Stop[0].hooks[0].command, /hook --client codex --event stop$/);

    claude.hooks.Stop.unshift({ hooks: [{ type: "command", command: "say done" }] });
    writeFileSync(settings, `${JSON.stringify(claude, null, 2)}\n`);
    assert.equal(repo.rawCli("install", "--take-over").status, 0);
    const reinstalled = JSON.parse(readFileSync(settings, "utf8"));
    assert.deepEqual(reinstalled.hooks.Stop.map((entry) => entry.hooks[0].command.includes("--event stop")), [false, true], "其他工具的 Stop 钩子保留，harness 只有一份");

    assert.equal(repo.cli("uninstall").status, 0);
    const after = JSON.parse(readFileSync(settings, "utf8"));
    assert.deepEqual(after.hooks.Stop.map((entry) => entry.hooks[0].command), ["say done"]);
    assert.equal(after.hooks.PreToolUse, undefined);
  });

  test("doctor 报告 Stop 钩子没有接入，以及 Codex 的 Stop 钩子没有信任", () => {
    const repo = setup();
    const settings = join(repo.root, ".claude/settings.json");
    const claude = JSON.parse(readFileSync(settings, "utf8"));
    delete claude.hooks.Stop;
    writeFileSync(settings, `${JSON.stringify(claude, null, 2)}\n`);
    const codexConfig = join(repo.env.CODEX_HOME, "config.toml");
    writeFileSync(codexConfig, readFileSync(codexConfig, "utf8").replace(/\n\[hooks\.state\."[^"]+:stop:0:0"\]\ntrusted_hash = "[^"]+"\n/, "\n"));
    const result = repo.cli("doctor");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /client:claude: PreToolUse 已接入；收尾检查（Stop）未接入/);
    assert.match(result.stdout, /client:codex: 拦截钩子已信任，收尾检查（Stop）尚未信任/);
  });

  test("DSH 插件记下会话经手的分支，轮次结束时用 steer 让 Agent 接着做；子代理不做收尾检查", () => {
    const repo = setup();
    const dir = linkedTask(repo);
    write(dir, "src/a.js", "a\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "feat(demo): 示例\n\n- 新增文件\n- 补充说明");
    const plugin = join(repo.root, "..", "dsh-plugin", "index.mjs");
    const host = join(repo.root, "..");
    const script = `
      const plugin = await import(process.argv[1]);
      const cwd = process.argv[2];
      const handlers = {};
      const services = { tools: {}, workingDirectory: { async ensure() { return cwd; } } };
      const ctx = new Proxy({ on(event, handler) { handlers[event] = handler; } }, {
        get(target, key) {
          if (key in target) return target[key];
          if (!plugin.inject.includes(key)) throw new Error("没有声明依赖: " + String(key));
          return services[key];
        },
      });
      plugin.apply(ctx);
      const signal = new AbortController().signal;
      const steered = [];
      const agent = (id, header = {}) => ({ id, session: { header: { id, ...header } }, steer: (message) => steered.push({ id, message }) });
      const main = agent("dsh-main");
      const child = agent("dsh-child", { parentSession: "dsh-main", origin: "subagent", delegationDepth: 1 });
      // 子代理替主会话提交，记在主会话名下。
      await handlers["tools/pre-execute"]({ name: "bash", arguments: { command: "cd " + process.argv[3] + " && git commit -m x" }, agent: child, signal }, async () => ({ kind: "allow" }));
      await handlers["agent/turn-stopping"]({ agent: child, turn: 1, signal });
      await handlers["agent/turn-stopping"]({ agent: main, turn: 1, signal });
      console.log(JSON.stringify(steered));
    `;
    const result = sh(host, process.execPath, ["--input-type=module", "-e", script, pathToFileURL(plugin).href, repo.root, dir], repo.env);
    assert.equal(result.status, 0, result.stderr);
    const steered = JSON.parse(result.stdout);
    assert.equal(steered.length, 1, "只有主会话被要求接着做");
    assert.equal(steered[0].id, "dsh-main");
    const message = steered[0].message;
    assert.equal(message.role, "user");
    assert.deepEqual(message.source, { kind: "plugin", plugin: "harness-guard" });
    assert.match(message.content[0].text, /task\/a：还差 缺验证证据、缺独立评审/);
    assert.match(message.id, /^[0-9a-f-]{36}$/);
  });
});
