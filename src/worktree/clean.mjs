import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { harnessOnMain, loadTrustedProject, mainBranch, trustedMainRef } from "../lib/config.mjs";
import { matchAny } from "../lib/glob.mjs";
import { git, repoRoot, resolveCommit, run, samePath, worktreeEntries } from "../lib/git.mjs";
import { appendLedger } from "../lib/store.mjs";
import { resolvePolicy } from "../policy/resolve.mjs";
import { checkoutsDir } from "../verify/verify.mjs";

const CLEANUP_TIMEOUT_MS = 10 * 60 * 1000;
// 建好后一直没有新提交的 Worktree，这段时间内当作刚开始的任务保留，过了就没有独有的内容，可以清理。
const FRESH_MS = 24 * 60 * 60 * 1000;

// 本机文件的固定清单：它们由用户手工维护，删了就找不回来。
// 即使读取规则放宽了（例如开发环境的环境文件），清理时仍按本机文件处理。
const LOCAL_FILES = {
  paths: ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/credentials*.json"],
  allow: ["**/*.example"],
};

function realOrResolved(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function inside(parent, child) {
  const top = realOrResolved(parent);
  const path = realOrResolved(child);
  return path === top || path.startsWith(`${top}${sep}`);
}

function lastLine(text) {
  return String(text ?? "").trim().split("\n").at(-1) ?? "";
}

function listSome(items, limit = 3) {
  return `${items.slice(0, limit).join("、")}${items.length > limit ? ` 等 ${items.length} 项` : ""}`;
}

/**
 * 本机文件取固定清单与项目读取保护规则的并集。
 * 读取保护只说明 Agent 能不能看或改，不代表这些文件可以随 Worktree 一起删掉；
 * 两个来源取并集，放宽读取的项目也不会因此在清理时丢掉本机配置。
 */
function localFilePatterns(project) {
  const rules = project ? resolvePolicy(project.policy).rules.filter((rule) => rule.kind === "read-protect" && !rule.when) : [];
  return {
    paths: [...LOCAL_FILES.paths, ...rules.flatMap((rule) => rule.paths ?? [])],
    allow: [...LOCAL_FILES.allow, ...rules.flatMap((rule) => rule.allow ?? [])],
  };
}

/** 删除前在 Worktree 里运行的命令，取自主分支上的配置：任务分支改不了它，也就没法借清理执行别的命令。 */
function cleanupCommands(project) {
  const list = project?.config?.worktree?.cleanup ?? [];
  const valid = Array.isArray(list) && list.every((cmd) => Array.isArray(cmd) && cmd.length > 0 && cmd.every((arg) => typeof arg === "string"));
  if (!valid) {
    throw new Error('.harness/config.json 的 worktree.cleanup 必须是命令数组的列表，例如 [["make", "worktree.dev.down"]]');
  }
  return list;
}

/**
 * 每个进程的工作目录，用来判断有没有会话或服务还停在 Worktree 里。
 * Linux 读 /proc，其他系统用 lsof；只看得到当前用户的进程，尽力而为。本机无法查看时返回 null。
 */
function processCwds() {
  if (existsSync("/proc/self/cwd")) {
    const found = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const cwd = readlinkSync(`/proc/${name}/cwd`);
        let command = "";
        try {
          command = readFileSync(`/proc/${name}/comm`, "utf8").trim();
        } catch {
          // 进程名读不到不影响判断
        }
        found.push({ pid: Number(name), command, cwd });
      } catch {
        // 进程已退出或无权查看
      }
    }
    return found;
  }
  const result = run("lsof", ["-n", "-P", "-d", "cwd", "-F", "pcn"]);
  if (result.error || !result.stdout) return null;
  const found = [];
  let current = null;
  for (const line of result.stdout.split("\n")) {
    const value = line.slice(1);
    if (line[0] === "p") {
      current = { pid: Number(value), command: "", cwd: "" };
      found.push(current);
    } else if (line[0] === "c" && current) current.command = value;
    else if (line[0] === "n" && current) current.cwd = value;
  }
  return found.filter((item) => item.cwd);
}

/** Worktree 检出的提交：有分支看分支，分离头指针看 HEAD。 */
function tipOf(entry) {
  return entry.branch ? `refs/heads/${entry.branch}` : entry.head;
}

function aheadCount(root, mainCommit, entry) {
  const result = git(root, ["rev-list", "--count", `${mainCommit}..${tipOf(entry)}`]);
  return result.status === 0 ? Number(result.stdout.trim()) : null;
}

/**
 * 刚建好的 Worktree 指向主分支上的提交，看起来和已合并的一样，其实是刚开始的任务。
 * 按 Worktree 自己的 HEAD 日志判断：所有记录都还停在创建时的提交上、而且创建不到 24 小时，就当作刚开始。
 * 分支与分离头指针都适用；日志被关闭或目录已不存在时看不出来，按不是刚建好处理。
 */
function justCreated(entry, now = Date.now()) {
  const result = git(entry.path, ["reflog", "show", "--date=unix", "--format=%H %gd", "HEAD"]);
  if (result.status !== 0) return false;
  const entries = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [commit, selector] = line.split(" ");
      return { commit, at: Number(selector?.match(/\{(\d+)\}$/)?.[1]) * 1000 };
    });
  if (entries.length === 0) return false;
  const created = entries.at(-1);
  return entries.every((item) => item.commit === created.commit) && Number.isFinite(created.at) && now - created.at < FRESH_MS;
}

function describeProcess(item) {
  return `进程 ${item.pid}${item.command ? ` ${item.command}` : ""}`;
}

/** 判断一个 Linked Worktree 能不能清理：不能时给出原因，能时给出删除会带走什么。 */
function inspect(entry, ctx) {
  const skip = (reason) => ({ reason });
  if (inside(ctx.cache, entry.path)) return skip("verify 的固定检出，用来复用增量缓存");
  if (entry.locked) return skip(`已锁定${entry.lockReason ? `（${entry.lockReason}）` : ""}，git worktree unlock 后才会清理`);
  if (samePath(entry.path, ctx.current)) return skip("命令当前所在的 Worktree，回到主 Worktree 再清理");
  const ahead = aheadCount(ctx.root, ctx.mainCommit, entry);
  if (ahead === null) return skip(entry.branch ? `找不到分支 ${entry.branch}` : "读不到 HEAD 指向的提交");
  if (ahead > 0) return skip(`${ahead} 个提交没有合入 ${ctx.mainRef}`);
  if (justCreated(entry)) return skip("建好不到 24 小时，还没有新的提交，可能是刚开始的任务");
  if (!existsSync(entry.path)) return { missing: true };

  const status = git(entry.path, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status.status !== 0) return skip(`无法读取状态: ${lastLine(status.stderr)}`);
  const changed = status.stdout.split("\n").filter(Boolean).length;
  if (changed > 0) return skip(`${changed} 个未提交或未跟踪的文件`);

  const busy = ctx.holders(entry.path);
  if (busy.length > 0) return skip(`有进程停在里面（${listSome(busy.map(describeProcess))}）`);

  // 不加 --force 的 git worktree remove 照样会删掉被忽略的文件，删之前列出来；整个目录被忽略时不再往里找。
  const ignored = git(entry.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])
    .stdout.split("\0")
    .filter(Boolean);
  const localFiles = ignored.filter((rel) => matchAny(rel, ctx.patterns.paths) && !matchAny(rel, ctx.patterns.allow));
  if (localFiles.length > 0 && !ctx.withLocalFiles) {
    return skip(`含有本机文件 ${listSome(localFiles)}，确认不要后加 --with-local-files 才删`);
  }
  // 不统计占用空间：带 node_modules 的 Worktree 每个要 du 一秒左右，上百个时预览会超过 Agent 命令的超时。
  return { ignored, localFiles };
}

/**
 * 删除阶段的子进程放进独立的进程组：终端里按 Ctrl-C 时信号发给整个前台进程组，
 * 正在跑的 make、git 会被一起打断，留下停了一半的服务或删了一半的目录。独立出来后只有本命令收到，处理完当前 Worktree 再停。
 */
function execute(cmd, args, { cwd, env = process.env, timeout = CLEANUP_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      stderr += `\n超时(${timeout}ms)，已终止`;
      child.kill("SIGKILL");
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ status: 127, stdout, stderr: String(error.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ status: code ?? 1, stdout, stderr });
    });
  });
}

/** 只读：列出哪些 Linked Worktree 可以清理、哪些跳过以及原因。 */
export function planCleanup({ cwd, withLocalFiles = false, log = () => {} }) {
  const root = repoRoot(cwd);
  // 主分支已接入时配置必须读得出来：读不出来就静默跳过清理命令，会删掉 Worktree 却留下它的服务与数据库。
  const project = harnessOnMain(root) ? loadTrustedProject(root) : null;
  const mainRef = project ? mainBranch(project) : trustedMainRef(root);
  const mainCommit = resolveCommit(root, mainRef);
  const cleanup = cleanupCommands(project);
  const entries = worktreeEntries(root);
  log(`[worktree] 正在检查 ${entries.length - 1} 个 Linked Worktree，数量多时需要几十秒`);
  let processes;
  const holders = (path) => {
    if (processes === undefined) processes = processCwds();
    if (processes === null) return [];
    const real = realOrResolved(path);
    return processes.filter((item) => item.pid !== process.pid && (item.cwd === real || item.cwd.startsWith(`${real}${sep}`)));
  };
  const ctx = { root, mainRef, mainCommit, cache: checkoutsDir(), current: root, patterns: localFilePatterns(project), withLocalFiles, holders };
  const removable = [];
  const skipped = [];
  for (const entry of entries.slice(1)) {
    const verdict = inspect(entry, ctx);
    (verdict.reason ? skipped : removable).push({ path: entry.path, branch: entry.branch, head: entry.head, ...verdict });
  }
  return { root, mainRoot: entries[0].path, mainRef, removable, skipped, cleanup, processCheck: processes !== null };
}

async function runCleanup(plan, item) {
  for (const command of plan.cleanup) {
    const argv = command.map((arg) =>
      arg.replaceAll("{worktree}", item.path).replaceAll("{main}", plan.mainRoot).replaceAll("{branch}", item.branch),
    );
    const env = { ...process.env, PWD: item.path, HARNESS_WORKTREE: item.path, HARNESS_MAIN: plan.mainRoot, HARNESS_BRANCH: item.branch };
    const result = await execute(argv[0], argv.slice(1), { cwd: item.path, env });
    if (result.status !== 0) {
      const shown = argv.join(" ");
      const tail = lastLine(result.stderr || result.stdout);
      return `清理命令失败（${shown.length > 80 ? `${shown.slice(0, 80)}…` : shown}，退出码 ${result.status}）${tail ? `: ${tail}` : ""}`;
    }
  }
  return null;
}

const gitAsync = (cwd, args) => execute("git", args, { cwd });

async function removeTree(plan, item) {
  if (item.missing) {
    // 目录已经不在了，只剩 git 里的记录；记录不清掉，分支会被当成仍有 Worktree 在用而删不掉。
    if ((await gitAsync(plan.mainRoot, ["worktree", "remove", item.path])).status === 0) return null;
    const pruned = await gitAsync(plan.mainRoot, ["worktree", "prune"]);
    return pruned.status === 0 ? null : `git worktree prune 失败: ${lastLine(pruned.stderr)}`;
  }
  const failure = await runCleanup(plan, item);
  if (failure) return failure;
  // 清理命令可能留下文件，按最终状态再确认一次；不加 --force，git 遇到未提交或未跟踪的文件同样会拒绝。
  const status = git(item.path, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status.status !== 0 || status.stdout.trim()) return "清理命令之后出现了未提交或未跟踪的文件";
  const removed = await gitAsync(plan.mainRoot, ["worktree", "remove", item.path]);
  return removed.status === 0 ? null : `git worktree remove 失败: ${lastLine(removed.stderr)}`;
}

async function cleanOne(plan, item) {
  const failure = await removeTree(plan, item);
  if (failure) return { ...item, reason: failure };
  if (!item.branch) return { ...item, branchDeleted: null };
  const branch = await gitAsync(plan.mainRoot, ["branch", "-d", item.branch]);
  return { ...item, branchDeleted: branch.status === 0, branchError: branch.status === 0 ? null : lastLine(branch.stderr) };
}

function branchNote(item) {
  return item.branchDeleted === null ? "没有分支" : item.branchDeleted ? "分支已删除" : `分支保留: ${item.branchError}`;
}

/**
 * 删除可清理的 Worktree 与分支。分支用 git branch -d，没有完全合并时 git 会拒绝，分支保留。
 * 每处理一个输出一行进度；收到第一次 Ctrl-C 时处理完当前这个再停，第二次立即退出。
 */
export async function cleanWorktrees({ cwd, withLocalFiles = false, log = () => {} }) {
  const plan = planCleanup({ cwd, withLocalFiles, log });
  const removed = [];
  const failed = [];
  let interrupted = false;
  const onInterrupt = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    log("[worktree] 收到中断，处理完当前 Worktree 后停止；再按一次 Ctrl-C 立即退出");
  };
  process.on("SIGINT", onInterrupt);
  try {
    for (const [index, item] of plan.removable.entries()) {
      if (interrupted) break;
      const started = Date.now();
      log(`[worktree] [${index + 1}/${plan.removable.length}] ${label(item)}`);
      const outcome = await cleanOne(plan, item);
      const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
      if (outcome.reason) {
        failed.push(outcome);
        log(`[worktree]     保留：${outcome.reason}（${took}）`);
      } else {
        removed.push(outcome);
        log(`[worktree]     已删除，${branchNote(outcome)}（${took}）`);
      }
    }
  } finally {
    process.off("SIGINT", onInterrupt);
  }
  const pending = plan.removable.length - removed.length - failed.length;
  appendLedger(plan.root, { event: "worktree.clean", removed: removed.length, skipped: plan.skipped.length + failed.length, pending });
  return { ...plan, removed, failed, interrupted, pending };
}

/** 检出的提交已在主分支上、还没清理的 Linked Worktree，供合并输出与 doctor 提示，只读且不查进程与本机文件。 */
export function leftoverWorktrees({ root, mainRef }) {
  const mainCommit = resolveCommit(root, mainRef);
  const cache = checkoutsDir();
  return worktreeEntries(root)
    .slice(1)
    .filter((entry) => !entry.locked && !inside(cache, entry.path) && aheadCount(root, mainCommit, entry) === 0 && !justCreated(entry));
}

function label(item) {
  return `${item.path}  ${item.branch ?? `(${(item.head ?? "").slice(0, 10)})`}`;
}

function describeRemovable(item) {
  if (item.missing) return "目录已不存在，只清理记录与分支";
  const parts = [];
  const others = item.ignored.filter((rel) => !item.localFiles.includes(rel));
  if (others.length > 0) parts.push(`会连带删除被忽略的 ${listSome(others)}`);
  if (item.localFiles.length > 0) parts.push(`含本机文件 ${listSome(item.localFiles)}`);
  return parts.join("；");
}

export function formatCleanPlan(plan) {
  const lines = [`主分支 ${plan.mainRef}；可清理 ${plan.removable.length} 个，跳过 ${plan.skipped.length} 个`];
  if (plan.removable.length > 0) {
    lines.push("", "可清理:");
    for (const item of plan.removable) lines.push(`  ${label(item)}  ${describeRemovable(item)}`.trimEnd());
  }
  if (plan.skipped.length > 0) {
    lines.push("", "跳过:");
    for (const item of plan.skipped) lines.push(`  ${label(item)}：${item.reason}`);
  }
  if (plan.cleanup.length > 0) {
    lines.push("", "删除前在每个 Worktree 里依次运行（.harness/config.json 的 worktree.cleanup），失败就保留那个 Worktree:");
    for (const command of plan.cleanup) lines.push(`  ${command.join(" ")}`);
  }
  if (!plan.processCheck) lines.push("", "注意: 本机无法查看进程的工作目录，没有检查是否有进程停在 Worktree 里");
  lines.push(
    "",
    plan.removable.length > 0
      ? "以上为预览，没有删除任何东西。确认后加 --yes 删除：Worktree 不加 --force 删除，分支用 git branch -d 删除。"
      : "没有可清理的 Worktree。",
  );
  return lines.join("\n");
}

export function formatCleanResult(outcome) {
  const skipped = [...outcome.skipped, ...outcome.failed];
  const lines = [`已删除 ${outcome.removed.length} 个，跳过 ${skipped.length} 个`];
  if (outcome.removed.length > 0) {
    lines.push("", "已删除:");
    for (const item of outcome.removed) lines.push(`  ${label(item)}  ${branchNote(item)}`);
  }
  if (skipped.length > 0) {
    lines.push("", "跳过:");
    for (const item of skipped) lines.push(`  ${label(item)}：${item.reason}`);
  }
  if (outcome.interrupted) lines.push("", `已中断，还有 ${outcome.pending} 个没有处理；重新运行 harness worktree clean 会接着处理`);
  return lines.join("\n");
}
