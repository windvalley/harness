import { strict as assert } from "node:assert";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { PACKAGE_ROOT, git, makeRepo, write } from "./helpers.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});
function setup() {
  const repo = makeRepo();
  repos.push(repo);
  return repo;
}

function snapshot(repo) {
  return {
    status: git(repo.root, "status", "--porcelain"),
    agents: readFileSync(join(repo.root, "AGENTS.md"), "utf8"),
  };
}

describe("子命令帮助", () => {
  test("upgrade --help 与 -h 只打印该命令的用法，不执行升级", () => {
    const repo = setup();
    rmSync(join(repo.root, ".harness/rules/core.md"));
    const before = snapshot(repo);
    for (const flag of ["--help", "-h"]) {
      const result = repo.rawCli("upgrade", flag);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /harness upgrade/);
      assert.match(result.stdout, /--dry-run/);
      assert.doesNotMatch(result.stdout, /verify\s+\[--head/, "只列本命令，不是全部用法");
      assert.deepEqual(snapshot(repo), before);
      assert.equal(existsSync(join(repo.root, ".harness/rules/core.md")), false);
    }
  });

  test("多行与多条目的命令都能列全", () => {
    const repo = setup();
    const status = repo.rawCli("status", "--help");
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /--branch/);
    assert.match(status.stdout, /--post-merge/);
    const attest = repo.rawCli("attest", "--help");
    assert.equal(attest.status, 0, attest.stderr);
    assert.match(attest.stdout, /合并后检查用 --at/, "续行也要带上");
    const pitfall = repo.rawCli("pitfall", "add", "--help");
    assert.equal(pitfall.status, 0, pitfall.stderr);
    assert.match(pitfall.stdout, /--signature/);
    const clean = repo.rawCli("worktree", "clean", "--help");
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /--with-local-files/);
  });

  test("未知命令带 --help 仍报未知命令", () => {
    const repo = setup();
    const result = repo.rawCli("nosuch", "--help");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /未知命令: nosuch/);
  });

  test("--command=-h 这类带等号的取值，以及 -- 之后的参数不当成帮助请求", () => {
    const repo = setup();
    const result = repo.rawCli("check", "--kind", "shell", "--command=-h");
    assert.doesNotMatch(result.stdout, /用法:/);
  });

  test("顶层 -h 打印全部用法", () => {
    const repo = setup();
    const result = repo.rawCli("-h");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /工程流程/);
  });
});

describe("upgrade 参数", () => {
  test("未知选项与多余的位置参数一律拒绝，退出码 2，且不改动任何文件", () => {
    const repo = setup();
    rmSync(join(repo.root, ".harness/rules/core.md"));
    const before = snapshot(repo);
    for (const args of [["--bogus"], ["extra"], ["--dry-run", "--bogus"]]) {
      const result = repo.rawCli("upgrade", ...args);
      assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /harness upgrade --help/);
      assert.deepEqual(snapshot(repo), before);
      assert.equal(existsSync(join(repo.root, ".harness/rules/core.md")), false);
    }
  });

  test("其他命令的参数错误同样退出 2 并指向 --help", () => {
    const repo = setup();
    const result = repo.rawCli("status", "--nosuch");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /harness status --help/);
  });
});

describe("upgrade --dry-run", () => {
  test("列出将新增与更新的文件，不写任何文件", () => {
    const repo = setup();
    rmSync(join(repo.root, ".harness/rules/core.md"));
    const before = snapshot(repo);
    const result = repo.rawCli("upgrade", "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /新增\s+\.harness\/rules\/core\.md/);
    assert.match(result.stdout, /更新\s+AGENTS\.md/);
    assert.doesNotMatch(result.stdout, /(新增|更新)\s+\.harness\/rules\/harness\.md/, "没变化的文件不列");
    assert.match(result.stdout, /没有写入任何文件/);
    assert.match(result.stdout, /config\.json、policy\.json、verify\.json/);
    assert.deepEqual(snapshot(repo), before);
    assert.equal(existsSync(join(repo.root, ".harness/rules/core.md")), false);
  });

  test("已是最新时说明没有文件需要改", () => {
    const repo = setup();
    const upgraded = repo.rawCli("upgrade");
    assert.equal(upgraded.status, 0, upgraded.stderr);
    const result = repo.rawCli("upgrade", "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /^\s*(新增|更新)\s/m);
    assert.match(result.stdout, /已是最新/);
  });

  test("预告将移除的黄金任务旧副本，不改 tasks.json", () => {
    const repo = setup();
    const builtin = JSON.parse(readFileSync(join(PACKAGE_ROOT, "assets/golden/builtin.json"), "utf8")).tasks;
    const identical = builtin.find((task) => task.id === "g01-secret-read-denied");
    const stale = { ...builtin.find((task) => task.id === "g02-secret-write-denied"), steps: [{ kind: "write", path: ".env", expect: "deny" }] };
    write(repo.root, ".harness/golden/tasks.json", `${JSON.stringify({ version: 1, tasks: [identical, stale] }, null, 2)}\n`);
    const file = join(repo.root, ".harness/golden/tasks.json");
    const before = readFileSync(file, "utf8");
    const result = repo.rawCli("upgrade", "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /将移除.*g01-secret-read-denied/s);
    assert.match(result.stdout, /覆盖内置.*g02-secret-write-denied/s);
    assert.equal(readFileSync(file, "utf8"), before);
  });

  test("预告版本变化：显示项目锁定的版本与当前代码版本", () => {
    const repo = setup();
    write(repo.root, ".harness/VERSION", "0.0.1\n");
    const result = repo.rawCli("upgrade", "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /0\.0\.1\s*->\s*\d+\.\d+\.\d+/);
    assert.match(result.stdout, /更新\s+\.harness\/VERSION/);
    assert.equal(readFileSync(join(repo.root, ".harness/VERSION"), "utf8"), "0.0.1\n");
  });
});
