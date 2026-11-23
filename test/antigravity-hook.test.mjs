import { strict as assert } from "node:assert";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { antigravity } from "../src/adapters/antigravity.mjs";
import { CONFIG, git, makeRepo, sh, write } from "./helpers.mjs";

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

const SECRET_FILE = `config/server.${"pem"}`;

function event(repo, tool, args = {}, session = "antigravity-session") {
  return { toolCall: { name: tool, args }, conversationId: session, workspacePaths: [repo.root] };
}

function hook(repo, payload, { eventName = "pre-tool-use", env = repo.env } = {}) {
  const args = ["hook", "--client", "antigravity", ...(eventName === "stop" ? ["--event", "stop"] : [])];
  return sh(repo.root, join(repo.root, ".harness/bin/harness"), args, env, typeof payload === "string" ? payload : JSON.stringify(payload));
}

function decision(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim(), "Antigravity 钩子必须输出显式 JSON 判定");
  return JSON.parse(result.stdout);
}

function commands(entries) {
  return (entries ?? []).flatMap((entry) => (entry.hooks ?? [entry]).map((item) => item.command));
}

describe("Antigravity 客户端入口", () => {
  test("PreToolUse 对写、读与 shell 输出协议要求的 allow 或 deny", () => {
    const repo = setup();
    const deniedWrite = decision(hook(repo, event(repo, "write_to_file", { TargetFile: SECRET_FILE, CodeContent: "x" })));
    assert.equal(deniedWrite.decision, "deny");
    assert.match(deniedWrite.reason, /secrets-write|密钥|拦截/);
    assert.equal(decision(hook(repo, event(repo, "write_to_file", { TargetFile: "src/a.js", CodeContent: "a\n" }))).decision, "allow");
    assert.equal(decision(hook(repo, event(repo, "write_to_file", { TargetFile: ".agents/hooks.json", CodeContent: "{}" }))).decision, "deny");
    assert.equal(decision(hook(repo, event(repo, "view_file", { AbsolutePath: SECRET_FILE }))).decision, "deny");
    assert.equal(decision(hook(repo, event(repo, "run_command", { CommandLine: `cat ${SECRET_FILE}`, Cwd: repo.root }))).decision, "deny");
    assert.equal(decision(hook(repo, event(repo, "run_command", { CommandLine: "npm test", Cwd: repo.root }))).decision, "allow");
    assert.equal(decision(hook(repo, event(repo, "search_web", { query: "harness" }))).decision, "allow", "不归门禁处理的工具显式放行");
  });

  test("兼容 Antigravity 2.0 的文件工具名与参数", () => {
    const repo = setup();
    assert.equal(decision(hook(repo, event(repo, "write_file", { Path: SECRET_FILE, Content: "x" }))).decision, "deny");
    assert.equal(decision(hook(repo, event(repo, "write_file", { Path: "src/a.js", Content: "a\n" }))).decision, "allow");
    assert.equal(decision(hook(repo, event(repo, "edit_file", { Path: SECRET_FILE, Replacement: "x" }))).decision, "deny");
    assert.equal(decision(hook(repo, event(repo, "read_file", { Path: SECRET_FILE }))).decision, "deny");
    assert.equal(decision(hook(repo, event(repo, "write_file", { Content: "x" }))).decision, "deny", "新工具缺少 Path 时失败关闭");
  });

  test("文件编辑与搜索工具映射到统一载荷", () => {
    const normalize = (tool, args) => antigravity.normalize({ toolCall: { name: tool, args } }).call;
    assert.deepEqual(normalize("replace_file_content", { TargetFile: "src/a.js", ReplacementContent: "next" }), {
      kind: "write",
      path: "src/a.js",
      content: "next",
    });
    assert.deepEqual(normalize("multi_replace_file_content", {
      TargetFile: "src/a.js",
      ReplacementChunks: [{ ReplacementContent: "one" }, { ReplacementContent: "two" }],
    }), { kind: "write", path: "src/a.js", content: "one\ntwo" });
    assert.deepEqual(normalize("write_file", { Path: "src/a.js", Content: "next" }), { kind: "write", path: "src/a.js", content: "next" });
    assert.deepEqual(normalize("edit_file", { Path: "src/a.js", Replacement: "next" }), { kind: "write", path: "src/a.js", content: "next" });
    assert.deepEqual(normalize("read_file", { Path: "src/a.js" }), { kind: "read", path: "src/a.js" });
    assert.deepEqual(normalize("grep_search", { SearchPath: "src", Includes: "*.js" }), { kind: "search", path: "src", glob: "*.js" });
    assert.deepEqual(normalize("find_by_name", { SearchDirectory: "src", Pattern: "*.test.js" }), { kind: "search", path: "src", glob: "*.test.js" });
    assert.deepEqual(normalize("list_dir", { DirectoryPath: "src" }), { kind: "search", path: "src" });
  });

  test("按目标所在工作区与命令 Cwd 定位项目，会话使用 conversationId", () => {
    const filePayload = {
      toolCall: { name: "write_to_file", args: { TargetFile: "/work/second/src/a.js" } },
      workspacePaths: ["/work/first", "/work/second"],
      conversationId: "conversation-1",
    };
    assert.deepEqual(antigravity.context(filePayload), { cwd: "/work/second", session_id: "conversation-1" });
    assert.deepEqual(antigravity.context({
      ...filePayload,
      toolCall: { name: "read_file", args: { Path: "/work/second/src/a.js" } },
    }), { cwd: "/work/second", session_id: "conversation-1" });
    const commandPayload = {
      toolCall: { name: "run_command", args: { CommandLine: "pwd", Cwd: "subdir" } },
      workspacePaths: ["/work/first"],
    };
    assert.equal(antigravity.context(commandPayload).cwd, "/work/first/subdir");
  });

  test("无效载荷按失败关闭，Stop 输入无效时显式放行结束", () => {
    const repo = setup();
    assert.equal(decision(hook(repo, "not json")).decision, "deny");
    assert.equal(decision(hook(repo, { conversationId: "x", workspacePaths: [repo.root] })).decision, "deny");
    assert.equal(decision(hook(repo, event(repo, "write_to_file", { CodeContent: "x" }))).decision, "deny");
    assert.equal(decision(hook(repo, { toolCall: { name: "run_command", args: { CommandLine: "npm test" } } })).decision, "deny");
    const stopped = decision(hook(repo, "not json", { eventName: "stop" }));
    assert.equal(stopped.decision, "stop");
    assert.match(stopped.reason, /本次放行/);
  });

  test("本机缺锁定版本时实时拦截拒绝，收尾检查只提示并放行", () => {
    const repo = setup();
    const env = { ...repo.env, HARNESS_VERSION: "9.9.9" };
    const denied = decision(hook(repo, event(repo, "run_command", { CommandLine: "npm test" }), { env }));
    assert.equal(denied.decision, "deny");
    assert.match(denied.reason, /没有安装门禁锁定的版本/);
    const stopped = decision(hook(repo, { conversationId: "x", workspacePaths: [repo.root] }, { eventName: "stop", env }));
    assert.equal(stopped.decision, "stop");
    assert.match(stopped.reason, /没有安装门禁锁定的版本/);
  });
});

describe("Antigravity 收尾检查", () => {
  test("同一 conversationId 关联任务分支，欠项返回 continue，达到上限后返回 stop", () => {
    const repo = setup({ project: { ".harness/config.json": { ...CONFIG, stop: { idleBlocks: 1 } } } });
    const dir = join(realpathSync(repo.root), "..", "antigravity-task");
    git(repo.root, "worktree", "add", "-q", "-b", "task/antigravity", dir, "main");
    const allowed = decision(hook(repo, event(repo, "write_to_file", { TargetFile: join(dir, "src/a.js"), CodeContent: "a\n" })));
    assert.equal(allowed.decision, "allow");
    write(dir, "src/a.js", "a\n");

    const stopPayload = { conversationId: "antigravity-session", workspacePaths: [repo.root], fullyIdle: true, terminationReason: "model_stop" };
    const busy = decision(hook(repo, { ...stopPayload, fullyIdle: false }, { eventName: "stop" }));
    assert.equal(busy.decision, "stop", "后台任务尚未结束时不做收尾拦截");
    const continued = decision(hook(repo, stopPayload, { eventName: "stop" }));
    assert.equal(continued.decision, "continue");
    assert.match(continued.reason, /task\/antigravity/);
    assert.match(continued.reason, /没有提交/);
    const released = decision(hook(repo, stopPayload, { eventName: "stop" }));
    assert.equal(released.decision, "stop");
    assert.match(released.reason, /task\/antigravity/);
    assert.equal(decision(hook(repo, { ...stopPayload, conversationId: "other" }, { eventName: "stop" })).decision, "stop");
  });
});

describe("Antigravity 配置生命周期", () => {
  test("install 生成分组钩子，doctor 标明配置已接入", () => {
    const repo = setup();
    const file = join(repo.root, ".agents/hooks.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(config.harness.enabled, true);
    assert.equal(config.harness.Stop.length, 1);
    assert.equal(config.harness.Stop[0].type, "command");
    assert.match(config.harness.Stop[0].command, /hook --client antigravity --event stop$/);
    assert.equal(config.harness.Stop[0].hooks, undefined, "Stop 是扁平处理器数组，不使用 PreToolUse 的嵌套结构");
    const preCommand = commands(config.harness.PreToolUse)[0];
    const stopCommand = commands(config.harness.Stop)[0];
    assert.match(preCommand, /hook --client antigravity$/);
    assert.match(stopCommand, /hook --client antigravity --event stop$/);
    const denied = sh(repo.root, "sh", ["-c", preCommand], repo.env, JSON.stringify(event(repo, "write_to_file", { TargetFile: SECRET_FILE, CodeContent: "x" })));
    assert.equal(decision(denied).decision, "deny", "按生成配置原样执行钩子命令");
    const stopped = sh(repo.root, "sh", ["-c", stopCommand], repo.env, JSON.stringify({ conversationId: "unknown", workspacePaths: [repo.root], fullyIdle: true }));
    assert.equal(decision(stopped).decision, "stop");
    const result = repo.cli("doctor");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[ok\] client:antigravity: PreToolUse 与收尾检查 Stop 配置已接入/);
  });

  test("重装保留其他分组和事件，take-over 只移除其他 PreToolUse，卸载只摘 harness 条目", () => {
    const repo = setup();
    const file = join(repo.root, ".agents/hooks.json");
    const before = JSON.parse(readFileSync(file, "utf8"));
    before.other = {
      enabled: false,
      PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "other-guard" }] }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "other-log" }] }],
      Stop: [{ type: "command", command: "other-stop" }],
    };
    before.harness.Stop.unshift({ type: "command", command: "another-stop" });
    writeFileSync(file, `${JSON.stringify(before, null, 2)}\n`);

    assert.equal(repo.rawCli("install").status, 0);
    const kept = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(commands(kept.other.PreToolUse).includes("other-guard"));
    assert.deepEqual(commands(kept.other.PostToolUse), ["other-log"]);
    const stopCommands = commands(kept.harness.Stop);
    assert.equal(stopCommands[0], "another-stop");
    assert.equal(stopCommands.filter((command) => command.includes("--client antigravity")).length, 1);
    assert.equal(stopCommands.length, 2);
    assert.equal(commands(kept.harness.PreToolUse).filter((command) => command.includes("--client antigravity")).length, 1);

    assert.equal(repo.rawCli("install", "--take-over").status, 0);
    const taken = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(taken.other.PreToolUse, undefined);
    assert.deepEqual(commands(taken.other.PostToolUse), ["other-log"]);
    assert.deepEqual(commands(taken.other.Stop), ["other-stop"]);
    assert.ok(commands(taken.harness.Stop).includes("another-stop"));

    assert.equal(repo.cli("uninstall").status, 0);
    const uninstalled = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(uninstalled.harness.PreToolUse, undefined);
    assert.deepEqual(commands(uninstalled.harness.Stop), ["another-stop"]);
    assert.deepEqual(commands(uninstalled.other.PostToolUse), ["other-log"]);
    assert.deepEqual(commands(uninstalled.other.Stop), ["other-stop"]);
  });

  test("只有 harness 配置时卸载删除文件，禁用或缺 Stop 时 doctor 报问题", () => {
    const repo = setup();
    const file = join(repo.root, ".agents/hooks.json");
    const original = readFileSync(file, "utf8");
    const config = JSON.parse(original);
    config.harness.enabled = false;
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    const disabled = repo.cli("doctor");
    assert.notEqual(disabled.status, 0);
    assert.match(disabled.stdout, /\[!!\] client:antigravity: 未接入或已禁用/);

    config.harness.enabled = true;
    delete config.harness.Stop;
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    const missing = repo.cli("doctor");
    assert.notEqual(missing.status, 0);
    assert.match(missing.stdout, /client:antigravity: PreToolUse 已接入；收尾检查（Stop）未接入/);

    writeFileSync(file, original);
    assert.equal(repo.cli("uninstall").status, 0);
    assert.equal(existsSync(file), false);
  });
});
