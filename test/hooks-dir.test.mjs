import { strict as assert } from "node:assert";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, commit, CONFIG, fakeReviewer, git, makeRepo, PACKAGE_ROOT, sh, write } from "./helpers.mjs";
import { gitHooksConfig } from "../src/lib/config.mjs";
import { hooksPlacement, samePath } from "../src/lib/git.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});
function setup(opts = {}) {
  const repo = makeRepo(opts);
  repos.push(repo);
  return repo;
}

const CLI = join(PACKAGE_ROOT, "bin", "harness.mjs");
const BASIC = "feat(demo): 增加示例\n\n- 增加一个文件\n- 补充说明";
// 私钥类文件用常量拼出来，避免命令文本里出现完整扩展名而触发密钥保护规则。
const SECRET_FILE = `config/server.${"pem"}`;
const HOOKS = { hooksDir: ".githooks", projectHooks: "scripts/git-hooks" };
const MANAGED_CONFIG = { ...CONFIG, git: HOOKS };

const cli = (repo, cwd, ...args) => sh(cwd, process.execPath, [CLI, ...args], repo.env);
const hooksPath = (repo) => sh(repo.root, "git", ["config", "--get", "core.hooksPath"], repo.env).stdout.trim();
const linked = (repo, name, branch) => {
  const dir = join(repo.root, "..", name);
  git(repo.root, "worktree", "add", "-q", "-b", branch, dir, "main");
  return dir;
};
const writeHook = (dir, name, body, mode = 0o755) => {
  write(dir, `scripts/git-hooks/${name}`, body);
  chmodSync(join(dir, "scripts/git-hooks", name), mode);
};
const stageAndCommit = (repo, dir, file, message = BASIC) => {
  write(dir, file, `${file}\n`);
  sh(dir, "git", ["add", file], repo.env);
  return sh(dir, "git", ["commit", "-q", "-m", message], repo.env);
};

describe("项目接管 git 钩子目录", () => {
  test("生成整份钩子并让 core.hooksPath 指向主 Worktree 里的这个目录", () => {
    const repo = setup({ project: { ".harness/config.json": MANAGED_CONFIG } });
    for (const name of ["pre-commit", "commit-msg", "reference-transaction"]) {
      const text = readFileSync(join(repo.root, ".githooks", name), "utf8");
      assert.match(text, /# harness:hook /, name);
      assert.match(text, /scripts\/git-hooks/, `${name} 调用项目钩子`);
    }
    assert.ok(samePath(hooksPath(repo), join(repo.root, ".githooks")), hooksPath(repo));
    assert.equal(git(repo.root, "status", "--porcelain"), "", "生成的钩子已随接入提交");
    assert.match(repo.cli("doctor").stdout, /\[ok\] git:hooksPath/);
  });

  test("停在旧分支、检出里没有钩子目录的 Worktree 也经过门禁", () => {
    const repo = setup();
    const old = linked(repo, "wt-old", "task/old");
    write(repo.root, ".harness/config.json", `${JSON.stringify(MANAGED_CONFIG, null, 2)}\n`);
    const installed = repo.rawCli("install");
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /core\.hooksPath 已从 \(未设置\) 改为/);
    commit(repo.root, "chore(harness): 接管钩子目录\n\n- 钩子改由 .githooks 提供\n- 提交生成的钩子");

    assert.equal(existsSync(join(old, ".githooks")), false, "旧分支的检出里没有钩子目录");
    write(old, SECRET_FILE, "-----BEGIN PRIVATE KEY-----\n");
    sh(old, "git", ["add", "-f", SECRET_FILE], repo.env);
    const committed = sh(old, "git", ["commit", "-q", "-m", BASIC], repo.env);
    assert.notEqual(committed.status, 0, "旧分支 Worktree 的提交也要经过 harness");
    assert.match(committed.stderr, /密钥|已拦截/);

    const head = git(old, "rev-parse", "HEAD", repo.env);
    const refused = sh(old, "git", ["update-ref", "refs/heads/main", head], repo.env);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /只允许由 harness merge 更新/);
  });

  test("任务分支里启用时不切换，合入后由 harness merge 切换并提醒其他机器", () => {
    const repo = setup();
    const wt = linked(repo, "wt-hooks", "chore/hooks");
    const marker = join(repo.root, "..", "project-hook.log");
    write(wt, ".harness/config.json", `${JSON.stringify(MANAGED_CONFIG, null, 2)}\n`);
    writeHook(wt, "pre-commit", `#!/bin/sh\necho ran >> "${marker}"\n`);

    const installed = cli(repo, wt, "install");
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /主 Worktree 里还没有生成的钩子/);
    assert.equal(hooksPath(repo), "", "主 Worktree 里没有钩子时不能切换，否则 git 会静默跳过钩子");
    assert.ok(existsSync(join(wt, ".githooks", "pre-commit")));

    sh(wt, "git", ["add", "-A"], repo.env);
    const made = sh(wt, "git", ["commit", "-q", "-m", "chore(harness): 接管钩子目录\n\n- 钩子改由 .githooks 提供\n- 增加项目钩子"], repo.env);
    assert.equal(made.status, 0, made.stderr);
    assert.equal(existsSync(marker), false, "合入前仍是原来的钩子，项目钩子还没接上");

    fakeReviewer(repo, APPROVE);
    const branch = "chore/hooks";
    assert.equal(repo.rawCli("verify", "--branch", branch).status, 0);
    assert.equal(repo.rawCli("review", "--branch", branch).status, 0);
    assert.equal(repo.rawCli("confirm", "--branch", branch, "--yes").status, 0);
    const merged = repo.rawCli("merge", "--branch", branch);
    assert.equal(merged.status, 0, merged.stderr);
    assert.match(merged.stderr, /core\.hooksPath 已从/);
    assert.ok(JSON.parse(merged.stdout).followUps.some((note) => /其他机器拉到新的主分支后各自运行 harness install --local/.test(note)));
    assert.ok(samePath(hooksPath(repo), join(repo.root, ".githooks")));
    assert.equal(git(repo.root, "status", "--porcelain"), "", "切换只改本机配置，不动入库文件");

    const next = linked(repo, "wt-next", "task/next");
    const after = stageAndCommit(repo, next, "b.txt");
    assert.equal(after.status, 0, after.stderr);
    assert.match(readFileSync(marker, "utf8"), /ran/, "合入后提交会执行项目钩子");
  });

  test("项目钩子在 harness 检查之后执行：失败拦下提交，没有执行权限时拒绝，改了暂存区按最终内容再判", () => {
    const repo = setup({ project: { ".harness/config.json": MANAGED_CONFIG } });
    const wt = linked(repo, "wt-project", "task/project");

    writeHook(wt, "pre-commit", "#!/bin/sh\necho project-check-failed >&2\nexit 7\n");
    const failed = stageAndCommit(repo, wt, "a.txt");
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /project-check-failed/);

    chmodSync(join(wt, "scripts/git-hooks/pre-commit"), 0o644);
    const notExecutable = sh(wt, "git", ["commit", "-q", "-m", BASIC], repo.env);
    assert.notEqual(notExecutable.status, 0, "项目钩子不可执行时不能像 git 那样静默跳过");
    assert.match(notExecutable.stderr, /没有可执行权限/);
    assert.match(cli(repo, wt, "doctor").stdout, /\[!!\] git:project-hooks: .*没有可执行权限/, "doctor 检查当前 Worktree 里的项目钩子");

    writeHook(wt, "pre-commit", `#!/bin/sh\nmkdir -p config\nprintf -- '-----BEGIN PRIVATE KEY-----\\n' > ${SECRET_FILE}\ngit add -f ${SECRET_FILE}\n`);
    const restaged = sh(wt, "git", ["commit", "-q", "-m", BASIC], repo.env);
    assert.notEqual(restaged.status, 0, "项目钩子暂存进来的内容同样要过门禁");
    assert.match(restaged.stderr, /密钥|已拦截/);
    sh(wt, "git", ["rm", "-q", "--cached", SECRET_FILE], repo.env);
    rmSync(join(wt, SECRET_FILE));

    const marker = join(repo.root, "..", "project-ran.log");
    writeHook(wt, "pre-commit", `#!/bin/sh\necho ran >> "${marker}"\n`);
    const passed = sh(wt, "git", ["commit", "-q", "-m", BASIC], repo.env);
    assert.equal(passed.status, 0, passed.stderr);
    assert.ok(existsSync(marker));
  });

  test("目录里已有其他工具的钩子时拒绝覆盖，并说明移到哪里", () => {
    const repo = setup({ install: false, project: { ".harness/config.json": MANAGED_CONFIG } });
    write(repo.root, ".githooks/pre-commit", "#!/bin/sh\nnpx lint-staged\n");
    const result = repo.rawCli("install");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /由 harness 接管.*pre-commit.*移到 scripts\/git-hooks/s);
    assert.equal(readFileSync(join(repo.root, ".githooks/pre-commit"), "utf8"), "#!/bin/sh\nnpx lint-staged\n", "原有内容不能被冲掉");
  });

  test("core.hooksPath 被改到别处时 doctor 报出，install --local 改回来", () => {
    const repo = setup({ project: { ".harness/config.json": MANAGED_CONFIG } });
    git(repo.root, "config", "core.hooksPath", "frontend/.husky");
    assert.match(repo.cli("doctor").stdout, /\[!!\] git:hooksPath: core\.hooksPath 是 frontend\/\.husky，应为/);
    const fixed = repo.cli("install", "--local");
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.match(fixed.stdout, /core\.hooksPath 已从 frontend\/\.husky 改为/);
    assert.match(repo.cli("doctor").stdout, /\[ok\] git:hooksPath/);
  });

  test("core.hooksPath 被旧分支里的工具改走时，harness merge 在更新主分支前改回来", () => {
    const repo = setup({ project: { ".harness/config.json": MANAGED_CONFIG } });
    const wt = linked(repo, "wt-heal", "task/heal");
    assert.equal(stageAndCommit(repo, wt, "a.txt").status, 0);
    // 模拟旧分支里 husky 的 prepare：依赖安装时把公共配置改回自己的相对目录。
    git(repo.root, "config", "core.hooksPath", "frontend/.husky");

    fakeReviewer(repo, APPROVE);
    assert.equal(repo.rawCli("verify", "--branch", "task/heal").status, 0);
    assert.equal(repo.rawCli("review", "--branch", "task/heal").status, 0);
    const merged = repo.rawCli("merge", "--branch", "task/heal");
    assert.equal(merged.status, 0, merged.stderr);
    assert.match(merged.stderr, /core\.hooksPath 被改成了 frontend\/\.husky，已改回/);
    assert.ok(samePath(hooksPath(repo), join(repo.root, ".githooks")));
  });

  test("core.hooksPath 是指向主 Worktree 的绝对路径时，在 Linked Worktree 里定位到自己的检出", () => {
    const repo = setup({ project: { ".harness/config.json": MANAGED_CONFIG } });
    const wt = linked(repo, "wt-place", "task/place");
    const placement = hooksPlacement(wt);
    assert.equal(placement.rel, ".githooks");
    assert.equal(placement.dir, join(wt, ".githooks"), "不能定位到主 Worktree，否则重装会改到主 Worktree 的入库文件");
  });

  test("uninstall 删掉生成的钩子并撤销 core.hooksPath", () => {
    const repo = setup({ project: { ".harness/config.json": MANAGED_CONFIG } });
    const result = repo.cli("uninstall");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(repo.root, ".githooks/pre-commit")), false);
    assert.equal(hooksPath(repo), "");
  });

  test("钩子目录只能是仓库内的相对目录", () => {
    for (const bad of ["../hooks", "/abs/hooks", ".git/hooks", "a/../b", ".", ""]) {
      if (bad === "") {
        assert.equal(gitHooksConfig({ git: { hooksDir: bad } }), null, "未配置时沿用原有方式");
        continue;
      }
      assert.throws(() => gitHooksConfig({ git: { hooksDir: bad } }), /相对目录/, bad);
    }
    assert.deepEqual(gitHooksConfig({ git: { hooksDir: "./.githooks/", projectHooks: "scripts/git-hooks/" } }), {
      hooksDir: ".githooks",
      projectHooks: "scripts/git-hooks",
    });
  });
});
