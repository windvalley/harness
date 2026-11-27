import { strict as assert } from "node:assert";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { PACKAGE_ROOT, copyPackage, git, makeRepo, sh, write } from "./helpers.mjs";
import { packageVersion } from "../src/install/managed.mjs";

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

/** 把当前源码改成指定版本号发布进夹具的版本目录，模拟本机装了别的版本。 */
function publishAs(t, repo, version) {
  const pkg = copyPackage();
  t.after(() => rmSync(pkg, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  write(pkg, "package.json", JSON.stringify({ ...manifest, version }));
  const published = sh(repo.root, process.execPath, [join(pkg, "bin/harness.mjs"), "publish"], repo.env);
  assert.equal(published.status, 0, published.stderr);
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
      assert.match(result.stdout, /--force/);
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
    assert.match(status.stdout, /--handoff/);
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

  test("客户端列表按 claude、codex、dsh、antigravity、generic 排列", () => {
    const repo = setup();
    const result = repo.rawCli("-h");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--client <claude\|codex\|dsh\|antigravity\|generic>/);
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
    assert.match(result.stdout, /没有写入项目或本机共享安装目录/);
    assert.match(result.stdout, /config\.json、policy\.json、verify\.json/);
    assert.match(result.stdout, /Agent 可直接继续执行：harness upgrade/);
    assert.deepEqual(snapshot(repo), before);
    assert.equal(existsSync(join(repo.root, ".harness/rules/core.md")), false);
  });

  test("冲突预览明确由人执行 force 覆盖", () => {
    const repo = setup();
    write(repo.root, ".harness/rules/core.md", "# 项目自己的修改\n");
    const result = repo.rawCli("upgrade", "--dry-run");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /冲突\s+\.harness\/rules\/core\.md/);
    assert.match(result.stdout, /由人在自己的终端执行：\.harness\/bin\/harness upgrade --force/);
    assert.match(readFileSync(join(repo.root, ".harness/rules/core.md"), "utf8"), /项目自己的修改/);
  });

  test("已是最新时说明没有文件需要改", () => {
    const repo = setup();
    const upgraded = repo.rawCli("upgrade");
    assert.equal(upgraded.status, 0, upgraded.stderr);
    const result = repo.rawCli("upgrade", "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /^\s*(新增|更新)\s/m);
    assert.match(result.stdout, /已是 \S+ 的最新安装/);
    assert.match(result.stdout, /无需继续执行：/);
    assert.equal((result.stdout.match(/的最新安装/g) ?? []).length, 1, "已是最新只提示一次");
  });

  test("用项目锁定的入口预览升级：说明只能刷新到当前运行的版本，并给出本机已装的更新版本的运行方式", (t) => {
    const repo = setup();
    const current = packageVersion();
    publishAs(t, repo, "0.0.9");
    publishAs(t, repo, "99.0.0");
    assert.equal(repo.cli("upgrade").status, 0, "先把夹具刷新到当前版本，预览才没有要写的文件");
    const result = repo.cli("upgrade", "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`版本 ${escape(current)} -> ${escape(current)}`));
    assert.match(result.stdout, new RegExp(`当前运行的 harness 就是项目锁定的 ${escape(current)}`));
    assert.match(result.stdout, /本机已安装更新的版本 99\.0\.0/);
    assert.doesNotMatch(result.stdout, /0\.0\.9/, "比锁定版本旧的不提示");
    assert.ok(result.stdout.includes("HARNESS_VERSION=99.0.0 .harness/bin/harness upgrade --dry-run"), result.stdout);
    assert.doesNotMatch(result.stdout, /项目安装已是最新/, "不能把“与当前代码一致”说成已是最新版本");
    assert.match(result.stdout, new RegExp(`已是 ${escape(current)} 的最新安装`));

    const followed = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["upgrade", "--dry-run"], { ...repo.env, HARNESS_VERSION: "99.0.0" });
    assert.equal(followed.status, 0, followed.stderr);
    assert.match(followed.stdout, new RegExp(`版本 ${escape(current)} -> 99\\.0\\.0`), "照提示运行就能看到真正的升级");
    assert.match(followed.stdout, /更新\s+\.harness\/VERSION/);
  });

  test("本机没有更新的版本时，提示用新版本的 harness 源码执行", () => {
    const repo = setup();
    const result = repo.cli("upgrade", "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /当前运行的 harness 就是项目锁定的/);
    assert.match(result.stdout, /本机没有比它更新的已安装版本/);
    assert.match(result.stdout, /node <新版本 harness 源码>\/bin\/harness\.mjs upgrade --dry-run/);
  });

  test("正式升级时版本没变，不说成已升级", () => {
    const repo = setup();
    const current = packageVersion();
    const result = repo.cli("upgrade");
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /已升级到/);
    assert.match(result.stdout, new RegExp(`版本仍是 ${escape(current)}`));
    assert.match(result.stdout, /当前运行的 harness 就是项目锁定的/);
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


describe("授权命令帮助区分 Agent 与人工的责任", () => {
  test("approve 由 Agent 登记对话授权，confirm 仍由人执行", () => {
    const repo = setup();
    const approved = repo.rawCli("approve", "--help");
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(approved.stdout, /对话授权后由 Agent 执行/);
    assert.match(approved.stdout, /--from-stages/);
    assert.match(approved.stdout, /--confirm-contract/);
    const confirmed = repo.rawCli("confirm", "--help");
    assert.equal(confirmed.status, 0, confirmed.stderr);
    assert.match(confirmed.stdout, /由人在自己的终端执行/);
    const cleaned = repo.rawCli("worktree", "clean", "--help");
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.match(cleaned.stdout, /用户同意安全清理后由 Agent 逐项检查并执行/);
    const rotated = repo.rawCli("key", "rotate", "--help");
    assert.equal(rotated.status, 0, rotated.stderr);
    assert.match(rotated.stdout, /由人在自己的终端执行/);
  });
});
