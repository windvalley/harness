import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { makeRepo, PACKAGE_ROOT, sh } from "./helpers.mjs";

const CLI = join(PACKAGE_ROOT, "bin/harness.mjs");
const repos = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

function setup(files = {}) {
  const repo = makeRepo({ install: false, files });
  repos.push(repo);
  return repo;
}

/** 在项目里造一个指向共享目录的文件级软链，返回链接与目标的绝对路径。 */
function linkFile(repo, rel, targetRel, content) {
  const target = join(dirname(repo.root), targetRel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  const link = join(repo.root, rel);
  mkdirSync(dirname(link), { recursive: true });
  rmSync(link, { force: true });
  symlinkSync(target, link);
  return { link, target };
}

function linkDir(repo, rel, targetRel) {
  const target = join(dirname(repo.root), targetRel);
  mkdirSync(target, { recursive: true });
  rmSync(join(repo.root, rel), { force: true, recursive: true });
  symlinkSync(target, join(repo.root, rel));
  return target;
}

test("文件级符号链接默认拒绝，提示不跟随写入且给出接管参数", () => {
  const repo = setup();
  const { link, target } = linkFile(repo, "AGENTS.md", "shared/AGENTS.md", "# 共享规范\n");
  const before = readFileSync(target, "utf8");
  const denied = repo.rawCli("init");
  assert.equal(denied.status, 1, denied.stdout + denied.stderr);
  assert.match(denied.stderr, /AGENTS\.md 是符号链接/);
  assert.match(denied.stderr, /--force 或 --take-over/);
  assert.equal(readFileSync(target, "utf8"), before, "默认不跟随写入目标文件");
  assert.ok(existsSync(link), "默认不动链接");
});

test("显式接管时替换链接本身，目标文件保持原样", () => {
  for (const args of [["init", "--force"], ["init", "--take-over"]]) {
    const repo = setup();
    const { link, target } = linkFile(repo, "AGENTS.md", "shared/AGENTS.md", "# 共享规范\n");
    const before = readFileSync(target, "utf8");
    const applied = repo.rawCli(...args);
    assert.equal(applied.status, 0, `${args.join(" ")}: ${applied.stdout}${applied.stderr}`);
    assert.equal(readFileSync(target, "utf8"), before, "目标文件不能被改写");
    const stat = readFileSync(link, "utf8");
    assert.match(stat, /harness:start/, "链接应被替换为带托管块的普通文件");
  }
});

test("显式接管同样适用于 .gitignore、.harness/VERSION 与入口 shim", () => {
  const repo = setup();
  const gitignore = linkFile(repo, ".gitignore", "shared/gitignore", "bin/\n");
  const version = (() => {
    mkdirSync(join(repo.root, ".harness"), { recursive: true });
    return linkFile(repo, ".harness/VERSION", "shared/VERSION", "0.27.0\n");
  })();
  const shim = (() => {
    mkdirSync(join(repo.root, ".harness/bin"), { recursive: true });
    return linkFile(repo, ".harness/bin/harness", "shared/shim", "#!/bin/sh\n");
  })();
  const applied = repo.rawCli("install", "--take-over");
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  for (const item of [gitignore, version, shim]) {
    assert.ok(!readFileSync(item.link, "utf8").startsWith("/"), "链接应被替换为普通文件");
    assert.notEqual(item.link, item.target);
  }
  assert.equal(readFileSync(gitignore.target, "utf8"), "bin/\n", "目标文件不能被改写");
  assert.equal(readFileSync(version.target, "utf8"), "0.27.0\n", "目标文件不能被改写");
  assert.match(readFileSync(shim.link, "utf8"), /harness 入口 shim/);
});

test("目录级符号链接即使带接管参数也拒绝", () => {
  const repo = setup();
  const target = linkDir(repo, ".claude", "shared/claude");
  for (const args of [["init", "--force"], ["init", "--take-over"], ["install", "--take-over"]]) {
    const denied = repo.rawCli(...args);
    assert.equal(denied.status, 1, `${args.join(" ")}: ${denied.stdout}${denied.stderr}`);
    assert.match(denied.stderr, /父目录是符号链接/);
    assert.deepEqual(readdirSync(target), [], "共享目录不应被写入");
  }
});
