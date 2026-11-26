import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
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
    assert.match(result.stderr, /--recover 只能与 --adopt 或 --abandon 一起使用/);
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
  assert.match(doctor.stdout, /--recover --abandon/, "损坏记录要指向官方归档通道");
  const denied = repo.rawCli("install");
  assert.equal(denied.status, 1, denied.stdout + denied.stderr);
  assert.match(denied.stderr, /记录格式无效/);
  const abandoned = repo.rawCli("install", "--recover", "--abandon");
  assert.equal(abandoned.status, 0, abandoned.stdout + abandoned.stderr);
  assert.equal(repo.rawCli("install").status, 0, "归档后安装恢复可用");
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

test("中断后又有新提交时默认拒绝，--adopt 只回退未变化的项并归档原件", () => {
  const repo = setup();
  const hookFile = join(repo.root, ".git/hooks/pre-commit");
  write(repo.root, ".git/hooks/pre-commit", "#!/bin/sh\necho original\n");
  chmodSync(hookFile, 0o640);
  const before = snapshot(repo);
  const killed = runFault(repo, `if (to.endsWith("/.claude/settings.json")) { rename(from, to); process.kill(process.pid, "SIGKILL"); }`, "init");
  assert.notEqual(killed.status, 0, killed.stdout + killed.stderr);

  write(repo.root, "later.txt", "中断之后的新改动\n");
  git(repo.root, "add", "-A", { ...repo.env, HARNESS_MAIN_BYPASS: "1" });
  git(repo.root, "commit", "-q", "--no-verify", "-m", "chore: 中断后继续提交\n\n- 保留现场\n", { ...repo.env, HARNESS_MAIN_BYPASS: "1" });

  const denied = repo.rawCli("install", "--recover");
  assert.equal(denied.status, 1, denied.stdout + denied.stderr);
  assert.match(denied.stderr, /回到原 Worktree 和检出/);
  assert.match(denied.stderr, /--adopt/);

  const adopted = repo.rawCli("install", "--recover", "--adopt");
  assert.equal(adopted.status, 0, adopted.stdout + adopted.stderr);
  assert.match(adopted.stdout, /已按最佳努力回滚/);
  const archive = adopted.stdout.match(/归档: (\S+)/)?.[1];
  assert.ok(archive && existsSync(archive), adopted.stdout);
  assert.ok(existsSync(join(archive, "state.json")), "记录应归档而不是删除");
  assert.equal(existsSync(join(repo.root, ".git/harness-install/state.json")), false);
  assert.match(readFileSync(hookFile, "utf8"), /^#!\/bin\/sh\necho original\n$/, "钩子应回退到安装前");
  assert.ok(existsSync(join(repo.root, "later.txt")), "中断后的人工改动保留");

  const reinstalled = repo.rawCli("init");
  assert.equal(reinstalled.status, 0, reinstalled.stdout + reinstalled.stderr);
  assert.deepEqual(snapshot(repo).config, before.config);
});

test("原 Worktree 被删除后可在主 Worktree 用 --adopt 解除封锁", () => {
  const repo = setup();
  const linked = join(repo.root, "..", "linked-adopt");
  git(repo.root, "worktree", "add", "-q", "-b", "fix/linked", linked);
  const killed = runFault({ ...repo, root: linked, env: repo.env }, `if (to.endsWith("/.claude/settings.json")) { rename(from, to); process.kill(process.pid, "SIGKILL"); }`, "install");
  assert.notEqual(killed.status, 0, killed.stdout + killed.stderr);
  const stateDir = join(repo.root, ".git/harness-install");
  assert.ok(existsSync(join(stateDir, "state.json")));
  git(repo.root, "worktree", "remove", "--force", linked);

  const denied = repo.rawCli("install", "--recover");
  assert.equal(denied.status, 1, denied.stdout + denied.stderr);
  const adopted = repo.rawCli("install", "--recover", "--adopt");
  assert.equal(adopted.status, 0, adopted.stdout + adopted.stderr);
  assert.match(adopted.stdout, /已按最佳努力回滚/);
  const archive = adopted.stdout.match(/归档: (\S+)/)?.[1];
  assert.ok(archive && existsSync(join(archive, "state.json")), adopted.stdout);
  assert.equal(existsSync(join(stateDir, "state.json")), false);
  assert.equal(repo.rawCli("install", "--recover").stdout.trim(), "没有待恢复的项目安装。");
});

test("--abandon 只归档记录与备份，不动项目文件", () => {
  const repo = setup();
  const killed = runFault(repo, `if (to.endsWith("/.claude/settings.json")) { rename(from, to); process.kill(process.pid, "SIGKILL"); }`, "init");
  assert.notEqual(killed.status, 0, killed.stdout + killed.stderr);
  const stateDir = join(repo.root, ".git/harness-install");
  const snapshotFiles = () => readdirSync(repo.root).sort();
  const before = snapshotFiles();
  const abandoned = repo.rawCli("install", "--recover", "--abandon");
  assert.equal(abandoned.status, 0, abandoned.stdout + abandoned.stderr);
  assert.match(abandoned.stdout, /项目文件未改动/);
  const archive = abandoned.stdout.match(/归档: (\S+)/)?.[1];
  assert.ok(archive && existsSync(join(archive, "state.json")));
  assert.deepEqual(snapshotFiles(), before, "项目文件不应被改动");
  assert.equal(existsSync(join(stateDir, "state.json")), false);
  assert.equal(repo.rawCli("install").status, 0, "归档后安装恢复可用");
});

test("恢复记录损坏时可用 --abandon 归档解除封锁", () => {
  const repo = setup();
  const killed = runFault(repo, `if (to.endsWith("/.claude/settings.json")) { rename(from, to); process.kill(process.pid, "SIGKILL"); }`, "init");
  assert.notEqual(killed.status, 0, killed.stdout + killed.stderr);
  writeFileSync(join(repo.root, ".git/harness-install/state.json"), "{ 损坏的记录");
  const denied = repo.rawCli("install");
  assert.equal(denied.status, 1, denied.stdout + denied.stderr);
  const abandoned = repo.rawCli("install", "--recover", "--abandon");
  assert.equal(abandoned.status, 0, abandoned.stdout + abandoned.stderr);
  assert.equal(repo.rawCli("install").status, 0, "归档后安装恢复可用");
});

test("--adopt 与 --abandon 互斥且只能与 --recover 连用", () => {
  const repo = setup();
  for (const args of [["install", "--recover", "--adopt", "--abandon"], ["install", "--adopt"], ["install", "--abandon"], ["init", "--adopt"]]) {
    const result = repo.rawCli(...args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /--adopt|--abandon/);
  }
  assert.equal(existsSync(join(repo.root, ".git/harness-install")), false);
});


/** 起一个把项目写入拖慢的安装进程，用于制造“进行中”状态。 */
function startSlowInstall(repo) {
  const hook = join(dirname(repo.root), "slow-install.mjs");
  write(dirname(hook), "slow-install.mjs", `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (to.includes("/repo/") && !to.includes("/.git/harness-install/") && !to.includes("/hooks/")) {
    const wait = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(wait, 0, 0, 150);
  }
  return rename(from, to);
};
syncBuiltinESMExports();
`);
  return spawn(process.execPath, ["--import", hook, CLI, "init"], { cwd: repo.root, env: { ...process.env, ...repo.env }, stdio: ["ignore", "ignore", "pipe"] });
}

async function waitForState(file) {
  for (let i = 0; i < 500; i++) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`没有等到 ${file}`);
}

test("进行中的安装不会被第二个安装误报为中断记录", async () => {
  const repo = setup();
  const stateFile = join(repo.root, ".git/harness-install/state.json");
  const child = startSlowInstall(repo);
  const exited = new Promise((resolve) => child.on("close", resolve));
  try {
    await waitForState(stateFile);
    const doctor = repo.rawCli("doctor");
    assert.match(doctor.stdout, /install:in-progress/);
    assert.doesNotMatch(doctor.stdout, /install --recover/, "进行中的安装不应提示恢复");
    const preview = repo.rawCli("install", "--dry-run");
    assert.equal(preview.status, 1, preview.stdout + preview.stderr);
    assert.match(preview.stderr, /正在进行/);
    const second = repo.rawCli("install");
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.doesNotMatch(second.stderr, /留有安装恢复记录/, "拿锁后记录已清，不应再报中断");
  } finally {
    child.stderr.destroy();
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
  }
});

test("存在待恢复记录时拒绝卸载，--dry-run 只给警告", () => {
  const repo = setup();
  const before = snapshot(repo);
  const killed = runFault(repo, `if (to.endsWith("/.claude/settings.json")) { rename(from, to); process.kill(process.pid, "SIGKILL"); }`, "init");
  assert.notEqual(killed.status, 0, killed.stdout + killed.stderr);
  const partial = snapshot(repo);
  const denied = repo.rawCli("uninstall");
  assert.equal(denied.status, 1, denied.stdout + denied.stderr);
  assert.match(denied.stderr, /install --recover/);
  assert.deepEqual(snapshot(repo), partial, "拒绝时不应改动任何文件");
  const preview = repo.rawCli("uninstall", "--dry-run");
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(preview.stdout, /注意: .*install --recover/);
  const recovered = repo.rawCli("install", "--recover");
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  const removed = repo.rawCli("uninstall");
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
});

test("init 预览遇到托管冲突时仍输出调查现状", () => {
  const repo = setup();
  write(repo.root, ".harness/rules/core.md", "# 项目自己的修改\n");
  const before = snapshot(repo);
  const preview = repo.rawCli("init", "--dry-run");
  assert.equal(preview.status, 1, preview.stdout + preview.stderr);
  assert.match(preview.stdout, /现状/, "冲突时也要先输出调查现状");
  assert.match(preview.stdout, /git 钩子目录/);
  assert.match(preview.stdout, /冲突\s+\.harness\/rules\/core\.md/);
  assert.match(preview.stdout, /预览未写入任何文件/);
  assert.deepEqual(snapshot(repo), before);
});

test("无效的 .harness/VERSION 直接报错，不被静默改写", () => {
  const repo = setup();
  const file = join(repo.root, ".harness/VERSION");
  write(repo.root, ".harness/VERSION", "garbage\n");
  for (const args of [["init"], ["upgrade"], ["install"], ["install", "--dry-run"], ["upgrade", "--dry-run"]]) {
    const result = repo.rawCli(...args);
    assert.equal(result.status, 1, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /\.harness\/VERSION 里的版本号无效/, args.join(" "));
    assert.equal(readFileSync(file, "utf8"), "garbage\n", `${args.join(" ")} 不应改写版本锁定`);
  }
  // 修好之后照常可用。
  write(repo.root, ".harness/VERSION", `${repo.rawCli("version").stdout.trim()}\n`);
  assert.equal(repo.rawCli("install").status, 0);
});

test("自动回滚未能完成时恢复提示只出现一次", () => {
  const repo = setup({ project: { ".harness/config.json": { ...CONFIG, git: { hooksDir: ".harness/hooks" } } } });
  const hook = join(repo.root, ".claude/settings.json");
  write(repo.root, ".claude/settings.json", '{"fixture":true}\n');
  const failed = runFault(repo, `
if (to.endsWith("/.claude/settings.json")) { fs.writeFileSync(${JSON.stringify(join(repo.root, ".git/config.lock"))}, "foreign\\n"); throw new Error("fixture-write-failed"); }`, "install");
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /恢复未完成/);
  assert.equal((failed.stderr.match(/install --recover/g) ?? []).length, 1, `提示重复:\\n${failed.stderr}`);
  unlinkSync(join(repo.root, ".git/config.lock"));
  assert.equal(repo.rawCli("install", "--recover").status, 0);
});

test("doctor 报告安装锁的持有者与无法识别的残留文件", () => {
  const repo = setup();
  const stateDir = join(repo.root, ".git/harness-install");
  const lockDir = join(stateDir, "lock");
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  // pid 1 恒活，等价于“另一个安装正在进行”。
  writeFileSync(join(lockDir, "1-0123456789abcdef01234567"), "");
  const busy = repo.rawCli("doctor");
  assert.match(busy.stdout, /install:lock: .*pid 1/);
  unlinkSync(join(lockDir, "1-0123456789abcdef01234567"));
  writeFileSync(join(lockDir, "stale-name"), "");
  const unknown = repo.rawCli("doctor");
  assert.match(unknown.stdout, /install:lock: .*stale-name/);
  unlinkSync(join(lockDir, "stale-name"));
  const clean = repo.rawCli("doctor");
  assert.match(clean.stdout, /install:lock: 没有安装锁占用/);
});

test("原 Worktree 已删除时，--adopt 的未恢复项说明是工作区不见了", () => {
  const repo = setup();
  const linked = join(repo.root, "..", "linked-gone");
  git(repo.root, "worktree", "add", "-q", "-b", "fix/linked-gone", linked);
  // 目标文件先存在，安装才会留下原件；否则回滚时“文件本来就没有”会被当作已恢复。
  write(repo.root, ".claude/settings.json", '{"before":true}\n');
  write(linked, ".claude/settings.json", '{"before":true}\n');
  git(linked, "add", "-A");
  git(linked, "commit", "-q", "--no-verify", "-m", "chore: 预置客户端配置\n\n- 模拟已有配置", { ...repo.env, HARNESS_MAIN_BYPASS: "1" });
  const killed = runFault({ root: linked, env: repo.env }, `if (to.endsWith("/.claude/settings.json")) { rename(from, to); process.kill(process.pid, "SIGKILL"); }`, "install");
  assert.notEqual(killed.status, 0, killed.stdout + killed.stderr);
  git(repo.root, "worktree", "remove", "--force", linked);
  const adopted = repo.rawCli("install", "--recover", "--adopt");
  assert.equal(adopted.status, 0, adopted.stdout + adopted.stderr);
  assert.match(adopted.stdout, /原 Worktree 已不存在/, "工作区被删与文件被改要分开说明");
  assert.doesNotMatch(adopted.stdout, /中断后又被改动/);
});
