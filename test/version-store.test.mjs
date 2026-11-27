import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { shimBody } from "../src/install/install.mjs";
import { packageVersion } from "../src/install/managed.mjs";
import { compareVersions } from "../src/install/version-store.mjs";
import { copyPackage, makeRepo, PACKAGE_ROOT, sh, write } from "./helpers.mjs";

const cli = join(PACKAGE_ROOT, "bin", "harness.mjs");
const version = packageVersion();

function fixture(t) {
  const repo = makeRepo({ install: false });
  t.after(repo.cleanup);
  const store = repo.env.HARNESS_STORE;
  return { repo, store, target: join(store, version) };
}

function inject(repo, code) {
  const file = join(repo.root, "..", "inject.mjs");
  writeFileSync(file, `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";\n${code}\nsyncBuiltinESMExports();\n`);
  return file;
}

function start(repo, args) {
  const child = spawn(process.execPath, args, { cwd: repo.root, env: { ...process.env, ...repo.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => { stdout += text; });
  child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, done };
}

async function waitFor(file) {
  for (let i = 0; i < 500; i++) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`没有到达故障注入点 ${file}`);
}

test("复制报 EIO 时正式版本从未出现，重试后可用", (t) => {
  const { repo, target } = fixture(t);
  const hook = inject(repo, `
    const copy = fs.copyFileSync;
    fs.copyFileSync = (from, to, ...args) => {
      if (to === ${JSON.stringify(join(target, "src/cli.mjs"))} || (to.includes("/.stage-") && to.endsWith("/src/cli.mjs"))) throw new Error("测试注入 EIO");
      return copy(from, to, ...args);
    };`);
  const failed = sh(repo.root, process.execPath, ["--import", hook, cli, "publish"], repo.env);
  assert.match(failed.stderr, /测试注入 EIO/);
  assert.equal(failed.status, 1);
  assert.equal(existsSync(target), false);
  assert.equal(repo.rawCli("versions").stdout, "");
  assert.equal(repo.rawCli("publish").status, 0);
  assert.ok(existsSync(join(target, "MANIFEST.json")));
});

test("强杀修复保留原清单，不同内容不能补位；原内容重试可恢复", (t) => {
  const { repo, store, target } = fixture(t);
  assert.equal(repo.rawCli("publish").status, 0);
  const rel = "src/cli.mjs";
  writeFileSync(join(target, rel), "// damaged\n");
  const hook = inject(repo, `
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (from === ${JSON.stringify(target)}) process.kill(process.pid, "SIGKILL");
    };`);
  const failed = sh(repo.root, process.execPath, ["--import", hook, cli, "publish"], repo.env);
  assert.notEqual(failed.status, 0);
  assert.equal(existsSync(target), false);
  assert.ok(existsSync(join(store, `.repair-${version}`, "MANIFEST.json")));
  assert.equal(repo.rawCli("versions").stdout, "");
  assert.equal(repo.rawCli("prune", "--keep", "0.0.0").status, 0);

  const modified = copyPackage();
  t.after(() => rmSync(modified, { recursive: true, force: true }));
  write(modified, "assets/test-publish.txt", "another distribution\n");
  const conflict = sh(repo.root, process.execPath, [join(modified, "bin/harness.mjs"), "publish"], repo.env);
  assert.match(conflict.stderr, /版本号不可变/);
  assert.equal(existsSync(target), false);

  const retry = repo.rawCli("publish");
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(readFileSync(join(target, rel)), readFileSync(join(PACKAGE_ROOT, rel)));
  assert.equal(existsSync(join(store, `.repair-${version}`)), false);
});

test("同一版本并发发布只产生一个正式目录，prune 等待同一把锁", async (t) => {
  const { repo, store, target } = fixture(t);
  const ready = join(dirname(store), "ready");
  const proceed = join(dirname(store), "proceed");
  const pauseRename = (arg) => `
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (${arg} === ${JSON.stringify(target)}) {
        fs.writeFileSync(${JSON.stringify(ready)}, "");
        const it = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 6000;
        while (!fs.existsSync(${JSON.stringify(proceed)}) && Date.now() < deadline) Atomics.wait(it, 0, 0, 10);
      }
      return rename(from, to);
    };`;
  const first = start(repo, ["--import", inject(repo, pauseRename("to")), cli, "publish"]);
  t.after(() => { first.child.kill(); });
  await waitFor(ready);
  assert.equal(existsSync(target), false);
  const second = start(repo, [cli, "publish"]);
  t.after(() => { second.child.kill(); });
  writeFileSync(proceed, "");
  const published = await Promise.all([first.done, second.done]);
  for (const result of published) assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(published.map(({ stdout }) => JSON.parse(stdout).existed), [false, true]);

  rmSync(ready);
  rmSync(proceed);
  writeFileSync(join(target, "src/cli.mjs"), "// damaged\n");
  // 阻塞点放在隔离坏目录之前，prune 的候选枚举必须看得到这一版本。
  const repair = start(repo, ["--import", inject(repo, pauseRename("from")), cli, "publish"]);
  t.after(() => { repair.child.kill(); });
  await waitFor(ready);
  const competing = join(dirname(store), "competing");
  const attempt = inject(repo, `
    const listed = fs.readdirSync;
    fs.readdirSync = (dir, ...args) => {
      const entries = listed(dir, ...args);
      if (String(dir).endsWith(${JSON.stringify(`/.locks/${version}`)}) && entries.length > 1) fs.writeFileSync(${JSON.stringify(competing)}, "");
      return entries;
    };`);
  const prune = start(repo, ["--import", attempt, cli, "prune", "--keep", "0.0.0"]);
  t.after(() => { prune.child.kill(); });
  await waitFor(competing);
  writeFileSync(proceed, "");
  const [repaired, pruned] = await Promise.all([repair.done, prune.done]);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.match(pruned.stdout, /已删除 1 个旧版本/);
  assert.equal(existsSync(target), false);
});

test("损坏、身份未知、临时目录不列出、不由 prune 清理，也不盲目覆盖", (t) => {
  const { repo, store, target } = fixture(t);
  mkdirSync(target, { recursive: true });
  write(target, "MANIFEST.json", "{\n");
  for (const name of ["0.0.9", "0.0.9.tmp-123", ".stage-0.0.9-wip"]) mkdirSync(join(store, name));
  assert.equal(repo.rawCli("versions").stdout, "");
  assert.match(repo.rawCli("prune", "--keep", "0.0.0").stdout, /已删除 0 个旧版本/);
  assert.match(repo.rawCli("publish").stderr, /无法确认.*未覆盖/);
  const preview = repo.rawCli("install", "--version", version, "--dry-run");
  assert.equal(preview.status, 1);
  assert.match(preview.stderr, /无法确认.*未覆盖/);
  assert.equal(readFileSync(join(target, "MANIFEST.json"), "utf8"), "{\n");
  assert.ok(existsSync(join(store, "0.0.9.tmp-123")));
  const doctor = repo.rawCli("doctor");
  assert.match(doctor.stdout, /\[!!\] store: .*MANIFEST\.json/);
});

test("历史版本由当前发布器安装，健康版本可从不含标签的源码离线复用", (t) => {
  const { repo, store } = fixture(t);
  const copied = copyPackage();
  t.after(() => rmSync(copied, { recursive: true, force: true }));
  for (const older of ["0.3.0", "0.4.0"]) {
    if (sh(PACKAGE_ROOT, "git", ["rev-parse", "--verify", "--quiet", `refs/tags/v${older}`]).status !== 0) continue;
    const preview = repo.rawCli("install", "--version", older, "--dry-run");
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /版本安装预览: 从标签安装/);
    assert.equal(existsSync(join(store, older)), false);
    const install = repo.rawCli("install", "--version", older);
    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stdout, /标签/);
    const manifest = JSON.parse(readFileSync(join(store, older, "MANIFEST.json"), "utf8"));
    assert.equal(manifest.version, older);
    assert.ok(Object.hasOwn(manifest.files, "bin/harness.mjs"));
    const reuse = sh(repo.root, process.execPath, [join(copied, "bin/harness.mjs"), "install", "--version", older], repo.env);
    assert.equal(reuse.status, 0, reuse.stderr);
    assert.doesNotMatch(reuse.stdout, /代码来自/);
    write(repo.root, ".harness/VERSION", `${older}\n`);
    write(repo.root, ".harness/bin/harness", shimBody(older));
    const refreshed = sh(repo.root, process.execPath, [join(copied, "bin/harness.mjs"), "install", "--local"], repo.env);
    assert.equal(refreshed.status, 0, refreshed.stderr);
    assert.match(refreshed.stdout, /已刷新本机/);
    assert.equal(readFileSync(join(repo.root, ".harness/bin/harness"), "utf8"), shimBody(older));
  }
  assert.equal(repo.rawCli("install", "--version", "0.4.0/../other").status, 1);
});

test("doctor 区分 CLI、VERSION 与实际入口锁定版本", (t) => {
  const { repo } = fixture(t);
  assert.equal(repo.rawCli("publish").status, 0);
  write(repo.root, ".harness/VERSION", `${version}\n`);
  write(repo.root, ".harness/bin/harness", shimBody("0.0.9"));
  const doctor = repo.rawCli("doctor");
  assert.match(doctor.stdout, /\[!!\] project:version: CLI .*VERSION .*shim 0\.0\.9.*两处锁定版本不一致/);
  assert.match(doctor.stdout, /\[!!\] store: 版本 0\.0\.9 未安装/);
});

test("compareVersions 按语义化版本排序：数字逐段比较，正式版高于同号预发布，忽略构建元数据", () => {
  const sorted = ["0.28.0", "0.9.4", "0.28.0-rc.10", "0.10.0", "0.28.0-rc.2", "1.0.0", "0.27.1"].sort(compareVersions);
  assert.deepEqual(sorted, ["0.9.4", "0.10.0", "0.27.1", "0.28.0-rc.2", "0.28.0-rc.10", "0.28.0", "1.0.0"]);
  assert.equal(compareVersions("0.28.0+build.1", "0.28.0"), 0);
});
