import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { loadGateProject, mainBranch } from "../lib/config.mjs";
import { matchAny, matches } from "../lib/glob.mjs";
import {
  changedPaths,
  git,
  gitOk,
  isAncestor,
  mainWorktreeRoot,
  mergeBase,
  resolveCommit,
  run,
  treeOf,
} from "../lib/git.mjs";
import { appendLedger, dataDir, readRecord, writeRecord } from "../lib/store.mjs";
import { selectGoPackages } from "./selectors/go-packages.mjs";
import { selectVitestFiles } from "./selectors/vitest.mjs";

export const EVIDENCE_KIND = "evidence";

function execute(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const started = performance.now();
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const keep = (chunk) => {
      output += chunk.toString();
      if (output.length > 200_000) output = output.slice(-200_000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      output += `\n[harness] 超时(${timeoutMs}ms),已终止\n`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      // 命令本身不存在（例如没装 cargo）与检查失败要分开：前者是环境问题，给出安装提示更有用。
      resolvePromise({ exit: 127, durationMs: Math.round(performance.now() - started), tail: String(error.message), spawnError: error.code ?? "unknown" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        exit: code ?? 1,
        durationMs: Math.round(performance.now() - started),
        tail: output.split("\n").slice(-40).join("\n"),
      });
    });
  });
}

function listTracked(cwd, prefix) {
  return gitOk(cwd, ["ls-files", "-z", "--", prefix]).split("\0").filter(Boolean);
}

/**
 * 计算一次要跑的检查集。
 * changed 是相对合并基线的全部改动路径（含被删除的），exists 用来把已删除路径排除出选择器输入。
 */
export function planChecks({ project, cwd, changed, exists = (path) => existsSync(join(cwd, path)) }) {
  const map = project.verify;
  const selectorInput = changed.filter((path) => exists(path));
  const docOnly =
    changed.length > 0 && changed.every((path) => matches(path, map.docOnly ?? { match: [], exclude: [] }));
  const plan = [];
  const notExecuted = [];
  const advisory = [];
  const full = changed.some((path) => matchAny(path, map.fullSuiteTriggers?.paths ?? []));

  for (const check of map.checks) {
    const hit = changed.filter((path) => matchAny(path, check.when));
    if (hit.length === 0) continue;

    if (check.tier === "advisory") {
      // advisory 只提示，不进入未执行清单，避免常见改动长期显示“未验证”。
      advisory.push({ id: check.id, hint: check.hint ?? check.reason ?? "" });
      continue;
    }

    if (check.tier === "extended") {
      notExecuted.push({
        id: check.id,
        reason: check.reason,
        impact: `影响路径 ${hit.length} 个`,
        howToVerify: check.howToVerify,
      });
      continue;
    }

    if (check.selector === "go-packages") {
      const selection = selectGoPackages({ cwd, changed: selectorInput, check });
      if (selection.mode === "none") continue;
      const packages = full ? ["./..."] : selection.packages;
      plan.push({
        id: check.id,
        cwd: ".",
        cmd: ["go", "test", "-count=1", ...packages],
        when: check.when,
        note: full ? "命中公共底层路径，扩大为全量 go test" : selection.note ?? `${selection.mode}: ${packages.length} 个包`,
      });
      continue;
    }

    if (check.selector === "vitest") {
      const selection = selectVitestFiles({
        changed: selectorInput,
        check,
        listAllTests: () =>
          listTracked(cwd, check.testRoot ?? "frontend/src").filter((path) =>
            /\.(test|spec)\.(ts|tsx|js|vue)$/.test(path),
          ),
      });
      if (selection.files.length === 0) {
        if (selection.hasSourceWithoutTest) {
          notExecuted.push({
            id: check.id,
            reason: "改动的源文件没有同名或同目录的单元测试",
            impact: `${selection.sourceFiles.length} 个源文件无单测覆盖`,
            howToVerify: "补充针对该行为的单元测试后重跑",
          });
        }
        continue;
      }
      plan.push({
        id: check.id,
        cwd: check.cwd ?? ".",
        cmd: ["pnpm", "exec", "vitest", "run", ...selection.files.map((file) => file.replace(/^[^/]+\//, ""))],
        requires: check.requires ?? [],
        when: check.when,
        note: `${selection.files.length} 个测试文件`,
      });
      continue;
    }

    if (!Array.isArray(check.cmd) || check.cmd.length === 0) continue;

    plan.push({
      id: check.id,
      cwd: check.cwd ?? ".",
      cmd: check.cmd,
      requires: check.requires ?? [],
      when: check.when,
      note: `命中 ${hit.length} 个路径`,
    });
  }

  const unique = new Map();
  for (const item of plan) {
    const key = `${item.cwd}::${item.cmd.join(" ")}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  const deduped = [...unique.values()];
  const hasAll = deduped.some((item) => item.cmd.join(" ") === "make test");
  const finalPlan = hasAll ? deduped.filter((item) => !(item.cmd[0] === "go" && item.cmd[1] === "test")) : deduped;
  return { plan: finalPlan, notExecuted, advisory, docOnly };
}

/**
 * 判定哪些检查可以沿用已有证据。
 * 只有当“主分支自上次验证以来新增的改动”与某项检查的触发范围没有交集时才复用：
 * 有交集说明该检查覆盖的文件被别人改过，原结果不再可信。
 */
export function reusableChecks({ previous, plan, mainDelta }) {
  if (!previous || previous.status !== "passed") return { reuse: new Map(), rerun: plan.map((item) => item.id) };
  const priorById = new Map((previous.checks ?? []).map((item) => [item.id, item]));
  const reuse = new Map();
  const rerun = [];
  for (const item of plan) {
    const prior = priorById.get(item.id);
    const touched = mainDelta.some((path) => matchAny(path, item.when ?? []));
    if (prior && prior.exit === 0 && !touched) reuse.set(item.id, prior);
    else rerun.push(item.id);
  }
  return { reuse, rerun };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function holderAlive(lock) {
  let pid = 0;
  try {
    pid = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
  } catch {
    return { alive: false, pid: 0 };
  }
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false, pid: 0 };
  try {
    process.kill(pid, 0);
    return { alive: true, pid };
  } catch {
    return { alive: false, pid };
  }
}

/**
 * 固定检出目录同一时刻只允许一个验证使用。
 * 等不到锁就返回 null，由调用方改用临时目录：宁可牺牲缓存，也不让两个任务互相等。
 */
async function acquireCheckoutLock({ dir, timeoutMs = 120_000, log }) {
  const lock = join(dir, "lock");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      return () => rmSync(lock, { force: true });
    } catch {
      const { alive, pid } = holderAlive(lock);
      // 持锁进程已不存在（崩溃或被杀）：清掉残留锁，立即重试。
      if (!alive) {
        rmSync(lock, { force: true });
        continue;
      }
      log(`[verify] 另一个验证正在进行(pid ${pid})，等待固定检出目录`);
      await sleep(500);
    }
  }
  return null;
}

/** verify 固定检出所在的目录；worktree clean 据此认出它们，不当成任务 Worktree 删除。 */
export function checkoutsDir() {
  return join(process.env.HARNESS_CACHE_DIR || join(homedir(), ".cache", "harness"), "checkouts");
}

function checkoutRootFor(root) {
  const dir = join(
    checkoutsDir(),
    createHash("sha1").update(mainWorktreeRoot(root)).digest("hex").slice(0, 12),
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 复用固定检出目录，而不是每次新建随机目录。
 * 前端 typecheck 的 tsBuildInfoFile 记录的是绝对路径，目录一变增量缓存必然失效，
 * 固定目录后同一个仓库的第二次验证可以命中缓存。
 */
function prepareCheckout({ root, headCommit, log, parent }) {
  const checkout = join(parent, "work");
  if (existsSync(join(checkout, ".git"))) {
    const moved = git(root, ["-C", checkout, "checkout", "--force", "--detach", headCommit]);
    if (moved.status === 0) {
      git(root, ["-C", checkout, "clean", "-fdq"]);
      git(root, ["-C", checkout, "reset", "--hard", "-q"]);
      log("[verify] 复用固定检出目录，增量缓存保持有效");
      return { checkout, reused: true };
    }
    git(root, ["worktree", "remove", "--force", checkout]);
    rmSync(checkout, { recursive: true, force: true });
  }
  if (existsSync(checkout)) rmSync(checkout, { recursive: true, force: true });
  gitOk(root, ["worktree", "add", "--detach", "--force", checkout, headCommit]);
  return { checkout, reused: false };
}

function linkDependencies(mainRoot, checkout, requires) {
  for (const rel of requires) {
    const target = join(checkout, rel);
    const source = join(mainRoot, rel);
    if (existsSync(target) || !existsSync(source)) continue;
    mkdirSync(join(target, ".."), { recursive: true });
    symlinkSync(source, target, "dir");
  }
}

/**
 * recordKey 默认等于 head。合并场景下传入“分支提交”作为键：
 * 合并提交由 commit-tree 生成，时间戳不同会导致 sha 每次不同，用它作键无法复用。
 */
export async function verify({
  cwd,
  head = "HEAD",
  base,
  recordKey,
  reuse = true,
  keepCheckout = false,
  gateBranch,
  log = console.error,
}) {
  // 首次接入时主分支还没有配置，按接入分支（gateBranch）提议的配置验证。
  const project = loadGateProject(cwd, { branch: gateBranch });
  const root = project.root;
  const headCommit = resolveCommit(root, head);
  const baseRef = base ?? mainBranch(project);
  const baseCommit = resolveCommit(root, baseRef);
  const baseOfHead = mergeBase(root, baseCommit, headCommit);
  const tree = treeOf(root, headCommit);
  const changed = changedPaths(root, baseOfHead, headCommit);
  const config = project.config.verify ?? {};

  const key = recordKey ?? headCommit;
  const previous = reuse ? readRecord(root, EVIDENCE_KIND, key) : { ok: false };
  const priorMainDelta = previous.ok ? changedPaths(root, previous.record.baseCommit, baseCommit) : [];

  mkdirSync(dataDir(root), { recursive: true });
  const sharedParent = checkoutRootFor(root);
  const releaseLock = await acquireCheckoutLock({ dir: sharedParent, log });
  let parent = sharedParent;
  if (!releaseLock) {
    // 等不到锁就用独立临时目录：牺牲缓存，保证两个任务能同时验证。
    parent = mkdtempSync(join(tmpdir(), "harness-checkout-fallback-"));
    log("[verify] 未能获得固定检出目录的锁，本次使用临时目录（增量缓存不生效）");
  }
  const { checkout } = prepareCheckout({ root, headCommit, log, parent });
  const mainRoot = mainWorktreeRoot(root);
  const env = project.config.env ?? {};
  const started = new Date().toISOString();
  const results = [];

  try {
    const { plan, notExecuted, advisory, docOnly } = planChecks({ project, cwd: checkout, changed });
    const { reuse: reusable, rerun } = reuse
      ? reusableChecks({ previous: previous.ok ? previous.record : null, plan, mainDelta: priorMainDelta })
      : { reuse: new Map(), rerun: plan.map((item) => item.id) };

    log(
      `[verify] head=${headCommit.slice(0, 12)} 变更 ${changed.length} 个文件${docOnly ? "(仅文档)" : ""}，` +
        `计划 ${plan.length} 项，复用 ${reusable.size} 项，重跑 ${rerun.length} 项`,
    );
    if (previous.ok) log(`[verify] 主分支自上次验证新增 ${priorMainDelta.length} 个文件`);

    let blocked = false;
    for (const item of plan) {
      if (reusable.has(item.id)) {
        const prior = reusable.get(item.id);
        results.push({ ...prior, reused: true });
        log(`[verify] = ${item.id} 复用上次结果`);
        continue;
      }

      const missing = (item.requires ?? []).filter((rel) => !existsSync(join(mainRoot, rel)) && !existsSync(join(checkout, rel)));
      if (missing.length > 0) {
        results.push({ id: item.id, cmd: item.cmd.join(" "), exit: null, skipped: true, reason: `缺少依赖目录 ${missing.join(", ")}` });
        notExecuted.push({
          id: item.id,
          reason: `缺少依赖目录 ${missing.join(", ")}`,
          impact: "该检查未能执行，不能证明对应范围通过",
          howToVerify: "在主 Worktree 安装依赖后重跑 harness verify",
        });
        blocked = true;
        continue;
      }

      linkDependencies(mainRoot, checkout, item.requires ?? []);
      log(`[verify] -> ${item.id}: ${item.cmd.join(" ")}`);
      const outcome = await execute(item.cmd[0], item.cmd.slice(1), {
        cwd: join(checkout, item.cwd),
        env,
        timeoutMs: (config.timeoutSeconds ?? 1800) * 1000,
      });
      results.push({
        id: item.id,
        cmd: item.cmd.join(" "),
        cwd: item.cwd,
        exit: outcome.exit,
        spawnError: outcome.spawnError,
        durationMs: outcome.durationMs,
        note: item.note,
        tail: outcome.exit === 0 ? undefined : outcome.tail,
      });
      log(`[verify]    exit=${outcome.exit} ${outcome.durationMs}ms`);
      if (outcome.spawnError) {
        // 命令不存在时不要报成“检查失败”：该装工具，不是改代码。
        log(`[verify] 注意: 未找到命令 ${item.cmd[0]}，这项检查没有真正执行`);
      }
      if (outcome.exit !== 0 && config.failFast !== false) break;
    }

    const failed = results.filter((item) => item.exit !== 0 && !item.skipped);
    const status = failed.length > 0 ? "failed" : blocked ? "incomplete" : "passed";
    const record = writeRecord(root, EVIDENCE_KIND, key, {
      status,
      head: headCommit,
      recordKey: key,
      base: baseOfHead,
      baseCommit,
      baseRef,
      tree,
      changedCount: changed.length,
      changed: changed.slice(0, 500),
      docOnly,
      checks: results,
      notExecuted,
      advisory,
      reusedChecks: [...reusable.keys()],
      mainDeltaAtVerify: priorMainDelta.length,
      startedAt: started,
      finishedAt: new Date().toISOString(),
    });
    appendLedger(root, {
      event: "verify",
      status,
      tree,
      head: headCommit,
      checks: results.length,
      reused: reusable.size,
      failed: failed.map((item) => item.id),
    });
    return { status, record, results, notExecuted, advisory, changed };
  } finally {
    if (!keepCheckout) git(root, ["worktree", "prune"]);
    if (releaseLock) releaseLock();
    if (parent !== sharedParent) rmSync(parent, { recursive: true, force: true });
  }
}
