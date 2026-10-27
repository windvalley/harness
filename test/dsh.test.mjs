import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { makeRepo, sh, write } from "./helpers.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

function runPlugin(calls, { sessionCwd, directoryError = false, prepare = () => {} } = {}) {
  const repo = makeRepo();
  repos.push(repo);
  const profile = join(repo.root, "..", "desktop-profile");
  mkdirSync(profile);
  prepare(repo);
  const cwd = sessionCwd?.({ repo, profile }) ?? repo.root;
  const entry = pathToFileURL(join(repo.root, ".harness/dsh-plugin/index.mjs")).href;
  const script = `
    const plugin = await import(process.argv[1]);
    const cwd = process.argv[2];
    const agent = {};
    const signal = new AbortController().signal;
    let preExecute;
    let forwarded = 0;
    const services = {
      tools: {},
      workingDirectory: {
        async ensure(owner, abortSignal) {
          if (owner !== agent || abortSignal !== signal) throw new Error("会话上下文没有传递给目录服务");
          if (process.argv[4] === "fail") throw new Error("目录服务不可用");
          return cwd;
        },
      },
    };
    // 模拟 Cordis 的依赖访问约束，门禁与 Git 配置读取使用真实实现。
    const ctx = new Proxy({
      on(event, handler) {
        if (event !== "tools/pre-execute") throw new Error("注册了错误的工具事件");
        preExecute = handler;
      },
    }, {
      get(target, key) {
        if (key in target) return target[key];
        if (!plugin.inject.includes(key)) throw new Error('cannot get property "' + key + '" without inject');
        return services[key];
      },
    });
    plugin.apply(ctx);
    const decisions = [];
    for (const call of JSON.parse(process.argv[3])) {
      decisions.push(await preExecute({ ...call, agent, signal }, async () => {
        forwarded++;
        return { kind: "allow" };
      }));
    }
    console.log(JSON.stringify({ decisions, forwarded }));
  `;
  const result = sh(profile, process.execPath, ["--input-type=module", "-e", script, entry, cwd, JSON.stringify(calls), directoryError ? "fail" : "ok"], repo.env);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("DSH 生成插件在非 Git 的宿主目录中按会话工作区放行普通工具", () => {
  const result = runPlugin([
    { name: "bash", arguments: { command: "pwd" } },
    { name: "read", arguments: { file_path: "README.md" } },
  ]);
  assert.deepEqual(result.decisions, [{ kind: "allow" }, { kind: "allow" }]);
  assert.equal(result.forwarded, 2);
});

test("DSH 生成插件在非 Git 会话目录中放行普通工具", () => {
  const result = runPlugin([
    { name: "bash", arguments: { command: "pwd" } },
    { name: "read", arguments: { file_path: "README.md" } },
  ], { sessionCwd: ({ profile }) => profile });
  assert.deepEqual(result.decisions, [{ kind: "allow" }, { kind: "allow" }]);
  assert.equal(result.forwarded, 2);
});

test("DSH 生成插件在未接入 harness 的 Git 仓库中放行普通工具", () => {
  const result = runPlugin([{ name: "read", arguments: { file_path: "README.md" } }], {
    prepare(repo) {
      const plain = join(repo.root, "..", "plain");
      mkdirSync(plain);
      const init = sh(plain, "git", ["init", "-q", "-b", "main"], repo.env);
      assert.equal(init.status, 0, init.stderr);
    },
    sessionCwd: ({ repo }) => join(repo.root, "..", "plain"),
  });
  assert.deepEqual(result.decisions, [{ kind: "allow" }]);
  assert.equal(result.forwarded, 1);
});

test("DSH 生成插件取得会话工作区后仍拒绝危险命令", () => {
  const result = runPlugin([{ name: "bash", arguments: { command: "git reset --hard" } }]);
  assert.equal(result.decisions[0].kind, "deny");
  assert.match(result.decisions[0].reason, /会丢弃未提交改动/);
  assert.equal(result.forwarded, 0);
});

test("DSH 生成插件无法确定会话工作目录时拒绝工具调用", () => {
  const result = runPlugin([{ name: "read", arguments: { file_path: "README.md" } }], { directoryError: true });
  assert.equal(result.decisions[0].kind, "deny");
  assert.match(result.decisions[0].reason, /无法确定会话工作目录/);
  assert.equal(result.forwarded, 0);
});

test("DSH 生成插件在 Git 执行失败时不放行工具调用", () => {
  const result = runPlugin([{ name: "read", arguments: { file_path: "README.md" } }], {
    prepare(repo) {
      repo.env.PATH = "";
    },
  });
  assert.equal(result.decisions[0].kind, "deny");
  assert.match(result.decisions[0].reason, /门禁无法加载项目配置/);
  assert.equal(result.forwarded, 0);
});

test("DSH 生成插件在已接入项目配置损坏时不放行工具调用", () => {
  const result = runPlugin([{ name: "read", arguments: { file_path: "README.md" } }], {
    prepare(repo) {
      write(repo.root, ".harness/policy.json", "{");
      const env = { ...repo.env, HARNESS_MAIN_BYPASS: "1" };
      const added = sh(repo.root, "git", ["add", ".harness/policy.json"], env);
      assert.equal(added.status, 0, added.stderr);
      const committed = sh(repo.root, "git", ["commit", "-q", "--no-verify", "-m", "test: 损坏门禁配置"], env);
      assert.equal(committed.status, 0, committed.stderr);
    },
  });
  assert.equal(result.decisions[0].kind, "deny");
  assert.match(result.decisions[0].reason, /无法解析/);
  assert.equal(result.forwarded, 0);
});
