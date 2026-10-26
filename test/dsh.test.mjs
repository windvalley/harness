import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { makeRepo, sh } from "./helpers.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

function runPlugin(calls) {
  const repo = makeRepo();
  repos.push(repo);
  const profile = join(repo.root, "..", "desktop-profile");
  mkdirSync(profile);
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
  const result = sh(profile, process.execPath, ["--input-type=module", "-e", script, entry, repo.root, JSON.stringify(calls)], repo.env);
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

test("DSH 生成插件取得会话工作区后仍拒绝危险命令", () => {
  const result = runPlugin([{ name: "bash", arguments: { command: "git reset --hard" } }]);
  assert.equal(result.decisions[0].kind, "deny");
  assert.match(result.decisions[0].reason, /会丢弃未提交改动/);
  assert.equal(result.forwarded, 0);
});
