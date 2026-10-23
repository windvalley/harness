import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, commit, fakeReviewer, git, makeRepo, sh, write } from "./helpers.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

const MESSAGE = "chore(harness): 接入门禁\n\n- 写入配置与入口\n- 接入钩子";

// 旧门禁的主分支保护：没有它自己的令牌就拒绝任何对 main 的更新。
const LEGACY_GUARD = `#!/bin/sh
input="$(cat)"
[ "$1" = "prepared" ] || exit 0
case "$input" in
  *" refs/heads/main"*)
    [ -f "$(git rev-parse --show-toplevel)/legacy/guard.mjs" ] || { echo "legacy guard missing" >&2; exit 1; }
    [ "\${LEGACY_TOKEN:-}" = "ok" ] || { echo "legacy guard: main 只能由旧合并工具更新" >&2; exit 1; }
    ;;
esac
exit 0
`;

const HUSKY_PRE_COMMIT = `#!/bin/sh
if git diff --cached --quiet -- frontend/; then
  exit 0
fi
echo lint-staged
`;

/**
 * 一个“已有门禁”的项目：husky 钩子入库，reference-transaction 里是旧门禁的主分支保护，
 * .claude/settings.json 里挂着旧门禁的拦截脚本，AGENTS.md 里有别的工具的托管块，.gitignore 全局忽略 bin/。
 */
function legacyProject() {
  const repo = makeRepo({
    install: false,
    project: { ".harness/config.json": null, ".harness/policy.json": null, ".harness/verify.json": null },
  });
  repos.push(repo);
  // makeRepo 预置了带 harness 托管块的 AGENTS.md，这里换成真实项目的样子。
  write(repo.root, "AGENTS.md", "# 项目规范\n\n<!-- wisharness:start -->\n读 `.wisharness/rules/core.md`\n<!-- wisharness:end -->\n");
  write(repo.root, ".wisharness/rules/core.md", "规则\n");
  write(repo.root, "legacy/guard.mjs", "// 旧门禁\n");
  write(repo.root, "legacy/claude-hook.mjs", "// 旧拦截\n");
  write(repo.root, ".gitignore", "bin/\n*.log\n");
  write(repo.root, "frontend/.husky/pre-commit", HUSKY_PRE_COMMIT);
  write(repo.root, "frontend/.husky/reference-transaction", LEGACY_GUARD);
  write(
    repo.root,
    ".claude/settings.json",
    `${JSON.stringify(
      {
        permissions: { allow: ["Bash(git status)"] },
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/legacy/claude-hook.mjs"' }] }] },
      },
      null,
      2,
    )}\n`,
  );
  chmodSync(join(repo.root, "frontend/.husky/pre-commit"), 0o755);
  chmodSync(join(repo.root, "frontend/.husky/reference-transaction"), 0o755);
  commit(repo.root, "chore(legacy): 旧门禁\n\n- 钩子与拦截\n- 托管块", {});
  git(repo.root, "config", "core.hooksPath", "frontend/.husky");
  return repo;
}

function onboard(repo, { takeOver = false, branch = "chore/harness-onboard" } = {}) {
  git(repo.root, "checkout", "-q", "-b", branch);
  const init = repo.rawCli("init", ...(takeOver ? ["--take-over"] : []));
  assert.equal(init.status, 0, init.stderr + init.stdout);
  git(repo.root, "add", "-A");
  git(repo.root, "commit", "-q", "-m", MESSAGE);
  git(repo.root, "checkout", "-q", "main");
  return init;
}

describe("接入已有项目", () => {
  test("预览只调查不写入，列出冲突、保留项与可退役的目录", () => {
    const repo = legacyProject();
    const before = git(repo.root, "status", "--porcelain");
    const result = repo.rawCli("init", "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(repo.root, "status", "--porcelain"), before, "预览不能改动任何文件");
    assert.equal(existsSync(join(repo.root, ".harness")), false);
    assert.match(result.stdout, /主分支尚未接入，本次为首次接入/);
    assert.match(result.stdout, /git 钩子目录: frontend\/\.husky（入库，随分支生效）/);
    assert.match(result.stdout, /pre-commit: 原有脚本，保留/);
    assert.match(result.stdout, /reference-transaction 里已有其他工具的主分支保护/);
    assert.match(result.stdout, /legacy\/claude-hook\.mjs/);
    assert.match(result.stdout, /AGENTS\.md 里其他工具的托管块: wisharness/);
    assert.match(result.stdout, /\.gitignore 会忽略入口/);
    assert.match(result.stdout, /可在接入合并后退役的目录.*legacy\//);
    assert.match(result.stdout, /\.wisharness\//);
    assert.match(result.stdout, /新建 \.harness\/config\.json/);
    assert.match(result.stdout, /以上为预览/);
  });

  test("默认保留原有内容；被原有主分支保护拒绝时，合并给出接管的办法", async () => {
    const repo = legacyProject();
    onboard(repo);
    const settings = JSON.parse(readFileSync(join(repo.root, ".claude/settings.json"), "utf8"));
    git(repo.root, "checkout", "-q", "chore/harness-onboard");
    const onBranch = JSON.parse(readFileSync(join(repo.root, ".claude/settings.json"), "utf8"));
    assert.equal(onBranch.hooks.PreToolUse.length, 2, "原有拦截保留，harness 追加在后");
    assert.deepEqual(onBranch.permissions, settings.permissions);
    assert.match(readFileSync(join(repo.root, "frontend/.husky/reference-transaction"), "utf8"), /legacy guard/);
    git(repo.root, "checkout", "-q", "main");

    fakeReviewer(repo, APPROVE);
    assert.equal(repo.rawCli("verify", "--branch", "chore/harness-onboard").status, 0);
    assert.equal(repo.rawCli("review", "--branch", "chore/harness-onboard").status, 0);
    assert.equal(repo.rawCli("confirm", "--branch", "chore/harness-onboard", "--yes").status, 0);
    const merged = repo.rawCli("merge", "--branch", "chore/harness-onboard");
    assert.notEqual(merged.status, 0);
    assert.match(merged.stderr, /bootstrap_update_refused/);
    assert.match(merged.stderr, /--take-over/);
    assert.equal(existsSync(join(repo.root, ".harness/config.json")), false, "被拒绝时主 Worktree 保持原样");
    assert.equal(git(repo.root, "status", "--porcelain", "--", ".", ":(exclude).harness/dsh-plugin"), "");
    assert.equal(git(repo.root, "rev-parse", "main"), git(repo.root, "rev-parse", "chore/harness-onboard~1"));
  });

  test("接管后走完整流程首次接入：验证、评审、人工确认、快进合并", () => {
    const repo = legacyProject();
    const init = onboard(repo, { takeOver: true });
    assert.match(init.stdout, /接管（--take-over）/);

    git(repo.root, "checkout", "-q", "chore/harness-onboard");
    const guard = readFileSync(join(repo.root, "frontend/.husky/reference-transaction"), "utf8");
    assert.doesNotMatch(guard, /legacy guard/, "接管后原有主分支保护被移除");
    const pre = readFileSync(join(repo.root, "frontend/.husky/pre-commit"), "utf8");
    assert.match(pre, /lint-staged/, "pre-commit 里原有脚本始终保留");
    assert.ok(pre.indexOf("# harness:hook") < pre.indexOf("lint-staged"), "harness 块在原有脚本之前");
    const settings = JSON.parse(readFileSync(join(repo.root, ".claude/settings.json"), "utf8"));
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assert.deepEqual(settings.permissions, { allow: ["Bash(git status)"] }, "其他设置原样保留");
    assert.equal(git(repo.root, "ls-files", ".harness/bin/harness"), ".harness/bin/harness", "入口已入库");
    git(repo.root, "checkout", "-q", "main");

    const branch = "chore/harness-onboard";
    const plan = repo.rawCli("verify", "--plan", "--branch", branch);
    assert.equal(plan.status, 0, plan.stderr);
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.rawCli("verify", "--branch", branch).status, 0);
    assert.equal(repo.rawCli("review", "--branch", branch).status, 0);

    const unconfirmed = repo.rawCli("merge", "--branch", branch);
    assert.notEqual(unconfirmed.status, 0);
    assert.match(unconfirmed.stderr, /gate_change_unconfirmed/);
    assert.match(unconfirmed.stderr, /首次接入/);

    const summary = repo.rawCli("confirm", "--branch", branch);
    assert.match(summary.stdout, /首次接入：确认后这份配置成为主分支的门禁信任根/);
    assert.match(summary.stdout, /验证检查 \d+ 项/);
    assert.equal(repo.rawCli("confirm", "--branch", branch, "--yes").status, 0);

    const merged = repo.rawCli("merge", "--branch", branch);
    assert.equal(merged.status, 0, merged.stderr);
    const result = JSON.parse(merged.stdout);
    assert.equal(result.bootstrap, true);
    assert.equal(git(repo.root, "rev-parse", "main"), git(repo.root, "rev-parse", branch));
    assert.equal(git(repo.root, "status", "--porcelain"), "", "合并后主 Worktree 洁净");
    assert.ok(result.followUps.some((note) => /重启正在运行的 Claude Code/.test(note)));
    assert.match(merged.stderr, /合并完成，还需要在客户端做/);

    // 接入后主分支受新门禁保护：直接改主分支被拒绝。
    const target = commitOnBranch(repo, "task/after", { "a.txt": "a\n" });
    const refused = sh(repo.root, "git", ["update-ref", "refs/heads/main", target], repo.env);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /本地主分支只允许由 harness merge 更新/);
  });

  test("首次接入的分支落后主分支时要求先吸收主分支", () => {
    const repo = legacyProject();
    onboard(repo, { takeOver: true });
    // 主分支在接入期间前进：按旧门禁自己的方式（这里用它的令牌）更新。
    write(repo.root, "README.md", "changed\n");
    git(repo.root, "add", "README.md");
    git(repo.root, "commit", "-q", "-m", "docs(readme): 更新\n\n- 改说明\n- 补一行", { ...repo.env, LEGACY_TOKEN: "ok" });
    fakeReviewer(repo, APPROVE);
    const branch = "chore/harness-onboard";
    assert.equal(repo.rawCli("verify", "--branch", branch).status, 0);
    assert.equal(repo.rawCli("review", "--branch", branch).status, 0);
    assert.equal(repo.rawCli("confirm", "--branch", branch, "--yes").status, 0);
    const merged = repo.rawCli("merge", "--branch", branch);
    assert.notEqual(merged.status, 0);
    assert.match(merged.stderr, /bootstrap_not_fast_forward/);
  });

  test("同名数据目录被其他工具占用时改用 harness.d，两边互不混淆", () => {
    const repo = legacyProject();
    const common = git(repo.root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    mkdirSync(join(common, "harness", "evidence"), { recursive: true });
    writeFileSync(join(common, "harness", "ledger.jsonl"), '{"event":"merge","legacy":true}\n');
    const env = { ...repo.env };
    delete env.HARNESS_DATA_DIR;
    const dry = sh(repo.root, process.execPath, [repoCliPath(), "init", "--dry-run"], env);
    assert.match(dry.stdout, /已被其他工具占用：harness 的证据与账本改放同级的 harness\.d/);
    const metrics = sh(repo.root, process.execPath, [repoCliPath(), "metrics"], env);
    assert.equal(metrics.status, 0, metrics.stderr);
    assert.ok(existsSync(join(common, "harness.d", "owner.json")));
    assert.match(readFileSync(join(common, "harness", "ledger.jsonl"), "utf8"), /legacy/, "原有数据原样保留");
  });

  test("Agent 不能代为确认，主分支上的只读 git 命令照常放行", () => {
    const repo = makeRepo();
    repos.push(repo);
    const check = (command) =>
      repo.cli("check", "--kind", "shell", "--command", command, "--on-main");
    assert.notEqual(check(".harness/bin/harness confirm --branch task/x --yes").status, 0);
    assert.equal(check(".harness/bin/harness confirm --branch task/x").status, 0);
    assert.equal(check("git merge-base --is-ancestor task/x main").status, 0);
    assert.notEqual(check("git merge task/x").status, 0);
  });
});

describe("另一台机器使用已接入的项目", () => {
  test("install --local 按项目锁定的版本装本机，不改动入库文件", () => {
    const repo = makeRepo();
    repos.push(repo);
    const store = join(repo.root, "..", "store-other-machine");
    const env = { ...repo.env, HARNESS_STORE: store };
    const before = git(repo.root, "status", "--porcelain");
    const local = sh(repo.root, process.execPath, [repoCliPath(), "install", "--local"], env);
    assert.equal(local.status, 0, local.stderr);
    assert.equal(git(repo.root, "status", "--porcelain"), before);
    assert.ok(existsSync(join(store, JSON.parse(readFileSync(join(repoCliPath(), "..", "..", "package.json"), "utf8")).version, "MANIFEST.json")));
    const version = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["version"], env);
    assert.equal(version.status, 0, version.stderr);
  });

  test("锁定的版本不是当前版本时，从 harness 仓库的标签安装那一版", (t) => {
    const harnessRoot = join(repoCliPath(), "..", "..");
    if (sh(harnessRoot, "git", ["rev-parse", "--verify", "--quiet", "refs/tags/v0.3.0"]).status !== 0) {
      t.skip("harness 仓库里没有标签 v0.3.0");
      return;
    }
    const repo = makeRepo();
    repos.push(repo);
    write(repo.root, ".harness/VERSION", "0.3.0\n");
    const store = join(repo.root, "..", "store-pinned");
    const env = { ...repo.env, HARNESS_STORE: store };
    const local = sh(repo.root, process.execPath, [repoCliPath(), "install", "--local"], env);
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stdout, /已从 harness 仓库的标签 v0\.3\.0 安装/);
    const manifest = JSON.parse(readFileSync(join(store, "0.3.0", "MANIFEST.json"), "utf8"));
    assert.equal(manifest.version, "0.3.0", "装进版本目录的是标签里的代码，不是当前代码");
  });

  test("锁定的版本在本机没有标签时说明怎么办", () => {
    const repo = makeRepo();
    repos.push(repo);
    write(repo.root, ".harness/VERSION", "0.0.1\n");
    const local = repo.rawCli("install", "--local");
    assert.notEqual(local.status, 0);
    assert.match(local.stderr, /没有标签 v0\.0\.1/);
    assert.match(local.stderr, /git fetch --tags/);
  });

  test("publish 不能把当前代码装成别的版本号", () => {
    const repo = makeRepo();
    repos.push(repo);
    const result = repo.rawCli("publish", "--version", "9.9.9");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /不能装成 9\.9\.9/);
  });
});

function repoCliPath() {
  return join(import.meta.dirname, "..", "bin", "harness.mjs");
}

function commitOnBranch(repo, name, files) {
  git(repo.root, "checkout", "-q", "-b", name);
  for (const [rel, content] of Object.entries(files)) write(repo.root, rel, content);
  git(repo.root, "add", "-A");
  git(repo.root, "commit", "-q", "-m", "feat(demo): 示例\n\n- 增加文件\n- 补充说明");
  const head = git(repo.root, "rev-parse", "HEAD");
  git(repo.root, "checkout", "-q", "main");
  return head;
}
