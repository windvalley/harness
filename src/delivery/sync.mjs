import { PROJECT_DIR, deliveryAt, deliveryChange, deliverySettings, gatePaths, gitHooksConfig, loadProject, mainBranch } from "../lib/config.mjs";
import { matchAny } from "../lib/glob.mjs";
import { changedPaths, git, gitOk, isAncestor, mainWorktreeRoot, resolveCommit, run } from "../lib/git.mjs";
import { appendLedger, readRecord } from "../lib/store.mjs";
import { MergeError, acquireLock, afterMainUpdate, advanceMain, describeChange, mainWorktreeProblems } from "../merge/merge.mjs";
import { ensureHooksPath } from "../install/install.mjs";
import { CONFIRM_KIND } from "../confirm/confirm.mjs";
import { fetchRemoteMain, pinnedVersionAt } from "./remote.mjs";
import { packageVersion } from "../install/managed.mjs";
import { listVersions, verifyVersion } from "../install/install.mjs";

/**
 * 确定同步目标：远程跟踪引用必须真实存在，且本地主分支是它的祖先。
 * 本地主分支有远程没有的提交时拒绝，绝不改写历史：那是本地绕过平台产生的提交，需要人判断怎么处理。
 */
function planSync({ root, remote, mainRef, local }) {
  const relay = fetchRemoteMain({ root, remote, mainRef, run });
  const target = resolveCommit(root, relay);
  if (target === local) return { relay, target, local, upToDate: true };
  if (!isAncestor(root, local, target)) {
    throw new MergeError(
      [
        `本地 ${mainRef} 与 ${remote}/${mainRef} 已分叉，不能快进。`,
        `本地多出的提交: ${gitOk(root, ["rev-list", "--count", `${target}..${local}`]).trim()} 个；`,
        "远程交付下主分支只由平台合并产生，本地多出的提交通常是绕开平台直接提交或合并的。",
        `先弄清这些提交的来源；确实要以远程为准时，由人明确授权后自行处理，harness 不改写历史。`,
      ].join("\n"),
      "not_fast_forward",
    );
  }
  return { relay, target, local, upToDate: false };
}

/** 同步要看门禁改动、交付设置变化与版本锁定，确认记录绑定目标 tree，与 confirm 的算法一致。 */
function syncConfirmRequired({ project, root, remote, local, target }) {
  const before = deliverySettings(project.config);
  let after = before;
  try {
    after = deliveryAt(root, target) ?? deliverySettings(undefined);
  } catch (error) {
    throw new MergeError(`目标提交里的交付设置无法解析: ${error.message}`, "delivery_invalid");
  }
  const change = deliveryChange(before, after);
  const paths = changedPaths(root, local, target);
  const gate = gatePaths(project);
  const gateTouched = paths.filter((path) => matchAny(path, gate));
  const bootstrap = Boolean(project.bootstrap);
  const confirmOnGateChange = project.config.governance?.confirmOnGateChange !== false;
  return {
    before,
    after,
    change,
    paths,
    gateTouched,
    required: bootstrap || change.changed || (confirmOnGateChange && gateTouched.length > 0),
    bootstrap,
  };
}

function readConfirm({ root, tree }) {
  const record = readRecord(root, CONFIRM_KIND, tree);
  if (!record.ok) return { ok: false, reason: record.reason };
  return record.record.decision === "approve" ? { ok: true, record: record.record } : { ok: false, reason: `确认记录的决定是 ${record.record.decision}` };
}

/**
 * 把本地主分支快进到远程主分支。
 * 本地模式同样可用，替代手册里由人用 HARNESS_MAIN_BYPASS 快进的做法。
 * 远程带来的普通代码改动按“信任平台主分支”导入，本机不再重复验证和评审；
 * 门禁改动、交付设置变化与首次接入仍然要人确认，因为它们改变的是门禁本身。
 */
export function syncTask({ cwd, remote: requestedRemote = null, log = console.error }) {
  const bootstrap = !harnessConfigOnMain(cwd);
  const root = repoRootOf(cwd);
  // 首次接入时本地主分支还没有配置，按仓库里真实存在的分支名处理；其余判定等取到目标提交再按它的配置做。
  const mainRef = bootstrap ? detectMainBranch(root) : mainBranch(loadProjectFromMain(root));
  // 配置与基线必须来自同一个提交：先固定本地主分支，再按那个提交读配置。
  // 否则 fetch 之前读到 C0 的配置、之后拿到 C1 作为基线，就会用旧配置判断新基线到远程的门禁改动。
  const local = resolveCommit(root, mainRef);
  const trusted = bootstrap ? null : loadProject(root, { fromRef: local, root });
  const configured = bootstrap ? null : deliverySettings(trusted.config).remote;
  if (configured && requestedRemote && requestedRemote !== configured) {
    throw new MergeError(
      `已接入的项目从主分支配置的 delivery.remote(${configured}) 同步，--remote 只在首次接入时使用。改远程要在任务分支修改配置并经确认合入。`,
      "remote_fixed",
    );
  }
  // 首次接入时还没有可信的配置可读，远程名由人用 --remote 指定（默认 origin），取到目标提交后再与它的配置核对。
  const remote = configured ?? requestedRemote ?? "origin";
  const planned = planSync({ root, remote, mainRef, local });
  if (planned.upToDate) {
    log(`[sync] ${mainRef} 已是最新(${planned.local.slice(0, 10)})`);
    return { upToDate: true, mainRef, remote, head: planned.local, changed: 0 };
  }

  const { target } = planned;
  // 首次接入：目标提交自带配置，用它判断门禁范围；确认则由“首次接入”这件事本身要求。
  const project = bootstrap ? bootstrapProject(root, target) : trusted;
  if (bootstrap) {
    const proposed = deliverySettings(project.config);
    if (proposed.remote !== remote || mainBranch(project) !== mainRef) {
      throw new MergeError(
        [
          `首次接入：从 ${remote}/${mainRef} 取得的配置写的是远程 ${proposed.remote}、主分支 ${mainBranch(project)}，与本次同步的来源不一致。`,
          `按配置里的远程重试: harness sync --remote ${proposed.remote}；主分支名不一致时先在接入分支修正 mainBranch。`,
        ].join("\n"),
        "bootstrap_mismatch",
      );
    }
  }
  const gate = syncConfirmRequired({ project, root, remote, local, target });
  const targetTree = gitOk(root, ["rev-parse", "--verify", `${target}^{tree}`]);

  if (gate.required) {
    const confirm = readConfirm({ root, tree: targetTree });
    if (!confirm.ok) {
      const reason = gate.bootstrap
        ? "主分支上还没有门禁配置，这次同步会把它变成信任根，需要人在同步前确认一次。"
        : gate.change.changed
          ? `远程改动了交付设置（${describeChange(gate.change)}），需要人在同步前确认一次。`
          : `远程改动了门禁配置或规则(${gate.gateTouched.length} 个文件)，需要人在同步前确认一次。`;
      throw new MergeError(
        [
          reason,
          `  ${(gate.change.changed ? gate.paths.filter((path) => path === ".harness/config.json") : gate.gateTouched).slice(0, 12).join("\n  ")}`,
          `由人查看并确认: harness confirm --branch ${remote}/${mainRef}`,
          "Agent 不能代为确认；在 Claude Code 里可以让用户在输入框执行 ! .harness/bin/harness confirm --branch " + `${remote}/${mainRef} --yes`,
          "确认后重新运行 harness sync。",
        ].join("\n"),
        "gate_change_unconfirmed",
      );
    }
    log(`[sync] 门禁改动已确认(确认人: ${confirm.record.by ?? "user"})`);
  }

  // 目标提交锁定的版本本机没装时，更新之后本机跑的门禁就和目标不一致，必须在更新之前拒绝。
  // 不拿进程里的版本号当“已安装”：用源码仓库直接运行 sync 时，目标锁定的版本可能恰好
  // 等于运行版本，但版本目录里并没有它，更新之后新入口就跑不起来。
  const lock = pinnedVersionAt(root, target);
  if (lock.mismatch) {
    throw new MergeError(
      [
        `目标提交里 .harness/VERSION 锁定 ${lock.file}，入口 .harness/bin/harness 锁定 ${lock.shim}，两者不一致。`,
        "钩子按入口里的版本运行，本机安装按 VERSION 选择版本，不一致时两边跑的不是同一份门禁。",
        "需要在平台上修正：在任务分支运行 harness upgrade 重新生成入口与 VERSION，合入后再 sync。",
      ].join("\n"),
      "version_mismatch",
    );
  }
  const pinned = lock.version;
  if (pinned && !verifyVersion({ version: pinned }).ok) {
    throw new MergeError(
      [
        `目标提交锁定 harness ${pinned}，本机版本目录里没有可用的一份（已装: ${listVersions().join("、") || "无"}）。`,
        `由人在项目目录运行 node <harness 仓库>/bin/harness.mjs install --version ${pinned}（不改项目文件），然后重新运行 harness sync。`,
        "在装好之前不更新本地主分支，避免本机钩子与新主分支的门禁版本对不上。",
      ].join("\n"),
      "version_missing",
    );
  }

  const mainRoot = mainWorktreeRoot(root);
  const policy = project.config.merge ?? {};
  const release = acquireLock(root);
  try {
    const problems = mainWorktreeProblems(project, mainRoot);
    if (problems.length > 0) throw new MergeError(problems[0], "main_not_ready");

    const hooks = gitHooksConfig(project.config);
    if (hooks) {
      const healed = ensureHooksPath({ root: mainRoot, hooks });
      if (healed.state === "switched") log(`[sync] core.hooksPath 被改成了 ${healed.previous ?? "(未设置)"}，已改回 ${healed.target}`);
    }

    const latest = resolveCommit(root, mainRef);
    if (latest !== local) {
      throw new MergeError(`${mainRef} 在同步过程中前进了(${local.slice(0, 10)} -> ${latest.slice(0, 10)})，重新运行 harness sync`, "main_moved");
    }

    // 同步在本地是快进：目标 tree 就是目标的 tree，没有三方合并。
    advanceMain({
      project,
      mainRoot,
      mainRef,
      mainCommit: local,
      newHead: target,
      resultTree: targetTree,
      bootstrap: false,
      branch: null,
      log,
    });
    appendLedger(root, { event: "sync", mainRef, remote, from: local, to: target, gateFiles: gate.gateTouched.length });
    log(`[sync] ${mainRef} 已快进到 ${target.slice(0, 12)}（来自 ${remote}/${mainRef}）`);

    const after = afterMainUpdate({
      project,
      root,
      mainRoot,
      resultPaths: gate.paths,
      bootstrap: false,
      hooksDirBefore: gitHooksConfig(project.config)?.hooksDir ?? null,
      policy,
      log,
      label: "sync",
    });

    return {
      upToDate: false,
      mainRef,
      remote,
      from: local,
      head: target,
      changed: gate.paths.length,
      gateFiles: gate.gateTouched,
      delivery: gate.change.changed ? describeChange(gate.change) : null,
      postMerge: after.postMerge,
      followUps: after.notes,
    };
  } finally {
    release();
  }
}

/**
 * 配置一律从本地主分支读：同步的对象是主分支，判定依据应当是同步前的状态。
 * 目标提交上都没有配置，说明这个仓库还没接入 harness，快进只是拉代码，不需要门禁判定。
 */
function bootstrapProject(root, target) {
  const loaded = loadProject(root, { fromRef: target, root });
  return { ...loaded, bootstrap: true };
}

/** 首次接入时按仓库实际存在的分支名确定主分支，不写死某个名字。 */
function detectMainBranch(root) {
  for (const name of ["main", "master"]) {
    if (git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).status === 0) return name;
  }
  return "main";
}

function loadProjectFromMain(root) {
  const ref = detectMainBranch(root);
  return { config: loadProject(root, { fromRef: ref, root }).config };
}

function harnessConfigOnMain(cwd) {
  const root = repoRootOf(cwd);
  for (const ref of ["main", "master"]) {
    if (git(root, ["cat-file", "-e", `${ref}:${PROJECT_DIR}/config.json`]).status === 0) return true;
  }
  return false;
}

function repoRootOf(cwd) {
  return gitOk(cwd, ["rev-parse", "--show-toplevel"]);
}
