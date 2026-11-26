import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { PACKAGE_ROOT, makeRepo, sh } from "./helpers.mjs";
import { inspectDirectory, requireDirectory, statIfPresent } from "../src/install/install-paths.mjs";

const CLI = join(PACKAGE_ROOT, "bin/harness.mjs");
const repos = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

function setup() {
  const repo = makeRepo({ install: false });
  repos.push(repo);
  return repo;
}

function runInstall(repo, env, ...args) {
  return sh(repo.root, process.execPath, [CLI, ...args], env);
}

// 默认路径由 HOME 推导：只在测 HOME 布局时去掉共享目录覆盖，其余仍走夹具的隔离目录。
function homeEnv(repo, home) {
  const env = { ...repo.env, HOME: home };
  delete env.HARNESS_STORE;
  delete env.HARNESS_KEY_DIR;
  return env;
}

function version(repo) {
  return runInstall(repo, repo.env, "version").stdout.trim();
}

test("共享目录允许路径上的符号链接，项目路径仍拒绝", () => {
  const base = mkdtempSync(join(tmpdir(), "harness-paths-"));
  try {
    const real = join(base, "real");
    mkdirSync(join(real, "nested"), { recursive: true });
    symlinkSync(real, join(base, "link"));
    // 用户环境里的软链：允许，目标存在时仍要求是目录。
    assert.equal(inspectDirectory(join(base, "link", "nested", "deep"), { allowSymlinks: true }), false);
    assert.equal(inspectDirectory(join(base, "link", "nested"), { allowSymlinks: true }), true);
    symlinkSync(join(real, "nested"), join(base, "target-link"));
    assert.equal(inspectDirectory(join(base, "target-link"), { allowSymlinks: true }), true);
    // 项目路径保持拒绝。
    assert.throws(() => inspectDirectory(join(base, "link", "nested")), /父目录是符号链接/);
    assert.throws(() => inspectDirectory(join(base, "target-link")), /父目录是符号链接/);
    // 目标不是目录时仍然报错。
    writeFileSync(join(base, "regular-file"), "");
    assert.throws(() => inspectDirectory(join(base, "regular-file"), { allowSymlinks: true }), /路径不是目录/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("HOME 是符号链接时安装与发布都可用", () => {
  const repo = setup();
  const base = dirname(repo.root);
  const realHome = join(base, "real-home");
  mkdirSync(realHome);
  const homeLink = join(base, "home-link");
  symlinkSync(realHome, homeLink);
  const env = homeEnv(repo, homeLink);
  const installed = runInstall(repo, env, "install");
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.ok(existsSync(join(realHome, ".local/share/harness/versions")), "版本库应落在真实 HOME 下");
  assert.ok(existsSync(join(realHome, ".local/share/harness/evidence.key")), "证据密钥应落在真实 HOME 下");
  const published = runInstall(repo, env, "publish");
  assert.equal(published.status, 0, published.stdout + published.stderr);
  assert.ok(existsSync(join(realHome, ".local/share/harness/versions", version(repo), "MANIFEST.json")));
});

test("版本库与证据密钥目录的祖先为符号链接时安装可用", () => {
  const repo = setup();
  const base = dirname(repo.root);
  const realStore = join(base, "real-store");
  const realKey = join(base, "real-key");
  mkdirSync(realStore);
  mkdirSync(realKey);
  symlinkSync(realStore, join(base, "store-link"));
  symlinkSync(realKey, join(base, "key-link"));
  const env = { ...repo.env, HARNESS_STORE: join(base, "store-link", "versions"), HARNESS_KEY_DIR: join(base, "key-link") };
  const installed = runInstall(repo, env, "install");
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.ok(existsSync(join(realStore, "versions", version(repo), "MANIFEST.json")));
  assert.ok(existsSync(join(realKey, "evidence.key")));
  const preview = runInstall(repo, env, "install", "--dry-run");
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
});

test("~/.local/share 是符号链接时默认共享目录可用", () => {
  const repo = setup();
  const base = dirname(repo.root);
  const realHome = join(base, "real-home");
  const realData = join(base, "real-data");
  mkdirSync(realHome);
  mkdirSync(realData);
  mkdirSync(join(realHome, ".local"), { recursive: true });
  symlinkSync(realData, join(realHome, ".local/share"));
  const env = homeEnv(repo, realHome);
  const installed = runInstall(repo, env, "install", "--local");
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.ok(existsSync(join(realData, "harness", "versions", version(repo), "MANIFEST.json")));
  assert.ok(existsSync(join(realData, "harness", "evidence.key")));
});

test("相对路径的版本库按当前工作目录解析", () => {
  const repo = setup();
  const env = { ...repo.env, HARNESS_STORE: "relative-store" };
  const installed = runInstall(repo, env, "install");
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.ok(existsSync(join(repo.root, "relative-store", version(repo), "MANIFEST.json")), "相对路径应落在运行目录下");
  const manifest = JSON.parse(readFileSync(join(repo.root, "relative-store", version(repo), "MANIFEST.json"), "utf8"));
  assert.equal(manifest.version, version(repo));
});
