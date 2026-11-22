import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, CONFIG, commit, fakeReviewer, git, makeRepo, sh, write } from "./helpers.mjs";
import { writeObligations } from "../src/verify/obligation.mjs";
import { autoCleanDelivered } from "../src/worktree/clean.mjs";

let repos = [];
let children = [];
afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children = [];
  for (const repo of repos) repo.cleanup();
  repos = [];
});

function setup(config = CONFIG) {
  const repo = makeRepo({ project: { ".harness/config.json": config } });
  repos.push(repo);
  commit(repo.root, "chore: 忽略本机文件\n\n- 忽略依赖与本机配置", { ".gitignore": ".harness/dsh-plugin/\nnode_modules/\n.env\n" });
  return { repo, root: realpathSync(repo.root) };
}

const LONG_AGO = "2026-01-01T00:00:00+0000";

/** 建一个任务 Worktree；commits 为真时在分支上提交一次，merged 为真时把分支快进合入 main，old 为真时把创建时间记成很久以前。 */
function task(repo, root, name, { commits = true, merged = true, old = false } = {}) {
  const path = join(root, "..", name);
  const env = old ? { ...repo.env, GIT_COMMITTER_DATE: LONG_AGO } : repo.env;
  git(repo.root, "worktree", "add", "-q", "-b", `task/${name}`, path, "main", env);
  if (commits) commit(path, `feat(${name}): 改动\n\n- 增加文件`, { [`${name}.txt`]: "x\n" });
  if (commits && merged) git(repo.root, "merge", "-q", "--ff-only", `task/${name}`, { ...repo.env, HARNESS_MAIN_BYPASS: "1" });
  return path;
}

const clean = (repo, ...args) => repo.cli("worktree", "clean", ...args);
const branchExists = (repo, name) => sh(repo.root, "git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], repo.env).status === 0;

describe("harness worktree clean", () => {
  test("预览列出可清理与跳过的 Worktree 及原因，不删除任何东西", () => {
    const { repo, root } = setup();
    const done = task(repo, root, "done");
    task(repo, root, "open", { merged: false });
    const dirty = task(repo, root, "dirty");
    write(dirty, "notes.txt", "未提交\n");
    task(repo, root, "fresh", { commits: false });
    const locked = task(repo, root, "locked");
    git(repo.root, "worktree", "lock", locked);

    const preview = clean(repo);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /可清理 1 个/);
    assert.match(preview.stdout, new RegExp(`${done}.*task/done`));
    assert.match(preview.stdout, /task\/open.*1 个提交没有合入 main/);
    assert.match(preview.stdout, /task\/dirty.*1 个未提交或未跟踪的文件/);
    assert.match(preview.stdout, /task\/fresh.*建好不到 24 小时，还没有新的提交/);
    assert.match(preview.stdout, /task\/locked.*已锁定/);
    assert.match(preview.stdout, /用户在对话中同意安全清理后，由 Agent 执行：harness worktree clean --yes/);
    assert.ok(existsSync(done), "预览不删除");
    assert.ok(branchExists(repo, "task/done"));
  });

  test("没有可清理对象时明确无需继续执行", () => {
    const { repo } = setup();
    const preview = clean(repo);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /无需继续执行：当前没有可清理的 Worktree/);
  });

  test("--yes 删除可清理的 Worktree 与分支，跳过的原样保留，目录已不存在的记录一并清掉", () => {
    const { repo, root } = setup();
    const done = task(repo, root, "done");
    const open = task(repo, root, "open", { merged: false });
    const gone = task(repo, root, "gone");
    sh(root, "rm", ["-r", gone]);

    const preview = clean(repo);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /目录已不存在，只清理记录与分支/);
    assert.match(preview.stdout, /由 Agent 执行：harness worktree clean --yes/);
    const result = clean(repo, "--yes");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(done), false);
    assert.equal(branchExists(repo, "task/done"), false);
    assert.equal(branchExists(repo, "task/gone"), false);
    assert.doesNotMatch(git(repo.root, "worktree", "list"), /gone/);
    assert.ok(existsSync(open));
    assert.ok(branchExists(repo, "task/open"));
    assert.match(result.stdout, /已删除 2 个/);
  });

  test("主 Worktree 与命令所在的 Worktree 不删", () => {
    const { repo, root } = setup();
    const here = task(repo, root, "here");
    const result = sh(here, join(here, ".harness/bin/harness"), ["worktree", "clean", "--yes"], repo.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /task\/here.*命令当前所在的 Worktree/);
    assert.ok(existsSync(here) && existsSync(root));
  });

  test("分离头指针按 HEAD 判断：已在 main 上的可以清理，有提交没合入的保留", () => {
    const { repo, root } = setup();
    const detached = (name, env = repo.env) => {
      const path = join(root, "..", name);
      git(repo.root, "worktree", "add", "-q", "--detach", path, "main", env);
      return path;
    };
    const old = detached("detached-old", { ...repo.env, GIT_COMMITTER_DATE: LONG_AGO });
    const fresh = detached("detached-fresh");
    const ahead = detached("detached-ahead");
    commit(ahead, "feat(x): 没有分支的提交\n\n- 只在这个 Worktree 里", { "x.txt": "x\n" });

    const preview = clean(repo);
    assert.match(preview.stdout, new RegExp(`${old}  \\([0-9a-f]{10}\\)`), "可清理");
    assert.match(preview.stdout, /detached-fresh.*建好不到 24 小时/);
    assert.match(preview.stdout, /detached-ahead.*1 个提交没有合入 main/);
    clean(repo, "--yes");
    assert.equal(existsSync(old), false);
    assert.ok(existsSync(fresh) && existsSync(ahead));
  });

  test("很久以前建好、一直没有提交的任务 Worktree 可以清理", () => {
    const { repo, root } = setup();
    const stale = task(repo, root, "stale", { commits: false, old: true });
    const result = clean(repo, "--yes");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(stale), false);
    assert.equal(branchExists(repo, "task/stale"), false);
  });

  test("有进程停在里面的 Worktree 不删", (t) => {
    if (sh("/", "sh", ["-c", "command -v lsof"]).status !== 0 && !existsSync("/proc/self/cwd")) {
      t.skip("本机无法查看进程的工作目录");
      return;
    }
    const { repo, root } = setup();
    const busy = task(repo, root, "busy");
    const child = spawn("sleep", ["30"], { cwd: busy, stdio: "ignore" });
    children.push(child);
    const result = clean(repo, "--yes");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`task/busy.*进程 ${child.pid}`));
    assert.ok(existsSync(busy));
  });

  test("被忽略的本机配置默认不删，--with-local-files 才删；依赖目录这类被忽略的内容照常删除", () => {
    const { repo, root } = setup();
    const local = task(repo, root, "local");
    write(local, ".env", "TOKEN=local\n");
    const deps = task(repo, root, "deps");
    write(deps, "node_modules/a/index.js", "x\n");

    const preview = clean(repo);
    assert.match(preview.stdout, /task\/local.*本机文件 \.env/);
    assert.match(preview.stdout, /task\/deps/);
    assert.doesNotMatch(preview.stdout, /task\/deps.*跳过/);

    clean(repo, "--yes");
    assert.ok(existsSync(local), "默认保留含本机配置的 Worktree");
    assert.equal(existsSync(deps), false);

    const localPreview = clean(repo, "--with-local-files");
    assert.match(localPreview.stdout, /用户在对话中明确同意删除本机文件后，由 Agent 执行：harness worktree clean --yes --with-local-files/);
    const forced = clean(repo, "--yes", "--with-local-files");
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(existsSync(local), false);
  });

  test("删除前在 Worktree 里运行项目的清理命令，失败就跳过并保留", () => {
    const config = {
      ...CONFIG,
      worktree: {
        cleanup: [
          ["sh", "-c", 'printf "%s|%s|%s|%s\\n" "$PWD" "$1" "$2" "$HARNESS_BRANCH" >> "$2/../cleanup.log"; test ! -f stop-fails', "_", "{main}", "{worktree}"],
        ],
      },
    };
    const { repo, root } = setup(config);
    const ok = task(repo, root, "ok");
    const bad = task(repo, root, "bad");
    write(bad, "stop-fails", "");
    commit(bad, "chore(bad): 标记\n\n- 让清理命令失败", {});
    git(repo.root, "merge", "-q", "--ff-only", "task/bad", { ...repo.env, HARNESS_MAIN_BYPASS: "1" });

    const preview = clean(repo);
    assert.match(preview.stdout, /删除前在每个 Worktree 里依次运行/);
    assert.equal(existsSync(join(root, "..", "cleanup.log")), false, "预览不运行清理命令");

    const result = clean(repo, "--yes");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(ok), false);
    assert.ok(existsSync(bad), "清理命令失败的保留");
    assert.match(result.stdout, /task\/bad.*清理命令失败/);
    const lines = readFileSync(join(root, "..", "cleanup.log"), "utf8").trim().split("\n");
    assert.ok(lines.includes(`${ok}|${root}|${ok}|task/ok`), lines.join("\n"));
  });

  test("批量清理中后续对象变脏时自动保留，且不再运行它的关联清理命令", () => {
    const config = {
      ...CONFIG,
      worktree: {
        cleanup: [["sh", "-c", 'printf "%s\\n" "$HARNESS_BRANCH" >> "$1/../cleanup.log"; if [ "$HARNESS_BRANCH" = task/first ]; then printf "new\\n" > "$1/../second/notes.txt"; fi', "_", "{main}"]],
      },
    };
    const { repo, root } = setup(config);
    const first = task(repo, root, "first");
    const second = task(repo, root, "second");

    const result = clean(repo, "--yes");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(first), false, result.stdout + result.stderr);
    assert.ok(existsSync(second), "后续对象出现未提交文件后应保留");
    const lines = readFileSync(join(root, "..", "cleanup.log"), "utf8").trim().split("\n");
    assert.deepEqual(lines, ["task/first"], "变脏对象不应再执行关联清理命令");
    assert.match(result.stdout, /task\/second.*1 个未提交或未跟踪的文件/);
  });

  test("关联清理命令新生成本机文件时，未授权的对象不会被删除", () => {
    const config = { ...CONFIG, worktree: { cleanup: [["sh", "-c", 'printf "TOKEN=local\\n" > .env', "_"]] } };
    const { repo, root } = setup(config);
    const first = task(repo, root, "first");
    const second = task(repo, root, "second");

    const result = clean(repo, "--yes");
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(first), "清理命令产生的 .env 不能被静默删除");
    assert.ok(existsSync(second), "后续对象同样保留");
    assert.match(result.stdout, /含有本机文件 \.env/);
  });

  test("删除时逐个输出进度与结果，预览开始时说明正在检查", () => {
    const { repo, root } = setup();
    task(repo, root, "one");
    task(repo, root, "two");
    const preview = clean(repo);
    assert.match(preview.stderr, /正在检查 2 个 Linked Worktree/);
    const result = clean(repo, "--yes");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /\[1\/2\] .*one.*task\/one/);
    assert.match(result.stderr, /\[2\/2\] .*two.*task\/two/);
    assert.match(result.stderr, /已删除，分支已删除（\d+(\.\d)?s）/);
  });

  test("Ctrl-C 后处理完当前 Worktree 再停下，不留下删到一半的目录", async () => {
    const config = {
      ...CONFIG,
      worktree: { cleanup: [["sh", "-c", 'touch "$1/../started-$(basename "$1")"; sleep 1', "_", "{worktree}"]] },
    };
    const { repo, root } = setup(config);
    const names = ["a", "b", "c"];
    const paths = names.map((name) => task(repo, root, name));
    const marker = (name) => join(root, "..", `started-${name}`);
    // 和终端里按 Ctrl-C 一样，把 SIGINT 发给整个前台进程组：命令本身与它启动的子进程都会收到。
    const child = spawn(join(repo.root, ".harness/bin/harness"), ["worktree", "clean", "--yes"], {
      cwd: repo.root,
      env: { ...process.env, ...repo.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const started = Date.now();
    while (!existsSync(marker("a")) && Date.now() - started < 20_000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(marker("a")), "第一个 Worktree 的清理命令应已开始");
    process.kill(-child.pid, "SIGINT");
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 130, stdout + stderr);
    assert.match(stderr, /收到中断，处理完当前 Worktree 后停止/);
    assert.equal(existsSync(paths[0]), false, "当前这个照常删完");
    assert.equal(branchExists(repo, "task/a"), false);
    assert.ok(existsSync(paths[1]) && existsSync(paths[2]), "后面的不再处理");
    assert.match(stdout, /已删除 1 个/);
    assert.match(stdout, /已中断，还有 2 个没有处理/);
  });

  test("autoClean 开启时合并只自动清理本次任务，其他 Worktree 保留", () => {
    const config = { ...CONFIG, worktree: { cleanup: [], autoClean: true } };
    const { repo, root } = setup(config);
    const target = task(repo, root, "target", { merged: false });
    const other = task(repo, root, "other");
    fakeReviewer(repo, APPROVE);
    for (const step of ["verify", "review"]) assert.equal(repo.cli(step, "--branch", "task/target").status, 0);
    const merged = repo.cli("merge", "--branch", "task/target");
    assert.equal(merged.status, 0, merged.stderr);
    assert.equal(existsSync(target), false, "本次任务自动清理");
    assert.ok(existsSync(other), "其他任务不在本次自动清理范围内");
    assert.ok(branchExists(repo, "task/other"));
    assert.match(merged.stderr, /自动清理/);
  });

  test("autoClean 遇到未到期的清理条件或合并后义务时保留", async () => {
    const config = { ...CONFIG, worktree: { cleanup: [], autoClean: true } };
    const { repo, root } = setup(config);
    const path = task(repo, root, "pending");
    const tip = git(repo.root, "rev-parse", "task/pending");
    writeObligations({ root, branch: "task/pending", tip, items: [{ id: "smoke", howToVerify: "合并后冒烟", when: ["src/**"] }] });
    const outcome = await autoCleanDelivered({ cwd: root, branch: "task/pending", mainRef: "main", log: () => {} });
    assert.equal(outcome.status, "skipped");
    assert.ok(existsSync(path));
    assert.ok(branchExists(repo, "task/pending"));
  });

  test("合并后保留任务 Worktree，并提示可以清理；doctor 报告已合并未清理的数量", () => {
    const { repo, root } = setup();
    const path = task(repo, root, "landing", { merged: false });
    fakeReviewer(repo, APPROVE);
    for (const step of ["verify", "review"]) assert.equal(repo.cli(step, "--branch", "task/landing").status, 0);
    const merged = repo.cli("merge", "--branch", "task/landing");
    assert.equal(merged.status, 0, merged.stderr);
    assert.ok(existsSync(path), "合并不删除任务 Worktree");
    assert.match(merged.stderr, /已合并但还没清理的 Worktree 有 1 个/);
    assert.match(merged.stderr, /harness worktree clean/);
    assert.match(repo.cli("doctor").stdout, /worktrees: 已合并但还没清理的 Worktree 1 个/);
  });
});
