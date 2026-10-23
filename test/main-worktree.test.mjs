import { strict as assert } from "node:assert";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, commit, fakeReviewer, git, makeRepo, sh, write } from "./helpers.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

const BASIC = "feat(demo): 增加示例\n\n- 增加一个文件\n- 补充说明";

const POLICY = {
  version: 1,
  presets: ["secrets", "git-safety", "gate-self", "main-worktree"],
  disabled: [],
  rules: [],
};

/**
 * 启用 main-worktree 预设的仓库，并在主 Worktree 目录下建一个 Linked Worktree，
 * 模拟 Claude Code 把任务 Worktree 放在 .claude/worktrees/ 里、会话却停在主 Worktree 的情形。
 */
function setup() {
  const repo = makeRepo({ project: { ".harness/policy.json": POLICY } });
  repos.push(repo);
  commit(repo.root, "chore: 忽略任务 Worktree\n\n- 任务 Worktree 放在仓库目录下\n- 不计入主 Worktree 状态", {
    ".gitignore": ".harness/dsh-plugin/\n.claude/worktrees/\n",
  });
  // 临时目录在 macOS 上经过 /var 到 /private/var 的软链，钩子给出的落点是真实路径。
  const root = realpathSync(repo.root);
  const linked = join(root, ".claude/worktrees/task-a");
  git(repo.root, "worktree", "add", "-q", "-b", "task/a", linked, "main");
  return { repo, root, linked };
}

function claudeHook(repo, payload) {
  return sh(repo.root, join(repo.root, ".harness/bin/harness"), ["hook", "--client", "claude"], repo.env, JSON.stringify(payload));
}
const writeCall = (cwd, file) => ({ tool_name: "Write", tool_input: { file_path: file, content: "x\n" }, cwd });
const bashCall = (cwd, command) => ({ tool_name: "Bash", tool_input: { command }, cwd });

describe("主 Worktree 只用来合并", () => {
  test("会话停在主 Worktree 时，改主 Worktree 被拒，改 Linked Worktree 与本机忽略文件放行", () => {
    const { repo, root, linked } = setup();
    const refused = claudeHook(repo, writeCall(root, join(root, "src/app.js")));
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /main-worktree-edit/);
    assert.match(refused.stderr, /git worktree add/);

    assert.equal(claudeHook(repo, writeCall(root, join(linked, "src/app.js"))).status, 0, "嵌在主 Worktree 目录下的 Linked Worktree 照常可改");
    assert.equal(claudeHook(repo, writeCall(root, join(root, ".harness/dsh-plugin/x.json"))).status, 0, "被忽略的本机文件不影响合并");
    assert.equal(claudeHook(repo, writeCall(root, join(root, "..", "scratch.txt"))).status, 0, "仓库之外的文件不受限制");
  });

  test("路径规则按落点所在的 Worktree 判定，嵌套的 Linked Worktree 里的入口照样受保护", () => {
    const { repo, root, linked } = setup();
    const entry = claudeHook(repo, writeCall(root, join(linked, ".harness/bin/harness")));
    assert.equal(entry.status, 2);
    assert.match(entry.stderr, /protect-executor-entry/);
  });

  test("会话停在 Linked Worktree 时，改主 Worktree 的文件同样被拒", () => {
    const { repo, root, linked } = setup();
    const refused = claudeHook(repo, writeCall(linked, join(root, "README.md")));
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /main-worktree-edit/);
    assert.equal(claudeHook(repo, writeCall(linked, join(linked, "README.md"))).status, 0);
  });

  test("主 Worktree 不能切离主分支，在 Linked Worktree 里执行的命令按那里判定", () => {
    const { repo, root, linked } = setup();
    const refused = claudeHook(repo, bashCall(root, "git switch -c task/b"));
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /main-worktree-leave-main/);
    assert.equal(claudeHook(repo, bashCall(root, `cd ${linked} && git switch -c task/b`)).status, 0);
    assert.equal(claudeHook(repo, bashCall(root, `git -C "${linked}" switch -c task/c`)).status, 0);
    assert.equal(claudeHook(repo, bashCall(linked, "git switch -c task/d")).status, 0, "会话本身在 Linked Worktree");
    assert.equal(claudeHook(repo, bashCall(root, "git switch main")).status, 0);
    assert.equal(claudeHook(repo, bashCall(root, `git worktree add -b task/e ${join(root, ".claude/worktrees/task-e")} main`)).status, 0);
  });

  test("提交只能在 Linked Worktree 里发生，主 Worktree 被切到任务分支后的提交也被 git 层拦下", () => {
    const { repo, linked } = setup();
    write(linked, "a.txt", "a\n");
    git(linked, "add", "a.txt", repo.env);
    const ok = sh(linked, "git", ["commit", "-q", "-m", BASIC], repo.env);
    assert.equal(ok.status, 0, ok.stderr);

    git(repo.root, "checkout", "-q", "-b", "task/in-main");
    write(repo.root, "b.txt", "b\n");
    git(repo.root, "add", "b.txt");
    const before = git(repo.root, "rev-parse", "HEAD");
    const refused = sh(repo.root, "git", ["commit", "-q", "-m", BASIC], repo.env);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /main-worktree-commit/);
    assert.equal(git(repo.root, "rev-parse", "HEAD"), before);
  });

  test("启用后 harness merge 照常更新主分支：快进与三方合并都不经过被拦的提交", () => {
    const { repo, root, linked } = setup();
    const other = join(root, ".claude/worktrees/task-b");
    git(repo.root, "worktree", "add", "-q", "-b", "task/b", other, "main");
    for (const [dir, file] of [[linked, "a.txt"], [other, "b.txt"]]) {
      write(dir, file, `${file}\n`);
      git(dir, "add", file, repo.env);
      const made = sh(dir, "git", ["commit", "-q", "-m", BASIC], repo.env);
      assert.equal(made.status, 0, made.stderr);
    }

    fakeReviewer(repo, APPROVE);
    for (const branch of ["task/a", "task/b"]) {
      assert.equal(repo.rawCli("verify", "--branch", branch).status, 0);
      assert.equal(repo.rawCli("review", "--branch", branch).status, 0);
      const merged = repo.rawCli("merge", "--branch", branch);
      assert.equal(merged.status, 0, merged.stderr);
    }
    const parents = git(repo.root, "rev-list", "--parents", "-n", "1", "main").split(" ");
    assert.equal(parents.length, 3, "第二个分支以三方合并合入");
    assert.equal(git(repo.root, "symbolic-ref", "--short", "HEAD"), "main");
    assert.equal(git(repo.root, "status", "--porcelain"), "", "合并后主 Worktree 洁净");
  });

  test("status 与 doctor 提前指出主 Worktree 未就绪，不必等到合并时才发现", () => {
    const { repo, linked } = setup();
    write(linked, "a.txt", "a\n");
    // Linked Worktree 的路径是真实路径，辅助函数按仓库根目录找不到隔离环境，显式传入。
    git(linked, "add", "a.txt", repo.env);
    git(linked, "commit", "-q", "-m", BASIC, repo.env);

    const clean = repo.cli("status", "--branch", "task/a");
    assert.match(clean.stdout, /\[ok\] main-worktree/);

    write(repo.root, "stray.txt", "x\n");
    const dirty = repo.cli("status", "--branch", "task/a");
    assert.match(dirty.stdout, /\[FAIL\] main-worktree: 主 Worktree 存在未提交或未跟踪文件/);
    assert.match(dirty.stdout, /主 Worktree 未就绪/);
    const report = repo.cli("doctor");
    assert.match(report.stdout, /\[!!\] main-worktree: .*stray\.txt/s);
  });
});
