import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { makeRepo, sh, write } from "./helpers.mjs";
import { followUps } from "../src/install/followups.mjs";
import { packageVersion } from "../src/install/managed.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

function setup(opts) {
  const repo = makeRepo(opts);
  repos.push(repo);
  return repo;
}

// 本机共用的插件生成在版本目录旁，夹具里就是 <临时目录>/dsh-plugin。
function pluginDir(repo) {
  return join(repo.root, "..", "dsh-plugin");
}

function runPlugin(repo, calls, { cwd = repo.root, entry = join(pluginDir(repo), "index.mjs"), directoryError = false } = {}) {
  // DSH 主进程停在自己的 profile 目录里，不在任何仓库中。
  const host = join(repo.root, "..", "desktop-profile");
  mkdirSync(host, { recursive: true });
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
        if (event === "tools/pre-execute") preExecute = handler;
        else if (event !== "agent/turn-stopping") throw new Error("注册了未知的事件: " + event);
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
  const result = sh(host, process.execPath, ["--input-type=module", "-e", script, pathToFileURL(entry).href, cwd, JSON.stringify(calls), directoryError ? "fail" : "ok"], repo.env);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/** 改写入口锁定的版本，模拟项目锁定在别的版本上。 */
function pinVersion(repo, version) {
  const shim = join(repo.root, ".harness/bin/harness");
  writeFileSync(shim, readFileSync(shim, "utf8").replace(/:-[0-9][^}"]*\}/, `:-${version}}`));
}

/** 在版本目录里放一份只会拒绝的门禁代码，用来确认插件导入的是哪个版本。 */
function fakeVersion(repo, version) {
  const dir = join(repo.env.HARNESS_STORE, version, "src", "adapters");
  write(dir, "index.mjs", `export function guard() { return { decision: "deny", result: { reason: "来自 ${version}" } }; }\n`);
  write(dir, "dsh.mjs", `export const dsh = { name: "dsh" };\n`);
}

function dshProfile(repo, profile, { dependencies = {}, bundles = [] } = {}) {
  const dir = join(repo.env.DSH_HOME, "profiles", profile);
  write(dir, "package.json", `${JSON.stringify({ name: `dsh-profile-${profile}`, private: true, dependencies, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", ...bundles] } } }, null, 2)}\n`);
  return dir;
}

const DANGEROUS = [{ name: "bash", arguments: { command: "git reset --hard" } }];
const PLAIN = [
  { name: "bash", arguments: { command: "pwd" } },
  { name: "read", arguments: { file_path: "README.md" } },
];

test("install 把 DSH 插件写在版本目录旁，不在项目里生成插件目录", () => {
  const repo = setup();
  const dir = pluginDir(repo);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.equal(manifest.name, "harness-guard");
  assert.equal(manifest.version, packageVersion());
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.match(readFileSync(join(dir, "cordis.patch.yml"), "utf8"), /id: harness-guard/);
  const source = readFileSync(join(dir, "index.mjs"), "utf8");
  assert.ok(source.includes(JSON.stringify(repo.env.HARNESS_STORE)), "插件从生成时的版本目录导入门禁代码");
  assert.doesNotMatch(source, /@@HARNESS_STORE@@|\.\.\/\.\.\/src\//);
  assert.equal(existsSync(join(repo.root, ".harness/dsh-plugin")), false, "项目里不再生成插件目录");

  const local = repo.cli("install", "--local");
  assert.equal(local.status, 0, local.stderr);
  assert.ok(local.stdout.includes(dir), "install --local 输出本机插件的位置");
  assert.equal(existsSync(join(repo.root, ".harness/dsh-plugin")), false);
});

test("DSH 本机插件在非 Git 的宿主目录中按会话工作区放行普通工具", () => {
  const repo = setup();
  const result = runPlugin(repo, PLAIN);
  assert.deepEqual(result.decisions, [{ kind: "allow" }, { kind: "allow" }]);
  assert.equal(result.forwarded, 2);
});

test("DSH 本机插件在非 Git 会话目录中放行普通工具", () => {
  const repo = setup();
  const result = runPlugin(repo, PLAIN, { cwd: join(repo.root, "..", "desktop-profile") });
  assert.deepEqual(result.decisions, [{ kind: "allow" }, { kind: "allow" }]);
  assert.equal(result.forwarded, 2);
});

test("DSH 本机插件在未接入 harness 的 Git 仓库中放行普通工具", () => {
  const repo = setup();
  const plain = join(repo.root, "..", "plain");
  mkdirSync(plain);
  const init = sh(plain, "git", ["init", "-q", "-b", "main"], repo.env);
  assert.equal(init.status, 0, init.stderr);
  const result = runPlugin(repo, [{ name: "read", arguments: { file_path: "README.md" } }], { cwd: plain });
  assert.deepEqual(result.decisions, [{ kind: "allow" }]);
  assert.equal(result.forwarded, 1);
});

test("DSH 本机插件取得会话工作区后仍拒绝危险命令", () => {
  const repo = setup();
  const result = runPlugin(repo, DANGEROUS);
  assert.equal(result.decisions[0].kind, "deny");
  assert.match(result.decisions[0].reason, /会丢弃未提交改动/);
  assert.equal(result.forwarded, 0);
});

test("DSH 本机插件无法确定会话工作目录时拒绝工具调用", () => {
  const repo = setup();
  const result = runPlugin(repo, [{ name: "read", arguments: { file_path: "README.md" } }], { directoryError: true });
  assert.equal(result.decisions[0].kind, "deny");
  assert.match(result.decisions[0].reason, /无法确定会话工作目录/);
  assert.equal(result.forwarded, 0);
});

test("DSH 本机插件在 Git 执行失败时不放行工具调用", () => {
  const repo = setup();
  repo.env.PATH = "";
  const result = runPlugin(repo, [{ name: "read", arguments: { file_path: "README.md" } }]);
  assert.equal(result.decisions[0].kind, "deny");
  assert.match(result.decisions[0].reason, /门禁无法加载项目配置/);
  assert.equal(result.forwarded, 0);
});

test("DSH 本机插件在已接入项目配置损坏时不放行工具调用", () => {
  const repo = setup();
  write(repo.root, ".harness/policy.json", "{");
  const env = { ...repo.env, HARNESS_MAIN_BYPASS: "1" };
  const added = sh(repo.root, "git", ["add", ".harness/policy.json"], env);
  assert.equal(added.status, 0, added.stderr);
  const committed = sh(repo.root, "git", ["commit", "-q", "--no-verify", "-m", "test: 损坏门禁配置"], env);
  assert.equal(committed.status, 0, committed.stderr);
  const result = runPlugin(repo, [{ name: "read", arguments: { file_path: "README.md" } }]);
  assert.equal(result.decisions[0].kind, "deny");
  assert.match(result.decisions[0].reason, /无法解析/);
  assert.equal(result.forwarded, 0);
});

test("DSH 本机插件不绑定生成它的项目：那个项目移走后其他项目照常拦截", () => {
  const first = setup();
  const second = setup();
  rmSync(first.root, { recursive: true, force: true });
  const result = runPlugin(first, DANGEROUS, { cwd: second.root });
  assert.equal(result.decisions[0].kind, "deny");
  assert.match(result.decisions[0].reason, /会丢弃未提交改动/);
});

test("DSH 本机插件按会话所在项目入口锁定的版本导入门禁代码", () => {
  const repo = setup();
  fakeVersion(repo, "9.9.9");
  pinVersion(repo, "9.9.9");
  const pinned = runPlugin(repo, PLAIN.slice(0, 1));
  assert.deepEqual(pinned.decisions, [{ kind: "deny", reason: "[harness] 来自 9.9.9" }]);

  pinVersion(repo, packageVersion());
  const current = runPlugin(repo, PLAIN.slice(0, 1));
  assert.deepEqual(current.decisions, [{ kind: "allow" }], "锁定当前版本的项目不受其他已安装版本影响");
});

test("DSH 本机插件在项目锁定的版本没有安装时拒绝，并提示安装", () => {
  const repo = setup();
  pinVersion(repo, "9.9.8");
  const result = runPlugin(repo, PLAIN.slice(0, 1));
  assert.equal(result.decisions[0].kind, "deny");
  assert.match(result.decisions[0].reason, /本机没有安装门禁锁定的版本 9\.9\.8/);
  assert.match(result.decisions[0].reason, /install --local/);
});

test("DSH 本机插件对没有入口的仓库用本机最新的版本判定", () => {
  const repo = setup();
  // 主分支已有配置、当前检出却没有入口时，仍按主分支配置拦截。
  rmSync(join(repo.root, ".harness/bin/harness"));
  assert.equal(runPlugin(repo, DANGEROUS).decisions[0].kind, "deny");

  fakeVersion(repo, "99.0.0");
  mkdirSync(join(repo.env.HARNESS_STORE, "99.0.1.tmp-1"), { recursive: true });
  const newest = runPlugin(repo, PLAIN.slice(0, 1));
  assert.deepEqual(newest.decisions, [{ kind: "deny", reason: "[harness] 来自 99.0.0" }], "安装到一半的临时目录不算版本");
});

test("旧版本的 install 不覆盖更新版本生成的 DSH 插件", () => {
  const repo = setup();
  const dir = pluginDir(repo);
  const manifestFile = join(dir, "package.json");
  const original = readFileSync(join(dir, "index.mjs"), "utf8");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  writeFileSync(manifestFile, JSON.stringify({ ...manifest, version: "99.0.0" }));
  writeFileSync(join(dir, "index.mjs"), "// 更新版本生成的插件\n");
  assert.equal(repo.cli("install", "--local").status, 0);
  assert.equal(readFileSync(join(dir, "index.mjs"), "utf8"), "// 更新版本生成的插件\n");

  writeFileSync(manifestFile, JSON.stringify({ ...manifest, version: "0.0.1" }));
  assert.equal(repo.cli("install", "--local").status, 0);
  assert.equal(readFileSync(join(dir, "index.mjs"), "utf8"), original, "更旧版本生成的插件被换成当前版本");
});

test("doctor：没有 DeepSeek Harness 的 profile 时不要求注册", () => {
  const repo = setup();
  const result = repo.cli("doctor");
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /\[ok\] client:dsh: 未发现 DeepSeek Harness/);
});

test("doctor：profile 注册了本机插件时报告已注册，并列出还没注册的 profile", () => {
  const repo = setup();
  const desktop = join(repo.env.DSH_HOME, "profiles", "desktop");
  // pnpm 可能把本地路径记成相对 profile 目录的写法。
  dshProfile(repo, "desktop", { dependencies: { "harness-guard": `link:${relative(desktop, pluginDir(repo))}` }, bundles: ["harness-guard"] });
  dshProfile(repo, "web");
  const result = repo.cli("doctor");
  assert.equal(result.status, 0, result.stdout);
  const line = result.stdout.split("\n").find((item) => item.includes("client:dsh"));
  assert.match(line, /\[ok\]/);
  assert.match(line, /desktop 已注册/);
  assert.match(line, /web 未注册/);
  assert.ok(line.includes(`dsh plugin --profile web add ${pluginDir(repo)}`), line);
});

test("doctor：profile 注册的是旧版的项目插件时要求改为注册本机插件", () => {
  const repo = setup();
  const legacy = join(repo.root, ".harness/dsh-plugin");
  dshProfile(repo, "desktop", { dependencies: { "harness-guard": `link:${legacy}` }, bundles: ["harness-guard"] });
  const result = repo.cli("doctor");
  assert.equal(result.status, 1);
  const line = result.stdout.split("\n").find((item) => item.includes("client:dsh"));
  assert.match(line, /\[!!\]/);
  assert.ok(line.includes(legacy), line);
  assert.ok(line.includes(`--profile desktop add ${pluginDir(repo)}`), line);
});

test("doctor：profile 都没有注册时提示注册，不算失败", () => {
  const repo = setup();
  dshProfile(repo, "desktop");
  const result = repo.cli("doctor");
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /\[\?\] client:dsh: .*desktop 未注册/);
});

test("首次接入时 DeepSeek Harness 还没注册本机插件，init 提示注册一次", () => {
  const repo = setup({ install: false, project: { ".harness/config.json": null, ".harness/policy.json": null, ".harness/verify.json": null } });
  dshProfile(repo, "desktop");
  const result = repo.rawCli("init");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DeepSeek Harness/);
  assert.ok(result.stdout.includes(`--profile desktop add ${pluginDir(repo)}`), result.stdout);
});

function withEnv(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("合并改了入口时，DeepSeek Harness 仍注册着旧插件就提示改为注册本机插件；已注册本机插件不再提示", () => {
  const repo = setup();
  dshProfile(repo, "desktop", { dependencies: { "harness-guard": `link:${join(repo.root, ".harness/dsh-plugin")}` }, bundles: ["harness-guard"] });
  const stale = withEnv(repo.env, () => followUps({ mainRoot: repo.root, changed: [".harness/bin/harness"] }));
  assert.ok(stale.some((note) => note.includes(`--profile desktop add ${pluginDir(repo)}`)), stale.join("\n"));

  dshProfile(repo, "desktop", { dependencies: { "harness-guard": `link:${pluginDir(repo)}` }, bundles: ["harness-guard"] });
  const done = withEnv(repo.env, () => followUps({ mainRoot: repo.root, changed: [".harness/bin/harness"] }));
  assert.equal(done.some((note) => note.includes("DeepSeek Harness")), false, done.join("\n"));
});
