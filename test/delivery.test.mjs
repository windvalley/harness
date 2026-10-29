import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVE, CONFIG, PACKAGE_ROOT, commit, fakeReviewer, git, makeRepo, sh, write, writeReview } from "./helpers.mjs";
import { packageVersion } from "../src/install/managed.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

const GITHUB = { mode: "remote", remote: "origin", provider: "github" };
const GITLAB = { mode: "remote", remote: "origin", provider: "gitlab" };

function setup({ delivery, config = {}, ...opts } = {}) {
  const repo = makeRepo({
    ...opts,
    project: { ".harness/config.json": { ...CONFIG, ...config, ...(delivery ? { delivery } : {}) }, ...(opts.project ?? {}) },
  });
  repos.push(repo);
  return repo;
}

// 远程地址写成平台地址，由 url.insteadOf 把 git 的读写重定向到本地裸仓库：
// harness 从配置原值识别平台仓库，git 推送与取得仍走真实的本地仓库，不联网。
const PLATFORM_URL = "https://code.example.com/acme/demo.git";

/** 本地裸仓库充当远程，推送与取得都走真实的 git。 */
function withRemote(repo) {
  const remote = join(repo.root, "..", "remote.git");
  const created = sh(join(repo.root, ".."), "git", ["init", "-q", "--bare", "-b", "main", remote], repo.env);
  assert.equal(created.status, 0, created.stderr);
  git(repo.root, "remote", "add", "origin", PLATFORM_URL);
  git(repo.root, "config", `url.${remote}.insteadOf`, PLATFORM_URL);
  git(repo.root, "push", "-q", "origin", "main");
  return remote;
}

function remoteRef(remote, ref) {
  const result = sh(remote, "git", ["--git-dir", remote, "rev-parse", "--verify", "--quiet", ref]);
  return result.status === 0 ? result.stdout.trim() : null;
}

/** 模拟平台上把主分支快进到某个已推送的提交。 */
function platformFastForward(remote, sha) {
  const result = sh(remote, "git", ["--git-dir", remote, "update-ref", "refs/heads/main", sha]);
  assert.equal(result.status, 0, result.stderr);
}

let cloneSeq = 0;
/** 模拟其他人在平台上合入的提交：另开一个克隆提交后推送到远程主分支，返回新提交。 */
function remoteCommit(repo, remote, files, message = "feat(other): 平台合入\n\n- 其他人的改动\n- 已在平台合并") {
  const dir = join(repo.root, "..", `clone-${cloneSeq++}`);
  const cloned = sh(join(repo.root, ".."), "git", ["clone", "-q", remote, dir]);
  assert.equal(cloned.status, 0, cloned.stderr);
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  const id = ["-c", "user.name=other", "-c", "user.email=other@example.com", "-c", "commit.gpgsign=false"];
  for (const args of [["add", "-A"], [...id, "commit", "-q", "-m", message], ["push", "-q", "origin", "main"]]) {
    const result = sh(dir, "git", args);
    assert.equal(result.status, 0, result.stderr);
  }
  return sh(dir, "git", ["rev-parse", "HEAD"]).stdout.trim();
}

const FAKE_PLATFORM = (stateFile, logFile) => `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const bin = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ bin, args }) + "\\n");
const state = existsSync(${JSON.stringify(stateFile)}) ? JSON.parse(readFileSync(${JSON.stringify(stateFile)}, "utf8")) : { next: 1, items: [] };
const save = () => writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state, null, 2));
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const stdin = () => readFileSync(0, "utf8");
const action = args[1];
if ((process.env.FAKE_PLATFORM_FAIL || "").split(",").includes(action)) {
  process.stderr.write(bin + " " + action + ": 认证失败或网络不可用\\n");
  process.exit(1);
}
if (bin === "gh" && args[0] === "pr") {
  if (action === "list") {
    const items = state.items.filter((i) => i.state === "open" && i.head === opt("--head") && i.base === opt("--base"));
    process.stdout.write(JSON.stringify(items.map((i) => ({ number: i.id, url: i.url, body: i.body, state: "OPEN", headRefName: i.head, isCrossRepository: Boolean(i.fork) }))));
  } else if (action === "create") {
    const id = state.next++;
    const url = "https://github.example/acme/demo/pull/" + id;
    state.items.push({ id, url, repo: opt("--repo"), head: opt("--head"), base: opt("--base"), title: opt("--title"), body: opt("--body-file") === "-" ? stdin() : "", state: "open" });
    save();
    process.stdout.write(url + "\\n");
  } else if (action === "edit") {
    const item = state.items.find((i) => String(i.id) === args[2]);
    item.body = opt("--body-file") === "-" ? stdin() : item.body;
    save();
    process.stdout.write(item.url + "\\n");
  } else process.exit(2);
} else if (bin === "glab" && args[0] === "mr") {
  if (action === "list") {
    // 真实 glab 默认输出文本，只有 --output json 才是 JSON。
    if (opt("--output") !== "json") {
      process.stdout.write("Showing 1 open merge request on acme/demo\\n\\n!1  task/a  (main) <- (task/a)\\n");
      process.exit(0);
    }
    const items = state.items.filter((i) => i.state === "open" && i.head === opt("--source-branch") && i.base === opt("--target-branch"));
    process.stdout.write(JSON.stringify(items.map((i) => ({ iid: i.id, web_url: i.url, description: i.body, state: "opened", source_branch: i.head, source_project_id: i.fork ? 99 : 7, target_project_id: 7 }))));
  } else if (action === "create") {
    const id = state.next++;
    const url = "https://gitlab.example/acme/demo/-/merge_requests/" + id;
    state.items.push({ id, url, repo: opt("--repo"), head: opt("--source-branch"), base: opt("--target-branch"), title: opt("--title"), body: opt("--description"), state: "open" });
    save();
    process.stdout.write(url + "\\n");
  } else if (action === "update") {
    const item = state.items.find((i) => String(i.id) === args[2]);
    item.body = opt("--description");
    save();
    process.stdout.write(item.url + "\\n");
  } else process.exit(2);
} else process.exit(2);
`;

/** 假的 gh 与 glab：按参数维护 PR/MR 状态，记录每次调用，FAKE_PLATFORM_FAIL 指定的动作失败。 */
function fakePlatform(repo) {
  const base = join(repo.root, "..");
  const dir = join(base, "platform-bin");
  mkdirSync(dir, { recursive: true });
  const stateFile = join(base, "platform.json");
  const logFile = join(base, "platform-calls.jsonl");
  for (const name of ["gh", "glab"]) {
    writeFileSync(join(dir, name), FAKE_PLATFORM(stateFile, logFile));
    chmodSync(join(dir, name), 0o755);
  }
  repo.env.PATH = `${dir}:${process.env.PATH}`;
  return {
    items: () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")).items : []),
    calls: () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []),
    edit(fn) {
      const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { next: 1, items: [] };
      fn(state);
      writeFileSync(stateFile, JSON.stringify(state, null, 2));
    },
  };
}

/** 只含 git、node 和系统基础命令的 PATH，用来模拟平台命令没有安装。 */
function barePath(repo) {
  const dir = join(repo.root, "..", "bare-bin");
  mkdirSync(dir, { recursive: true });
  const gitBin = sh(repo.root, "sh", ["-c", "command -v git"]).stdout.trim();
  for (const [name, target] of [["git", gitBin], ["node", process.execPath]]) {
    writeFileSync(join(dir, name), `#!/bin/sh\nexec ${JSON.stringify(target)} "$@"\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return `${dir}:/usr/bin:/bin`;
}

function task(repo, name = "task/a", files = { "src/a.js": "a\n" }) {
  const head = repo.branch(name, files);
  writeReview(repo, head, "approve");
  return head;
}

/** 在已有任务分支上再提交一次，返回新提交。 */
function extend(repo, name, files, message = "fix(demo): 补充\n\n- 再改一处\n- 补充说明") {
  git(repo.root, "checkout", "-q", name);
  const head = commit(repo.root, message, files);
  git(repo.root, "checkout", "-q", "main");
  return head;
}

function setDelivery(repo, branch, delivery, extra = {}) {
  git(repo.root, "checkout", "-q", "-b", branch);
  const config = JSON.parse(readFileSync(join(repo.root, ".harness/config.json"), "utf8"));
  const next = { ...config, ...extra };
  if (delivery === null) delete next.delivery;
  else next.delivery = delivery;
  const head = commit(repo.root, "chore(harness): 调整交付方式\n\n- 修改 delivery 配置\n- 合并前由人确认", {
    ".harness/config.json": `${JSON.stringify(next, null, 2)}\n`,
  });
  git(repo.root, "checkout", "-q", "main");
  writeReview(repo, head, "approve");
  return head;
}

const output = (result) => `${result.stdout}\n${result.stderr}`;

describe("配置与默认行为", () => {
  test("R2 远程交付模式下 harness merge 拒绝，主分支不变", () => {
    const repo = setup({ delivery: GITHUB });
    task(repo);
    const before = git(repo.root, "rev-parse", "main");
    const result = repo.cli("merge", "--branch", "task/a");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /delivery_remote/);
    assert.match(result.stderr, /harness submit --branch task\/a/);
    assert.equal(git(repo.root, "rev-parse", "main"), before);
  });

  test("R9 改了交付方式时即使关闭门禁确认也要人工确认；只写出缺省的 local 不要求确认", () => {
    const repo = setup({ config: { governance: { confirmOnGateChange: false, gatePaths: [] } } });
    setDelivery(repo, "chore/explicit-local", { mode: "local" });
    const explicit = repo.cli("merge", "--branch", "chore/explicit-local");
    assert.equal(explicit.status, 0, explicit.stderr);

    setDelivery(repo, "chore/enable", GITHUB);
    const refused = repo.cli("merge", "--branch", "chore/enable");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /gate_change_unconfirmed/);
    assert.match(refused.stderr, /合并前确认一次/);
    assert.match(refused.stderr, /确认后重新运行 harness merge --branch chore\/enable/);
    assert.match(refused.stderr, /交付设置/);
    assert.equal(repo.cli("confirm", "--branch", "chore/enable", "--yes").status, 0);
    const merged = repo.cli("merge", "--branch", "chore/enable");
    assert.equal(merged.status, 0, merged.stderr);
  });

  test("R15 init 生成的配置写明本地交付；已有配置的项目 init 与 upgrade 不添加交付设置", () => {
    const fresh = makeRepo({ install: false, project: { ".harness/config.json": null, ".harness/policy.json": null, ".harness/verify.json": null } });
    repos.push(fresh);
    const init = fresh.rawCli("init");
    assert.equal(init.status, 0, init.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(fresh.root, ".harness/config.json"), "utf8")).delivery, { mode: "local" });

    const existing = setup();
    assert.equal(existing.rawCli("init").status, 0);
    assert.equal(existing.cli("upgrade").status, 0);
    assert.equal("delivery" in JSON.parse(readFileSync(join(existing.root, ".harness/config.json"), "utf8")), false);
  });

  test("R14 托管块、规则与预设提示说明两种交付方式", () => {
    const fresh = makeRepo({ install: false, project: { ".harness/config.json": null, ".harness/policy.json": null, ".harness/verify.json": null } });
    repos.push(fresh);
    assert.equal(fresh.rawCli("init").status, 0);
    const agents = readFileSync(join(fresh.root, "AGENTS.md"), "utf8");
    const block = agents.slice(agents.indexOf("<!-- harness:start -->"), agents.indexOf("<!-- harness:end -->"));
    assert.match(block, /harness merge --branch/);
    assert.match(block, /harness submit --branch/);
    assert.match(block, /harness sync/);
    const rules = readFileSync(join(fresh.root, ".harness/rules/harness.md"), "utf8");
    assert.match(rules, /## 远程交付/);
    assert.match(rules, /harness submit/);
    assert.match(readFileSync(join(fresh.root, ".harness/rules/core.md"), "utf8"), /远程提交/);
    const safety = JSON.parse(readFileSync(join(PACKAGE_ROOT, "assets/presets/git-safety.json"), "utf8"));
    for (const id of ["main-write-on-branch", "main-ref-plumbing"]) {
      assert.match(safety.rules.find((rule) => rule.id === id).fix, /harness submit/, id);
    }
  });

  test("R12 install --version 只把指定版本装进版本目录，不改项目文件", () => {
    const repo = setup();
    const store = join(repo.root, "..", "fresh-store");
    const entry = join(PACKAGE_ROOT, "bin", "harness.mjs");
    const before = git(repo.root, "status", "--porcelain");
    const installed = sh(repo.root, process.execPath, [entry, "install", "--version", packageVersion()], { ...repo.env, HARNESS_STORE: store });
    assert.equal(installed.status, 0, installed.stderr);
    assert.ok(existsSync(join(store, packageVersion(), "MANIFEST.json")));
    assert.equal(git(repo.root, "status", "--porcelain"), before);

    const missing = sh(repo.root, process.execPath, [entry, "install", "--version", "9.9.9"], { ...repo.env, HARNESS_STORE: store });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /v9\.9\.9/);
    assert.equal(existsSync(join(store, "9.9.9")), false);
    assert.equal(git(repo.root, "status", "--porcelain"), before);
  });

  test("R13 doctor 在远程交付模式下检查远程与平台命令，主 Worktree 一项说明同步", () => {
    const repo = setup({ delivery: GITHUB });
    const missingRemote = repo.cli("doctor");
    assert.match(missingRemote.stdout, /\[!!\] delivery: .*远程 origin 不存在/);

    withRemote(repo);
    fakePlatform(repo);
    const ready = repo.cli("doctor");
    assert.match(ready.stdout, /\[ok\] delivery: .*github/);
    assert.match(ready.stdout, /main-worktree: .*同步/);

    const local = setup();
    assert.match(local.cli("doctor").stdout, /\[ok\] delivery: 本地交付/);
  });
});

describe("harness submit", () => {
  test("R3 R4 X9 推送核对过的提交并创建 PR，描述写明门禁结果，不在平台上合并", () => {
    const repo = setup({ delivery: GITHUB });
    const remote = withRemote(repo);
    const platform = fakePlatform(repo);
    const head = task(repo);
    const base = git(repo.root, "rev-parse", "main");

    const result = repo.cli("submit", "--branch", "task/a");
    assert.equal(result.status, 0, output(result));
    assert.equal(remoteRef(remote, "refs/heads/task/a"), head);
    assert.equal(remoteRef(remote, "refs/heads/main"), base, "远程主分支不变");
    const items = platform.items();
    assert.equal(items.length, 1);
    assert.equal(items[0].head, "task/a");
    assert.equal(items[0].base, "main");
    const body = items[0].body;
    assert.match(body, /<!-- harness:submit:start -->/);
    assert.ok(body.includes(head), "描述写明任务提交");
    assert.ok(body.includes(base), "描述写明目标主分支提交");
    assert.match(body, /验证/);
    assert.match(body, /approve/);
    assert.match(result.stdout, /https:\/\/github\.example\/acme\/demo\/pull\/1/);
    for (const call of platform.calls()) assert.equal(call.args.includes("merge"), false, JSON.stringify(call));
    assert.match(result.stderr, /\[submit\]/);
    assert.equal(result.stderr.includes("[merge]"), false, "submit 的日志不用 merge 的前缀");
  });

  test("R5 已有 MR 时只替换 harness 管理的区块，保留团队写的说明，不新建", () => {
    const repo = setup({ delivery: GITLAB });
    withRemote(repo);
    const platform = fakePlatform(repo);
    task(repo);
    assert.equal(repo.cli("submit", "--branch", "task/a").status, 0);
    platform.edit((state) => {
      state.items[0].body = `团队说明：上线前通知运维\n\n${state.items[0].body}\n\n尾注保留`;
    });

    const next = extend(repo, "task/a", { "src/b.js": "b\n" });
    writeReview(repo, next, "approve");
    const again = repo.cli("submit", "--branch", "task/a");
    assert.equal(again.status, 0, output(again));
    const items = platform.items();
    assert.equal(items.length, 1, "不新建 MR");
    assert.match(items[0].body, /^团队说明：上线前通知运维/);
    assert.match(items[0].body, /尾注保留$/);
    assert.ok(items[0].body.includes(next));
    assert.equal(items[0].body.split("<!-- harness:submit:start -->").length, 2, "只有一个管理区块");
    const actions = platform.calls().map((call) => `${call.args[0]} ${call.args[1]}`);
    assert.deepEqual(actions.filter((item) => item !== "mr list"), ["mr create", "mr update"]);
  });

  test("R5 管理区块替换保留区块外的文字", async () => {
    const { replaceManagedSection } = await import("../src/delivery/platform.mjs");
    const section = "<!-- harness:submit:start -->\n新\n<!-- harness:submit:end -->";
    assert.equal(replaceManagedSection("", section), section);
    assert.equal(replaceManagedSection("团队说明", section), `团队说明\n\n${section}`);
    assert.equal(
      replaceManagedSection("前\n<!-- harness:submit:start -->\n旧\n<!-- harness:submit:end -->\n后", section),
      `前\n${section}\n后`,
    );
  });

  test("远程地址里的凭据不会出现在仓库标识里", async () => {
    const { parseRemoteUrl } = await import("../src/delivery/platform.mjs");
    assert.deepEqual(parseRemoteUrl("https://user:tok-SECRET@code.example.com/group/sub/repo.git"), { host: "code.example.com", path: "group/sub/repo" });
    assert.deepEqual(parseRemoteUrl("ssh://git@code.example.com:11022/ops/repo.git"), { host: "code.example.com", path: "ops/repo" });
    assert.deepEqual(parseRemoteUrl("git@github.com:acme/demo.git"), { host: "github.com", path: "acme/demo" });
    assert.equal(parseRemoteUrl("/tmp/remote.git"), null);
  });

  test("R6 status 在远程交付模式下提示 submit，显示 PR 链接，分支前进后提示记录过期", () => {
    const repo = setup({ delivery: GITHUB });
    withRemote(repo);
    fakePlatform(repo);
    task(repo);
    assert.equal(repo.cli("verify", "--branch", "task/a").status, 0);
    const before = repo.cli("status", "--branch", "task/a");
    assert.match(before.stdout, /可以提交：harness submit --branch task\/a/);
    assert.equal(repo.cli("submit", "--branch", "task/a").status, 0);
    const after = repo.cli("status", "--branch", "task/a");
    assert.match(after.stdout, /https:\/\/github\.example\/acme\/demo\/pull\/1/);
    const last = after.stdout.trim().split("\n").at(-1);
    assert.match(last, /已提交/, last);
    assert.match(last, /harness sync/, last);

    extend(repo, "task/a", { "src/b.js": "b\n" });
    const moved = repo.cli("status", "--branch", "task/a");
    assert.match(moved.stdout, /提交记录已过期/);
  });

  test("X1 核对期间任务分支前进时拒绝，不推送", () => {
    const repo = setup({
      delivery: GITHUB,
      project: {
        ".harness/verify.json": {
          version: 1,
          docOnly: { match: [], exclude: [] },
          checks: [{ id: "mover", tier: "gate", when: ["**"], cmd: ["sh", "-c", 'git -C "$MOVE_REPO" update-ref refs/heads/task/a "$MOVE_TO"'] }],
          fullSuiteTriggers: { paths: [] },
        },
      },
    });
    const remote = withRemote(repo);
    fakePlatform(repo);
    task(repo);
    const moved = extend(repo, "task/a", { "src/b.js": "b\n" });
    git(repo.root, "branch", "-f", "task/a", "task/a~1");
    writeReview(repo, git(repo.root, "rev-parse", "task/a"), "approve");
    repo.env.MOVE_REPO = repo.root;
    repo.env.MOVE_TO = moved;
    const result = repo.cli("submit", "--branch", "task/a");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /branch_moved/);
    assert.equal(remoteRef(remote, "refs/heads/task/a"), null);
  });

  test("X2 远程同名分支已经分叉时拒绝，不强推", () => {
    const repo = setup({ delivery: GITHUB });
    const remote = withRemote(repo);
    fakePlatform(repo);
    const other = repo.branch("other", { "other.txt": "o\n" });
    git(repo.root, "push", "-q", "origin", "other:refs/heads/task/a");
    task(repo);
    const result = repo.cli("submit", "--branch", "task/a");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /push_rejected/);
    assert.equal(remoteRef(remote, "refs/heads/task/a"), other);
  });

  test("X3 只接受本地任务分支，不接受主分支、远程跟踪引用或提交号", () => {
    const repo = setup({ delivery: GITHUB });
    withRemote(repo);
    fakePlatform(repo);
    const head = task(repo);
    for (const source of ["main", "origin/main", head]) {
      const result = repo.cli("submit", "--branch", source);
      assert.notEqual(result.status, 0, source);
      assert.match(result.stderr, /invalid_source/, source);
    }
  });

  test("X4 本地主分支落后或领先远程主分支时拒绝，提示先同步", () => {
    const repo = setup({ delivery: GITHUB });
    const remote = withRemote(repo);
    fakePlatform(repo);
    task(repo);
    remoteCommit(repo, remote, { "docs/other.md": "x\n" });
    const behind = repo.cli("submit", "--branch", "task/a");
    assert.notEqual(behind.status, 0);
    assert.match(behind.stderr, /base_stale/);
    assert.match(behind.stderr, /harness sync/);
    assert.equal(remoteRef(remote, "refs/heads/task/a"), null);

    const ahead = setup({ delivery: GITHUB });
    const aheadRemote = withRemote(ahead);
    fakePlatform(ahead);
    task(ahead);
    commit(ahead.root, "docs(local): 本地多出的提交\n\n- 没有推送\n- 与远程分叉", { "docs/local.md": "l\n" });
    const result = ahead.cli("submit", "--branch", "task/a");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /base_stale/);
    assert.equal(remoteRef(aheadRemote, "refs/heads/task/a"), null);
  });

  test("X8 平台令牌不出现在命令参数、输出与描述里", () => {
    const repo = setup({ delivery: GITHUB });
    withRemote(repo);
    const platform = fakePlatform(repo);
    task(repo);
    repo.env.GH_TOKEN = "tok-SECRET-4242";
    repo.env.GITLAB_TOKEN = "tok-SECRET-4242";
    const result = repo.cli("submit", "--branch", "task/a");
    assert.equal(result.status, 0, output(result));
    assert.equal(output(result).includes("tok-SECRET-4242"), false);
    assert.equal(JSON.stringify(platform.calls()).includes("tok-SECRET-4242"), false);
    assert.equal(JSON.stringify(platform.items()).includes("tok-SECRET-4242"), false);
  });

  test("X10 本地交付模式下没有开启远程交付的分支不能 submit", () => {
    const repo = setup();
    const remote = withRemote(repo);
    fakePlatform(repo);
    task(repo);
    const result = repo.cli("submit", "--branch", "task/a");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /delivery_local/);
    assert.equal(remoteRef(remote, "refs/heads/task/a"), null);
  });

  test("F1 平台命令没有安装或查询失败时，在推送之前拒绝", () => {
    const repo = setup({ delivery: GITLAB });
    const remote = withRemote(repo);
    task(repo);
    const missing = sh(repo.root, join(repo.root, ".harness/bin/harness"), ["submit", "--branch", "task/a"], { ...repo.env, PATH: barePath(repo) });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /platform_missing/);
    assert.match(missing.stderr, /glab/);
    assert.equal(remoteRef(remote, "refs/heads/task/a"), null);

    fakePlatform(repo);
    repo.env.FAKE_PLATFORM_FAIL = "list";
    const unauthorized = repo.cli("submit", "--branch", "task/a");
    assert.notEqual(unauthorized.status, 0);
    assert.match(unauthorized.stderr, /platform_failed/);
    assert.match(unauthorized.stderr, /glab auth login/);
    assert.equal(remoteRef(remote, "refs/heads/task/a"), null);
  });

  test("F2 远程不可达时拒绝提交，不推送", () => {
    const repo = setup({ delivery: GITHUB });
    withRemote(repo);
    fakePlatform(repo);
    task(repo);
    git(repo.root, "config", `url.${join(repo.root, "..", "missing.git")}.insteadOf`, PLATFORM_URL);
    git(repo.root, "config", "--unset", `url.${join(repo.root, "..", "remote.git")}.insteadOf`);
    const result = repo.cli("submit", "--branch", "task/a");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fetch_failed/);
  });

  test("F3 推送后创建 PR 失败时停在已推送，重跑不重复推送，只补 PR", () => {
    const repo = setup({ delivery: GITHUB });
    const remote = withRemote(repo);
    const platform = fakePlatform(repo);
    const head = task(repo);
    repo.env.FAKE_PLATFORM_FAIL = "create";
    const failed = repo.cli("submit", "--branch", "task/a");
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /platform_failed/);
    assert.match(failed.stderr, /已推送/);
    assert.equal(remoteRef(remote, "refs/heads/task/a"), head);
    assert.match(repo.cli("status", "--branch", "task/a").stdout, /已推送，PR\/MR 还没有就绪/);

    delete repo.env.FAKE_PLATFORM_FAIL;
    const retried = repo.cli("submit", "--branch", "task/a");
    assert.equal(retried.status, 0, output(retried));
    assert.match(retried.stderr, /跳过推送/);
    assert.equal(platform.items().length, 1);
  });
});

describe("harness sync", () => {
  const marker = (repo) => join(repo.root, "..", "post-sync.marker");
  const postSync = { merge: { ...CONFIG.merge, postMergeCommand: ["node", "-e", "require('fs').writeFileSync(process.env.SYNC_MARKER, 'ok')"] } };

  test("P1 同步过程中主分支被推进时拒绝，不按旧配置判断新基线", () => {
    // C0 关闭门禁确认；C1 在 C0 之上重新打开确认；远程 B 在 C1 之上改了规则。
    const repo = setup({ delivery: GITHUB, config: { governance: { confirmOnGateChange: false, gatePaths: [] } } });
    const remote = withRemote(repo);
    const c0 = git(repo.root, "rev-parse", "main");
    const config = JSON.parse(readFileSync(join(repo.root, ".harness/config.json"), "utf8"));
    git(repo.root, "checkout", "-q", "-b", "next");
    const c1 = commit(repo.root, "chore(harness): 打开门禁确认\n\n- 门禁改动需要人确认\n- 由另一个合并带入", {
      ".harness/config.json": `${JSON.stringify({ ...config, governance: { confirmOnGateChange: true, gatePaths: [] } }, null, 2)}\n`,
    });
    const b = commit(repo.root, "chore(harness): 放宽规则\n\n- 关掉 git-stash\n- 平台上合入", {
      ".harness/policy.json": readFileSync(join(repo.root, ".harness/policy.json"), "utf8").replace('"disabled": []', '"disabled": ["git-stash"]'),
    });
    git(repo.root, "checkout", "-q", "main");
    git(repo.root, "push", "-q", "origin", `${b}:refs/heads/main`);

    // fetch 期间调用的 upload-pack 包装模拟“另一个合并把本地主分支从 C0 推进到 C1”，并同步主 Worktree 的文件。
    const mover = join(repo.root, "..", "mover.sh");
    writeFileSync(
      mover,
      [
        "#!/bin/sh",
        `HARNESS_MAIN_BYPASS=1 git -C ${JSON.stringify(repo.root)} update-ref refs/heads/main ${c1} ${c0} && git -C ${JSON.stringify(repo.root)} read-tree -m -u ${c0} ${c1}`,
        'exec git-upload-pack "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(mover, 0o755);
    git(repo.root, "config", "remote.origin.uploadpack", mover);

    const result = repo.cli("sync");
    assert.notEqual(result.status, 0, output(result));
    assert.match(result.stderr, /main_moved/);
    assert.equal(git(repo.root, "rev-parse", "main"), c1, "没有导入远程 B 的规则改动");
  });

  test("R7 把本地主分支快进到远程主分支，同步主 Worktree 的文件并执行合并后命令", () => {
    const repo = setup({ delivery: GITHUB, config: postSync });
    const remote = withRemote(repo);
    repo.env.SYNC_MARKER = marker(repo);
    const target = remoteCommit(repo, remote, { "src/other.js": "o\n" });
    const result = repo.cli("sync");
    assert.equal(result.status, 0, output(result));
    assert.equal(git(repo.root, "rev-parse", "main"), target);
    assert.equal(readFileSync(join(repo.root, "src/other.js"), "utf8"), "o\n");
    assert.equal(git(repo.root, "status", "--porcelain"), "");
    assert.equal(readFileSync(marker(repo), "utf8"), "ok");

    const again = repo.cli("sync");
    assert.equal(again.status, 0, output(again));
    assert.match(again.stderr, /已是最新/);
  });

  test("R11 本地交付模式下同样可以同步远程主分支", () => {
    const repo = setup();
    const remote = withRemote(repo);
    const target = remoteCommit(repo, remote, { "docs/note.md": "n\n" });
    const result = repo.cli("sync");
    assert.equal(result.status, 0, output(result));
    assert.equal(git(repo.root, "rev-parse", "main"), target);
  });

  test("R8 X6 远程带来门禁改动时按同步前的配置要求确认，目标提交关掉确认也不例外", () => {
    const repo = setup({ delivery: GITHUB });
    const remote = withRemote(repo);
    const config = JSON.parse(readFileSync(join(repo.root, ".harness/config.json"), "utf8"));
    const target = remoteCommit(repo, remote, {
      ".harness/config.json": `${JSON.stringify({ ...config, governance: { confirmOnGateChange: false, gatePaths: [] } }, null, 2)}\n`,
      ".harness/policy.json": readFileSync(join(repo.root, ".harness/policy.json"), "utf8").replace('"disabled": []', '"disabled": ["git-stash"]'),
    });
    const before = git(repo.root, "rev-parse", "main");
    const refused = repo.cli("sync");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /gate_change_unconfirmed/);
    assert.match(refused.stderr, /harness confirm --branch origin\/main/);
    assert.equal(git(repo.root, "rev-parse", "main"), before);

    const confirmed = repo.cli("confirm", "--branch", "origin/main", "--yes");
    assert.equal(confirmed.status, 0, output(confirmed));
    const synced = repo.cli("sync");
    assert.equal(synced.status, 0, output(synced));
    assert.equal(git(repo.root, "rev-parse", "main"), target);
  });

  test("R9 远程改了交付方式时即使关闭门禁确认也要人工确认", () => {
    const repo = setup({ delivery: GITHUB, config: { governance: { confirmOnGateChange: false, gatePaths: [] } } });
    const remote = withRemote(repo);
    const config = JSON.parse(readFileSync(join(repo.root, ".harness/config.json"), "utf8"));
    remoteCommit(repo, remote, { ".harness/config.json": `${JSON.stringify({ ...config, delivery: { mode: "local" } }, null, 2)}\n` });
    const refused = repo.cli("sync");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /gate_change_unconfirmed/);
    assert.match(refused.stderr, /交付设置/);
  });

  test("X5 本地主分支有远程没有的提交时拒绝，不改写历史", () => {
    const repo = setup({ delivery: GITHUB });
    withRemote(repo);
    const local = commit(repo.root, "docs(local): 本地多出的提交\n\n- 没有推送\n- 与远程分叉", { "docs/local.md": "l\n" });
    const result = repo.cli("sync");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not_fast_forward/);
    assert.equal(git(repo.root, "rev-parse", "main"), local);
  });

  test("X7 主 Worktree 不洁净或另一个合并正在进行时不更新主分支", () => {
    const repo = setup({ delivery: GITHUB });
    const remote = withRemote(repo);
    remoteCommit(repo, remote, { "docs/x.md": "x\n" });
    const before = git(repo.root, "rev-parse", "main");
    write(repo.root, "scratch.txt", "手写\n");
    const dirty = repo.cli("sync");
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /未提交或未跟踪/);
    assert.equal(readFileSync(join(repo.root, "scratch.txt"), "utf8"), "手写\n");

    sh(repo.root, "rm", ["scratch.txt"]);
    writeFileSync(join(repo.env.HARNESS_DATA_DIR, "merge.lock"), String(process.pid));
    const locked = repo.cli("sync");
    assert.notEqual(locked.status, 0);
    assert.match(locked.stderr, /merge_locked/);
    assert.equal(git(repo.root, "rev-parse", "main"), before);
  });

  test("F2 远程不可达时拒绝同步，本地主分支不变", () => {
    const repo = setup({ delivery: GITHUB });
    withRemote(repo);
    git(repo.root, "config", `url.${join(repo.root, "..", "missing.git")}.insteadOf`, PLATFORM_URL);
    git(repo.root, "config", "--unset", `url.${join(repo.root, "..", "remote.git")}.insteadOf`);
    const before = git(repo.root, "rev-parse", "main");
    const result = repo.cli("sync");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fetch_failed/);
    assert.equal(git(repo.root, "rev-parse", "main"), before);
  });

  test("F4 目标提交锁定的版本本机没有安装时，在更新主分支之前拒绝", () => {
    const repo = setup({ delivery: GITHUB });
    const remote = withRemote(repo);
    const shim = readFileSync(join(repo.root, ".harness/bin/harness"), "utf8").replace(/:-[0-9][^}"]*\}/, ":-9.9.9}");
    remoteCommit(repo, remote, { ".harness/VERSION": "9.9.9\n", ".harness/bin/harness": shim });
    const before = git(repo.root, "rev-parse", "main");
    assert.match(repo.cli("sync").stderr, /gate_change_unconfirmed/);
    assert.equal(repo.cli("confirm", "--branch", "origin/main", "--yes").status, 0);
    const result = repo.cli("sync");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /version_missing/);
    assert.match(result.stderr, /install --version 9\.9\.9/);
    assert.equal(git(repo.root, "rev-parse", "main"), before);
  });

  test("F5 合并后命令失败时说明主分支已经更新", () => {
    const repo = setup({ delivery: GITHUB, config: { merge: { ...CONFIG.merge, postMergeCommand: ["node", "-e", "process.exit(4)"] } } });
    const remote = withRemote(repo);
    const target = remoteCommit(repo, remote, { "docs/y.md": "y\n" });
    const result = repo.cli("sync");
    assert.equal(result.status, 3);
    assert.match(result.stderr, /post_merge_failed/);
    assert.match(result.stderr, /已经更新/);
    assert.equal(git(repo.root, "rev-parse", "main"), target);
  });
});

describe("独立评审发现的问题", () => {
  test("P1 平台调用绑定获授权远程的仓库标识，不依赖本地 remote 或 GH_REPO 的推断", () => {
    const repo = setup({ delivery: GITHUB });
    withRemote(repo);
    const platform = fakePlatform(repo);
    task(repo);
    const result = repo.cli("submit", "--branch", "task/a");
    assert.equal(result.status, 0, output(result));
    const calls = platform.calls();
    assert.ok(calls.length >= 2, "至少调用一次 list 与一次 create");
    for (const call of calls) {
      const at = call.args.indexOf("--repo");
      assert.ok(at >= 0, `缺少 --repo: ${JSON.stringify(call)}`);
      assert.equal(call.args[at + 1], "code.example.com/acme/demo");
    }
  });

  test("P1 识别不出平台仓库时在推送之前拒绝", () => {
    const repo = setup({ delivery: GITHUB });
    const remote = withRemote(repo);
    fakePlatform(repo);
    // 远程改成本地路径：git 仍可用，但没有平台仓库标识。
    git(repo.root, "remote", "set-url", "origin", remote);
    task(repo);
    const result = repo.cli("submit", "--branch", "task/a");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /platform_repo_unknown/);
    assert.equal(remoteRef(remote, "refs/heads/task/a"), null);
  });

  test("P1 别人从 fork 提交的同名分支 PR 不会被当成自己的，不写入门禁结论", () => {
    const repo = setup({ delivery: GITHUB });
    const remote = withRemote(repo);
    const platform = fakePlatform(repo);
    const head = task(repo);
    // 先造一个来自 fork 的同名 PR，内容和本次提交无关。
    platform.edit((state) => {
      state.next = 2;
      state.items.push({
        id: 1,
        url: "https://github.example/other/demo/pull/1",
        head: "task/a",
        base: "main",
        body: "别人的 PR",
        state: "open",
        fork: true,
      });
    });
    const result = repo.cli("submit", "--branch", "task/a");
    assert.equal(result.status, 0, output(result));
    const items = platform.items();
    assert.equal(items.length, 2, "为自己新建一个，不改别人的");
    const mine = items.find((item) => item.id !== 1);
    assert.ok(mine.body.includes(head), "门禁结论写在自己新建的 PR 上");
    assert.equal(items[0].body, "别人的 PR", "别人的 PR 不被改写");
    assert.equal(remoteRef(remote, "refs/heads/task/a"), head);
  });

  test("P1 GitLab 的查询显式要求 JSON，并按 opened 识别已有 MR", () => {
    const repo = setup({ delivery: GITLAB });
    withRemote(repo);
    const platform = fakePlatform(repo);
    task(repo);
    assert.equal(repo.cli("submit", "--branch", "task/a").status, 0);
    const next = extend(repo, "task/a", { "src/b.js": "b\n" });
    writeReview(repo, next, "approve");
    const again = repo.cli("submit", "--branch", "task/a");
    assert.equal(again.status, 0, output(again));
    const lists = platform.calls().filter((call) => call.args[1] === "list");
    assert.ok(lists.length >= 2);
    for (const call of lists) {
      const at = call.args.indexOf("--output");
      assert.ok(at >= 0, `list 没有要求 JSON: ${JSON.stringify(call)}`);
      assert.equal(call.args[at + 1], "json");
    }
    assert.equal(platform.items().length, 1, "已有 MR 时只更新，不新建");
  });

  test("P1 失败诊断不回显远程地址里的令牌", () => {
    const repo = setup({ delivery: GITHUB });
    withRemote(repo);
    fakePlatform(repo);
    task(repo);
    // 换成一个立刻拒绝连接的地址，并在查询参数里放一个哨兵；git 会把地址原样写进报错。
    git(repo.root, "remote", "set-url", "origin", "http://127.0.0.1:1/acme/demo.git?access_token=REVIEW_SENTINEL");
    git(repo.root, "config", "--unset", `url.${join(repo.root, "..", "remote.git")}.insteadOf`);
    const result = repo.cli("submit", "--branch", "task/a");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fetch_failed/);
    assert.equal(output(result).includes("REVIEW_SENTINEL"), false, output(result));
  });

  test("P2 远程只改 .harness/VERSION 也算门禁改动，需要确认；与入口锁定的版本不一致时拒绝导入", () => {
    const repo = setup({ delivery: GITHUB });
    const remote = withRemote(repo);
    // 本机装着另一个版本：版本检查本身放行，只剩门禁确认与一致性检查能拦住。
    const other = join(repo.env.HARNESS_STORE, "8.8.8");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "MANIFEST.json"), `${JSON.stringify({ version: "8.8.8", files: {} })}\n`);
    remoteCommit(repo, remote, { ".harness/VERSION": "8.8.8\n" });
    const before = git(repo.root, "rev-parse", "main");
    const refused = repo.cli("sync");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /gate_change_unconfirmed/);
    assert.match(refused.stderr, /\.harness\/VERSION/);
    assert.equal(git(repo.root, "rev-parse", "main"), before);

    assert.equal(repo.cli("confirm", "--branch", "origin/main", "--yes").status, 0);
    const mismatch = repo.cli("sync");
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /version_mismatch/);
    assert.equal(git(repo.root, "rev-parse", "main"), before);
  });

  test("P2 目标锁定的版本等于当前运行版本但本机没装时同样拒绝", () => {
    const repo = setup({ delivery: GITHUB });
    const remote = withRemote(repo);
    remoteCommit(repo, remote, { "docs/y.md": "y\n" });
    const before = git(repo.root, "rev-parse", "main");
    const emptyStore = join(repo.root, "..", "empty-store");
    mkdirSync(emptyStore, { recursive: true });
    // 直接用源码运行：进程版本号等于目标锁定的版本，但版本目录里没有它。
    const result = sh(repo.root, process.execPath, [join(PACKAGE_ROOT, "bin", "harness.mjs"), "sync"], { ...repo.env, HARNESS_STORE: emptyStore });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /version_missing/);
    assert.ok(result.stderr.includes(`install --version ${packageVersion()}`), result.stderr);
    assert.equal(git(repo.root, "rev-parse", "main"), before);
  });
});

describe("开启、关闭与首次接入", () => {
  test("R16 X10 本地交付模式下开启远程交付的分支，确认后提交，平台合入后同步，此后 merge 拒绝", () => {
    const repo = setup({ config: { governance: { confirmOnGateChange: false, gatePaths: [] } } });
    const remote = withRemote(repo);
    const platform = fakePlatform(repo);
    const head = setDelivery(repo, "chore/enable-remote", GITHUB);

    const refused = repo.cli("submit", "--branch", "chore/enable-remote");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /gate_change_unconfirmed/);
    assert.match(refused.stderr, /提交前确认一次/, "submit 的拒绝说提交前，不说合并前");
    assert.match(refused.stderr, /确认后重新运行 harness submit --branch chore\/enable-remote/);
    assert.equal(refused.stderr.includes("合并前"), false, refused.stderr);
    assert.equal(remoteRef(remote, "refs/heads/chore/enable-remote"), null);

    const summary = repo.cli("confirm", "--branch", "chore/enable-remote");
    assert.match(summary.stdout, /交付设置: 本地交付.*-> 远程交付（github，远程 origin）/);
    assert.match(summary.stdout, /harness submit 可以把任务分支普通推送到 origin/);
    assert.equal(repo.cli("confirm", "--branch", "chore/enable-remote", "--yes").status, 0);

    const submitted = repo.cli("submit", "--branch", "chore/enable-remote");
    assert.equal(submitted.status, 0, output(submitted));
    assert.equal(remoteRef(remote, "refs/heads/chore/enable-remote"), head);
    assert.equal(platform.items().length, 1);

    platformFastForward(remote, head);
    const synced = repo.cli("sync");
    assert.equal(synced.status, 0, output(synced));
    assert.equal(git(repo.root, "rev-parse", "main"), head);

    task(repo, "task/after", { "src/after.js": "x\n" });
    const merged = repo.cli("merge", "--branch", "task/after");
    assert.notEqual(merged.status, 0);
    assert.match(merged.stderr, /delivery_remote/);
  });

  test("R17 远程交付模式下关闭远程交付走普通提交，同步后 merge 恢复", () => {
    const repo = setup({ delivery: GITHUB });
    const remote = withRemote(repo);
    fakePlatform(repo);
    const head = setDelivery(repo, "chore/disable-remote", null);
    assert.match(repo.cli("submit", "--branch", "chore/disable-remote").stderr, /gate_change_unconfirmed/);
    const pending = repo.cli("status", "--branch", "chore/disable-remote");
    assert.match(pending.stdout, /提交前需要人工确认/, pending.stdout);
    assert.equal(pending.stdout.includes("合并前"), false, pending.stdout);
    assert.equal(repo.cli("confirm", "--branch", "chore/disable-remote", "--yes").status, 0);
    const submitted = repo.cli("submit", "--branch", "chore/disable-remote");
    assert.equal(submitted.status, 0, output(submitted));

    platformFastForward(remote, head);
    const synced = repo.cli("sync");
    assert.equal(synced.status, 0, output(synced));

    task(repo, "task/after", { "src/after.js": "x\n" });
    const merged = repo.cli("merge", "--branch", "task/after");
    assert.equal(merged.status, 0, merged.stderr);
  });

  test("R10 首次接入经人工确认后可以提交，平台合入后同步导入配置", () => {
    const repo = makeRepo({ install: false, project: { ".harness/config.json": null, ".harness/policy.json": null, ".harness/verify.json": null } });
    repos.push(repo);
    const remote = withRemote(repo);
    const platform = fakePlatform(repo);
    git(repo.root, "checkout", "-q", "-b", "chore/harness-onboard");
    const init = repo.rawCli("init");
    assert.equal(init.status, 0, output(init));
    const config = JSON.parse(readFileSync(join(repo.root, ".harness/config.json"), "utf8"));
    writeFileSync(join(repo.root, ".harness/config.json"), `${JSON.stringify({ ...config, delivery: GITHUB }, null, 2)}\n`);
    git(repo.root, "add", "-A");
    git(repo.root, "commit", "-q", "-m", "chore(harness): 接入门禁\n\n- 写入配置与入口\n- 采用远程交付");
    git(repo.root, "checkout", "-q", "main");
    const head = git(repo.root, "rev-parse", "chore/harness-onboard");

    fakeReviewer(repo, APPROVE);
    assert.equal(repo.rawCli("verify", "--branch", "chore/harness-onboard").status, 0);
    assert.equal(repo.rawCli("review", "--branch", "chore/harness-onboard").status, 0);
    const unconfirmed = repo.rawCli("submit", "--branch", "chore/harness-onboard");
    assert.notEqual(unconfirmed.status, 0);
    assert.match(unconfirmed.stderr, /gate_change_unconfirmed/);
    assert.equal(repo.rawCli("confirm", "--branch", "chore/harness-onboard", "--yes").status, 0);
    const summary = repo.rawCli("confirm", "--branch", "chore/harness-onboard");
    assert.match(summary.stdout, /由此授予: harness submit 可以把任务分支普通推送到 origin/, "首次接入同样写明授予的远程权限");
    const submitted = repo.rawCli("submit", "--branch", "chore/harness-onboard");
    assert.equal(submitted.status, 0, output(submitted));
    assert.equal(remoteRef(remote, "refs/heads/chore/harness-onboard"), head);
    assert.equal(platform.items().length, 1);
    const body = platform.items()[0].body;
    const gateList = body.slice(body.indexOf("门禁文件改动"));
    assert.ok(gateList.includes("`.claude/settings.json`"), "门禁文件按门禁路径列出，包括客户端钩子配置");
    assert.equal(gateList.includes(".harness/templates/"), false, "模板不是门禁文件");
    const status = repo.rawCli("status", "--branch", "chore/harness-onboard");
    assert.match(status.stdout, /https:\/\/github\.example\/acme\/demo\/pull\/1/, "首次接入的分支也显示 PR 链接");

    platformFastForward(remote, head);
    const synced = repo.rawCli("sync");
    assert.equal(synced.status, 0, output(synced));
    assert.equal(git(repo.root, "rev-parse", "main"), head);
    assert.ok(existsSync(join(repo.root, ".harness/config.json")));
    assert.match(repo.cli("merge", "--branch", "chore/harness-onboard").stderr, /delivery_remote|already_merged/);
  });
});
