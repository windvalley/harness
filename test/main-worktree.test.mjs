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

  test("一条命令里先去 Linked Worktree 再回主 Worktree，后面的段按主 Worktree 判定", () => {
    const { repo, root, linked } = setup();
    const back = claudeHook(repo, bashCall(root, `cd ${linked} && git status; cd ${root} && git switch -c task/b`));
    assert.equal(back.status, 2, "回到主 Worktree 之后的切分支要拦");
    assert.match(back.stderr, /main-worktree-leave-main/);
    const fromLinked = claudeHook(repo, bashCall(linked, `cd ${root} && git switch -c task/c`));
    assert.equal(fromLinked.status, 2, "会话在 Linked Worktree，命令却去主 Worktree 切分支");
  });

  test("子 shell 里的 cd 不影响后面的段", () => {
    const { repo, root, linked } = setup();
    const refused = claudeHook(repo, bashCall(root, `(cd ${linked} && git status); git switch -c task/b`));
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /main-worktree-leave-main/);
    assert.equal(claudeHook(repo, bashCall(root, `(cd ${linked} && git switch -c task/b)`)).status, 0);
  });

  test("无法确定在哪执行的段按最严格处理", () => {
    const { repo, root, linked } = setup();
    for (const command of [
      `cd "$TARGET" && git switch -c task/b`,
      `cd ${linked} | cat; git switch -c task/c`,
      `cd ${join(linked, "missing")} ; git switch -c task/d`,
      `GIT_DIR=${linked}/.git git switch -c task/e`,
    ]) {
      const refused = claudeHook(repo, bashCall(linked, command));
      assert.equal(refused.status, 2, command);
      assert.match(refused.stderr, /main-worktree-leave-main/, command);
      assert.match(refused.stderr, /无法确定这段命令在哪个目录执行/, command);
    }
    const certain = claudeHook(repo, bashCall(root, "git switch -c task/f"));
    assert.equal(certain.status, 2);
    assert.doesNotMatch(certain.stderr, /无法确定/, "确定在主 Worktree 时不附加说明");
  });
  test("用 Shell 重定向与常见写文件命令改主 Worktree 同样被拒，按实际写入目标判定", () => {
    const { repo, root, linked } = setup();
    const inRoot = [
      "echo x > README.md",
      "echo x >> src/app.js",
      "printf x | tee README.md",
      "sed -i 's/a/b/' README.md",
      "cp /etc/hosts README.md",
      "mv a.txt b.txt",
      "touch new.txt",
      "rm README.md",
      "mkdir -p src/new",
      "dd if=/dev/zero of=README.md count=1",
      "find . -name '*.js' -delete",
      "git apply fix.patch",
      `cd ${root}/src && echo x > app.js`,
    ];
    for (const command of inRoot) {
      const refused = claudeHook(repo, bashCall(root, command));
      assert.equal(refused.status, 2, command);
      assert.match(refused.stderr, /main-worktree-edit/, command);
    }
    const fromLinked = [
      `echo x > ${root}/README.md`,
      `cp a.txt ${root}/README.md`,
      `cd ${root} && touch x.txt`,
      `echo x > ${root}/.claude/../README.md`,
    ];
    for (const command of fromLinked) {
      const refused = claudeHook(repo, bashCall(linked, command));
      assert.equal(refused.status, 2, command);
      assert.match(refused.stderr, /main-worktree-edit/, command);
    }
  });

  test("Shell 写入的正常任务、忽略文件与仓库之外的位置照常放行", () => {
    const { repo, root, linked } = setup();
    const fine = [
      [linked, "echo x > README.md"],
      [linked, `echo x >> src/app.js && sed -i 's/a/b/' src/app.js && cp a.txt b.txt`],
      [linked, "ls 2>&1 >/dev/null"],
      [linked, "echo x > /tmp/harness-scratch.txt"],
      [linked, "cat <<EOF > notes.txt\na > b\nEOF"],
      [root, `echo x > ${root}/.harness/dsh-plugin/x.json`],
      [root, `cd ${linked} && echo x > README.md`],
      [root, `echo x > ${linked}/README.md`],
      [root, "echo x > ../scratch.txt"],
      [root, "git status && ls -la"],
      [root, "python3 tools/gen.py"],
      [root, "python3 -m pytest -q"],
      [root, "python3 --version"],
      [root, `cd ${linked} && python3 -c "print(1)"`],
      [linked, `python3 - <<'PY'\nopen('a.txt','w').write('x')\nPY`],
      [linked, `node -e "console.log(1)"`],
    ];
    for (const [cwd, command] of fine) {
      const result = claudeHook(repo, bashCall(cwd, command));
      assert.equal(result.status, 0, `${command}\n${result.stderr}`);
    }
  });

  test("解释器行内脚本无法确定写入目标：在主 Worktree 里一律拒，在别处引用主 Worktree 路径时拒", () => {
    const { repo, root, linked } = setup();
    const script = (target) => `python3 - <<'PY'\nopen('${target}', 'w').write('x')\nPY`;
    const inRoot = [script("README.md"), `python3 -c "open('README.md','w')"`, `node -e "require('fs').writeFileSync('README.md','x')"`, `ruby -e 'File.write("README.md","x")'`, `echo "print(1)" | python3`, `python3 <<EOF\nprint(1)\nEOF`];
    for (const command of inRoot) {
      const refused = claudeHook(repo, bashCall(root, command));
      assert.equal(refused.status, 2, command);
      assert.match(refused.stderr, /main-worktree-edit/, command);
      assert.match(refused.stderr, /无法确定写入目标/, command);
    }
    const refused = claudeHook(repo, bashCall(linked, script(join(root, "README.md"))));
    assert.equal(refused.status, 2, "从 Linked Worktree 用绝对路径写回主 Worktree");
    assert.match(refused.stderr, /main-worktree-edit/);
    assert.equal(claudeHook(repo, bashCall(linked, script(join(linked, "README.md")))).status, 0, "写自己的 Worktree 放行");
    assert.equal(claudeHook(repo, bashCall(linked, script(join(root, ".harness/dsh-plugin/x.json")))).status, 0, "引用主 Worktree 里被忽略的文件放行");
  });

  test("写入目标无法静态确定时：停在主 Worktree 按最严格处理，Linked Worktree 里放行", () => {
    const { repo, root, linked } = setup();
    const refused = claudeHook(repo, bashCall(root, 'echo x > "$OUT"'));
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /main-worktree-edit/);
    assert.equal(claudeHook(repo, bashCall(linked, 'echo x > "$OUT"')).status, 0);
    assert.equal(claudeHook(repo, bashCall(linked, 'cd "$X" && echo x > a.txt')).status, 2, "目录不确定时按最严格");
  });

  test("Codex 的 exec_command 走同一套判定", () => {
    const { repo, root, linked } = setup();
    const codex = (cwd, cmd) =>
      sh(repo.root, join(repo.root, ".harness/bin/harness"), ["hook", "--client", "codex"], repo.env, JSON.stringify({ tool_name: "exec_command", tool_input: { cmd }, cwd }));
    const script = (target) => `python3 - <<'PY'\nopen('${target}', 'w').write('x')\nPY`;
    assert.match(codex(root, script("README.md")).stdout, /main-worktree-edit/);
    assert.match(codex(linked, script(join(root, "README.md"))).stdout, /main-worktree-edit/);
    assert.equal(codex(linked, script("README.md")).stdout.trim(), "", "写自己的 Worktree 放行");
  });

  test("未启用 main-worktree 时 Shell 写入照常放行；自定义 write-protect 不带 includeShell 仍只管写文件工具", () => {
    const repo = makeRepo({
      project: {
        ".harness/policy.json": {
          version: 1,
          presets: ["secrets", "git-safety", "gate-self"],
          disabled: [],
          rules: [{ id: "no-docs-edit", kind: "write-protect", paths: ["docs/**"], reason: "文档只读", fix: "换个位置" }],
        },
      },
    });
    repos.push(repo);
    const root = realpathSync(repo.root);
    const fine = [
      "echo x > README.md",
      "echo x > docs/a.md",
      "sed -i 's/a/b/' README.md",
      "cp a.txt b.txt && mv b.txt c.txt && touch d.txt && rm d.txt",
      "python3 -c \"open('README.md','w')\"",
      `python3 - <<'PY'\nopen('README.md', 'w').write('x')\nPY`,
      'echo x > "$OUT"',
    ];
    for (const command of fine) {
      const result = claudeHook(repo, bashCall(root, command));
      assert.equal(result.status, 0, `${command}\n${result.stderr}`);
    }
    const refused = claudeHook(repo, writeCall(root, join(root, "docs/a.md")));
    assert.equal(refused.status, 2, "写文件工具仍受自定义写保护约束");
    assert.match(refused.stderr, /no-docs-edit/);
  });
});
