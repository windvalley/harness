import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { CONFIG, git, makeRepo, PACKAGE_ROOT, sh, write } from "./helpers.mjs";

const CLI = join(PACKAGE_ROOT, "bin/harness.mjs");
const repos = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

function setup(opts = {}) {
  const repo = makeRepo({ install: false, ...opts });
  repos.push(repo);
  return repo;
}

function snapshot(repo) {
  const files = (dir) => readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== ".git")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const path = join(dir, entry.name);
      return [entry.name, statSync(path).mode, entry.isDirectory() ? files(path) : readFileSync(path)];
    });
  return { project: files(repo.root), config: readFileSync(join(repo.root, ".git/config")), hooks: files(join(repo.root, ".git/hooks")) };
}

function runInjected(repo, code, ...args) {
  const file = join(repo.root, "..", "install-fault.mjs");
  write(dirname(file), "install-fault.mjs", `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
${code}
syncBuiltinESMExports();
`);
  return sh(repo.root, process.execPath, ["--import", file, CLI, ...args], repo.env);
}

function runFault(repo, code, ...args) {
  return runInjected(repo, `
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  ${code}
  return rename(from, to);
};
`, ...args);
}

function changedPaths(before, after) {
  const flatten = ({ project, hooks }) => {
    const paths = new Map();
    const collect = (base, entries) => {
      for (const [name, mode, content] of entries) {
        const file = join(base, name);
        const directory = Array.isArray(content);
        paths.set(file, { mode, content: directory ? null : content });
        if (directory) collect(file, content);
      }
    };
    collect("", project);
    collect(".git/hooks", hooks);
    return paths;
  };
  const old = flatten(before);
  const next = flatten(after);
  return [...new Set([...old.keys(), ...next.keys()])].filter((file) => !isDeepStrictEqual(old.get(file), next.get(file))).sort()
    .map((file) => [file, !next.has(file) ? "删除" : old.has(file) ? "更新" : "新增"]);
}

test("预检报告共用插件路径冲突，实跑不留下半安装的项目", () => {
  const repo = setup({ project: { ".harness/config.json": null, ".harness/policy.json": null, ".harness/verify.json": null } });
  write(dirname(repo.env.HARNESS_STORE), "dsh-plugin", "已有普通文件\n");
  const before = snapshot(repo);
  const preview = repo.rawCli("init", "--dry-run");
  assert.equal(preview.status, 1, preview.stdout + preview.stderr);
  assert.match(preview.stdout + preview.stderr, /冲突.*dsh-plugin/);
  const applied = repo.rawCli("init");
  assert.equal(applied.status, 1, applied.stdout + applied.stderr);
  assert.match(applied.stderr, /冲突.*dsh-plugin/s);
  assert.deepEqual(snapshot(repo), before);
  for (const name of ["HARNESS_STORE", "HARNESS_KEY_DIR", "HARNESS_DATA_DIR"]) assert.equal(existsSync(repo.env[name]), false, name);
});

test("四个安装入口的只读预览逐项匹配实际新增、更新和删除的项目路径", () => {
  for (const args of [["init"], ["upgrade"], ["install"], ["install", "--local"]]) {
    const repo = setup({ files: { ".harness/bin/claude-hook.mjs": "// legacy\n", ".gitignore": ".harness/bin/\n" } });
    const root = git(repo.root, "rev-parse", "--show-toplevel");
    const before = snapshot(repo);
    const gitBefore = readdirSync(join(repo.root, ".git"));
    const preview = repo.rawCli(...args, "--dry-run");
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.match(preview.stdout, /dsh-plugin/);
    assert.match(preview.stdout, /hooks\/reference-transaction/);
    if (args.includes("--local")) assert.doesNotMatch(preview.stdout, /\.claude\/settings\.json/);
    else assert.match(preview.stdout, /\.claude\/settings\.json/);
    assert.deepEqual(snapshot(repo), before);
    assert.deepEqual(readdirSync(join(repo.root, ".git")), gitBefore);
    for (const name of ["HARNESS_STORE", "HARNESS_KEY_DIR", "HARNESS_DATA_DIR"]) assert.equal(existsSync(repo.env[name]), false, name);

    const plan = [...preview.stdout.split("\n本机共享准备")[0].matchAll(/^  (新增|新建|更新|删除) (.+)$/gm)]
      .map(([, action, file]) => [file.replace(`${root}/`, ""), action === "新建" ? "新增" : action])
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const applied = repo.rawCli(...args);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.deepEqual(plan, changedPaths(before, snapshot(repo)), args.join(" "));
    assert.deepEqual(snapshot(repo).config, before.config);
  }
});

test("无效客户端 JSON 在升级预检就被拦住，不输出正文", () => {
  const repo = setup();
  write(repo.root, ".codex/hooks.json", "{fixture-private-marker");
  const before = snapshot(repo);
  for (const args of [["upgrade", "--dry-run"], ["upgrade"]]) {
    const result = repo.rawCli(...args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /\.codex\/hooks\.json.*JSON/);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-private-marker/);
    assert.deepEqual(snapshot(repo), before);
  }
  assert.equal(existsSync(repo.env.HARNESS_STORE), false);
  assert.equal(existsSync(join(repo.root, ".git/harness-install")), false);
});

test("项目安装和指定版本安装的预览都检查版本库锁路径", () => {
  const repo = setup();
  const version = repo.rawCli("version").stdout.trim();
  write(repo.env.HARNESS_STORE, ".locks", "occupied\n");
  const before = snapshot(repo);
  for (const args of [["install", "--local"], ["install", "--version", version]]) {
    for (const flags of [["--dry-run"], []]) {
      const result = repo.rawCli(...args, ...flags);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /\.locks/);
    }
  }
  assert.deepEqual(snapshot(repo), before);
  assert.deepEqual(readdirSync(repo.env.HARNESS_STORE), [".locks"]);
  assert.equal(existsSync(join(repo.root, ".git/harness-install")), false);
  assert.equal(existsSync(repo.keyDir), false);
});

test("预检拒绝钩子目录与事务内部路径重叠，不准备共享资源", () => {
  const repo = setup();
  git(repo.root, "config", "core.hooksPath", ".git/harness-install/lock");
  for (const args of [["install", "--dry-run"], ["install"]]) {
    const result = repo.rawCli(...args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /安装计划.*恢复目标/);
  }
  assert.equal(existsSync(join(repo.root, ".git/harness-install")), false);
  assert.equal(existsSync(repo.env.HARNESS_STORE), false);
  assert.equal(existsSync(repo.keyDir), false);
});

test("指定版本预览不写入，恢复不与其他安装参数同时使用", () => {
  const repo = setup();
  const version = repo.rawCli("version").stdout.trim();
  const preview = repo.rawCli("install", "--version", version, "--dry-run");
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(preview.stdout, /版本安装预览: 安装/);
  for (const flags of [["--version", version], ["--local"], ["--take-over"], ["--dry-run"]]) {
    const result = repo.rawCli("install", "--recover", ...flags);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /--recover 必须单独使用/);
  }
  assert.equal(existsSync(repo.env.HARNESS_STORE), false);
  assert.equal(existsSync(join(repo.root, ".git/harness-install")), false);
});

test("正式安装取得仓库锁后重算，保留等待期间的客户端配置改动", () => {
  const repo = setup();
  const file = join(repo.root, ".claude/settings.json");
  write(repo.root, ".claude/settings.json", '{"fixture":"before"}\n');
  const applied = runInjected(repo, `
const open = fs.openSync;
fs.openSync = (file, ...args) => {
  const fd = open(file, ...args);
  if (typeof file === "string" && args[0] === "wx" && file.includes("/.git/harness-install/lock/")) {
    fs.writeFileSync(${JSON.stringify(file)}, '{"fixture":"edited while waiting"}');
  }
  return fd;
};`, "install");
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const actual = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(actual.fixture, "edited while waiting");
  assert.ok(actual.hooks.PreToolUse.length > 0);
});

test("应用错误自动回滚项目文件、模式和 Git 钩子，不回滚共享准备", () => {
  const repo = setup();
  const oldHook = join(repo.root, ".git/hooks/pre-commit");
  write(repo.root, ".git/hooks/pre-commit", "#!/bin/sh\nexit 0\n");
  chmodSync(oldHook, 0o640);
  const before = snapshot(repo);
  const failed = runFault(repo, `if (to.endsWith("/.codex/hooks.json")) throw new Error("fixture-write-failed");`, "init");
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /fixture-write-failed/);
  assert.match(failed.stderr, /已回滚/);
  assert.deepEqual(snapshot(repo), before);
  assert.ok(existsSync(repo.env.HARNESS_STORE));
  assert.ok(existsSync(repo.keyDir));
  const retry = repo.rawCli("init");
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
});

test("强杀后诊断恢复位置，保留后续编辑并允许重试恢复", () => {
  const repo = setup();
  const before = snapshot(repo);
  const hook = join(repo.root, ".claude/settings.json");
  const killed = runFault(repo, `if (to.endsWith("/.claude/settings.json")) { rename(from, to); process.kill(process.pid, "SIGKILL"); }`, "init");
  assert.notEqual(killed.status, 0, killed.stdout + killed.stderr);
  const after = readFileSync(hook);
  const doctor = repo.rawCli("doctor");
  assert.match(doctor.stdout, /\[!!\] install:recovery: .*install --recover/);
  assert.match(doctor.stdout, /init.*\.git.*state\.json/);
  const denied = repo.rawCli("install", "--local");
  assert.equal(denied.status, 1, denied.stdout + denied.stderr);
  assert.match(denied.stderr, /install --recover/);

  write(repo.root, ".claude/settings.json", '{"later": true}\n');
  const partial = repo.rawCli("install", "--recover");
  assert.equal(partial.status, 1, partial.stdout + partial.stderr);
  assert.match(partial.stderr, /保留.*\.claude\/settings\.json/s);
  assert.equal(readFileSync(hook, "utf8"), '{"later": true}\n');
  write(repo.root, ".claude/settings.json", after);
  const recovered = repo.rawCli("install", "--recover");
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.deepEqual(snapshot(repo), before);
  assert.equal(repo.rawCli("install", "--recover").status, 0, "重复恢复无副作用");
});

test("回滚过程中强杀，原件已还原但进度未提交时可幂等恢复", () => {
  const repo = setup();
  const original = '{"fixture":true}\n';
  write(repo.root, ".claude/settings.json", original);
  const before = snapshot(repo);
  const killed = runFault(repo, `
if (to.endsWith("/.codex/hooks.json")) throw new Error("fixture-write-failed");
if (to.endsWith("/.claude/settings.json") && fs.readFileSync(from, "utf8") === ${JSON.stringify(original)}) {
  rename(from, to);
  process.kill(process.pid, "SIGKILL");
}`, "upgrade");
  assert.notEqual(killed.status, 0, killed.stdout + killed.stderr);
  const state = JSON.parse(readFileSync(join(repo.root, ".git/harness-install/state.json"), "utf8"));
  assert.equal(state.phase, "回滚");
  assert.ok(state.entries.some((entry) => entry?.file.endsWith("/.claude/settings.json")));
  assert.equal(readFileSync(join(repo.root, ".claude/settings.json"), "utf8"), original);
  const recovered = repo.rawCli("install", "--recover");
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.deepEqual(snapshot(repo), before);
});

test("恢复拒绝其他 Worktree、分支或提交，只允许回到原检出执行", () => {
  const repo = setup();
  const before = snapshot(repo);
  const head = git(repo.root, "rev-parse", "HEAD");
  const linked = join(repo.root, "..", "linked");
  git(repo.root, "worktree", "add", "-q", "--detach", linked);
  const killed = runFault(repo, `if (to.endsWith("/.claude/settings.json")) { rename(from, to); process.kill(process.pid, "SIGKILL"); }`, "init");
  assert.notEqual(killed.status, 0, killed.stdout + killed.stderr);
  const stateFile = join(repo.root, ".git/harness-install/state.json");
  const state = readFileSync(stateFile);
  const assertDenied = (result) => {
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /回到原 Worktree 和检出/);
    assert.deepEqual(readFileSync(stateFile), state);
  };
  assertDenied(sh(linked, process.execPath, [CLI, "install", "--recover"], repo.env));
  git(repo.root, "switch", "-q", "--detach", head);
  assertDenied(repo.rawCli("install", "--recover"));
  git(repo.root, "switch", "-q", "main");
  const child = git(repo.root, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "test: checkout changed");
  const env = { ...repo.env, HARNESS_MAIN_BYPASS: "1" };
  git(repo.root, "update-ref", "refs/heads/main", child, head, env);
  assertDenied(repo.rawCli("install", "--recover"));
  git(repo.root, "update-ref", "refs/heads/main", head, child, env);
  const recovered = repo.rawCli("install", "--recover");
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.deepEqual(snapshot(repo), before);
});

test("Git 配置写入后失败只恢复本次修改的键", () => {
  const repo = setup({ project: { ".harness/config.json": { ...CONFIG, git: { hooksDir: ".githooks" } } } });
  const file = join(repo.root, ".git/config");
  const before = snapshot(repo);
  const failed = runInjected(repo, `
const { spawnSync } = await import("node:child_process");
const rename = fs.renameSync;
let injected = false;
fs.renameSync = (from, to) => {
  rename(from, to);
  if (!injected && to.endsWith("/.git/config")) {
    injected = true;
    const { status } = spawnSync("git", ["config", "--file", to, "fixture.keep", "changed"]);
    if (status !== 0) throw new Error("无法写入夹具配置");
    throw new Error("fixture-core.hooksPath-failed");
  }
};`, "install");
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /core\.hooksPath.*已回滚/s);
  assert.equal(git(repo.root, "config", "--file", file, "--get", "fixture.keep"), "changed");
  assert.equal(sh(repo.root, "git", ["config", "--get", "core.hooksPath"], repo.env).status, 1);
  const actual = snapshot(repo);
  assert.deepEqual(actual.project, before.project);
  assert.deepEqual(actual.hooks, before.hooks);
});

test("强杀安装进程后，尚未执行完的 Git 子进程不能再修改公共配置", () => {
  const repo = setup({ project: { ".harness/config.json": { ...CONFIG, git: { hooksDir: ".githooks" } } } });
  const temp = dirname(repo.root);
  const fakebin = join(temp, "delayed-git");
  const allow = join(temp, "allow-delayed-git");
  const done = join(temp, "done-delayed-git");
  const real = sh(repo.root, "sh", ["-c", "command -v git"], repo.env).stdout.trim();
  mkdirSync(fakebin);
  write(fakebin, "git", `#!/bin/sh
real=${JSON.stringify(real)}
if [ "$1" = config ] && [ "$2" = --file ] && [ "$4" = -- ] && [ "$5" = core.hooksPath ]; then
  kill -KILL "$PPID"
  (
    i=0
    while [ ! -f ${JSON.stringify(allow)} ] && [ "$i" -lt 400 ]; do sleep 0.025; i=$((i + 1)); done
    if [ -f ${JSON.stringify(allow)} ]; then "$real" "$@"; fi
    printf done > ${JSON.stringify(done)}
  ) </dev/null >/dev/null 2>&1 &
  exit 0
fi
exec "$real" "$@"
`);
  chmodSync(join(fakebin, "git"), 0o755);
  const before = snapshot(repo);
  const killed = sh(repo.root, process.execPath, [CLI, "install"], { ...repo.env, PATH: `${fakebin}:${process.env.PATH}` });
  assert.notEqual(killed.status, 0, killed.stdout + killed.stderr);
  const recovered = repo.rawCli("install", "--recover");
  write(temp, "allow-delayed-git", "");
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 4000;
  while (!existsSync(done) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 20);
  assert.ok(existsSync(done), "延迟 Git 未运行");
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.deepEqual(snapshot(repo), before);
});

test("恢复只清理本次安装留下的 Git 配置锁，不删除外部锁", () => {
  for (const foreign of [false, true]) {
    const repo = setup({ project: { ".harness/config.json": { ...CONFIG, git: { hooksDir: ".githooks" } } } });
    const before = snapshot(repo);
    const lock = join(repo.root, ".git/config.lock");
    const killed = runFault(repo, `if (from.endsWith("/.git/config.lock")) process.kill(process.pid, "SIGKILL");`, "install");
    assert.notEqual(killed.status, 0, killed.stdout + killed.stderr);
    assert.ok(existsSync(lock), "安装进程在持有 Git 配置锁后被强杀");
    if (foreign) {
      const content = readFileSync(lock);
      renameSync(lock, join(dirname(repo.root), "old-config.lock"));
      write(repo.root, ".git/config.lock", content);
      const blocked = repo.rawCli("install", "--recover");
      assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
      assert.match(blocked.stderr, /保留外部锁/);
      assert.deepEqual(readFileSync(lock), content, "锁内容相同不等于属于本次安装");
      unlinkSync(lock);
    }
    const recovered = repo.rawCli("install", "--recover");
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
    assert.equal(existsSync(lock), false);
    assert.deepEqual(snapshot(repo), before);
  }
});

test("分支名含 Unicode 空白时，中断记录仍可读取并完成恢复", () => {
  const repo = setup();
  const branch = "fix/a\u00a0b";
  git(repo.root, "checkout", "-q", "-b", branch);
  const before = snapshot(repo);
  const killed = runFault(repo, `if (to.endsWith("/.claude/settings.json")) { rename(from, to); process.kill(process.pid, "SIGKILL"); }`, "init");
  assert.notEqual(killed.status, 0, killed.stdout + killed.stderr);
  const stateFile = join(repo.root, ".git/harness-install/state.json");
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).branch, `refs/heads/${branch}`);
  const doctor = repo.rawCli("doctor");
  assert.match(doctor.stdout, /install:recovery/);
  assert.doesNotMatch(doctor.stdout, /记录格式无效/);
  const recovered = repo.rawCli("install", "--recover");
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.deepEqual(snapshot(repo), before);
});

test("分支引用非法的恢复记录不会被当成可恢复记录", () => {
  const repo = setup();
  const killed = runFault(repo, `if (to.endsWith("/.claude/settings.json")) { rename(from, to); process.kill(process.pid, "SIGKILL"); }`, "init");
  assert.notEqual(killed.status, 0, killed.stdout + killed.stderr);
  const stateFile = join(repo.root, ".git/harness-install/state.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  state.branch = "refs/heads/a b";
  writeFileSync(stateFile, JSON.stringify(state));
  const doctor = repo.rawCli("doctor");
  assert.match(doctor.stdout, /记录格式无效/);
  assert.match(doctor.stdout, /移开/);
  const denied = repo.rawCli("install");
  assert.equal(denied.status, 1, denied.stdout + denied.stderr);
  assert.match(denied.stderr, /记录格式无效/);
});

test("备份阶段被强杀时先留下恢复记录，恢复会清理孤儿备份", () => {
  const repo = setup();
  const before = snapshot(repo);
  const killed = runFault(repo, `if (/originals-[0-9a-f]{24}\\/\\d+$/.test(to)) { rename(from, to); process.kill(process.pid, "SIGKILL"); }`, "init");
  assert.notEqual(killed.status, 0, killed.stdout + killed.stderr);
  const stateDir = join(repo.root, ".git/harness-install");
  const stateFile = join(stateDir, "state.json");
  assert.ok(existsSync(stateFile), "备份前应先写恢复记录");
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).started, 0);
  assert.ok(readdirSync(stateDir).some((name) => name.startsWith("originals-")), "被强杀时留下了私有备份");
  const recovered = repo.rawCli("install", "--recover");
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.deepEqual(snapshot(repo), before);
  assert.deepEqual(readdirSync(stateDir), ["lock"], "孤儿备份应被清理");
});
