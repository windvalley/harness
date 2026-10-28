import { PROJECT_DIR, deliveryAt, deliverySettings, gatePaths, gitHooksConfig, loadProject, loadTrustedProject, mainBranch } from "../lib/config.mjs";
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
function planSync({ root, remote, mainRef }) {
  const relay = fetchRemoteMain({ root, remote, mainRef, run });
  const target = resolveCommit(root, relay);
  const local = resolveCommit(root, mainRef);
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
function syncConfirmRequired({ project, root, remote, mainRef, local, target }) {
  const before = deliverySettings(project.config);
  let after = before;
  try {
    after = deliveryAt(root, target) ?? deliverySettings(undefined);
  } catch (error) {
    throw new MergeError(`目标提交里的交付设置无法解析: ${error.message}`, "delivery_invalid");
  }
  const change = deliveryChangeOf(before, after);
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

function deliveryChangeOf(before, after) {
  // 与 config.deliveryChange 相同，这里单独算一次是为了拿到 before/after 便于描述。
  const same = before.mode === after.mode && before.remote === after.remote && before.provider === after.provider;
  return { before, after, changed: !same };
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
export function syncTask({ cwd, log = console.error }) {
  const bootstrap = !harnessConfigOnMain(cwd);
  const root = repoRootOf(cwd);
  // 首次接入时本地主分支还没有配置，远程名只能先按约定取 origin；其余判定等取到目标提交再按它的配置做。
  const trusted = bootstrap ? null : loadTrustedProject(root);
  const remote = bootstrap ? "origin" : deliverySettings(trusted.config).remote;
  const mainRef = bootstrap ? "main" : mainBranch(trusted);
  const planned = planSync({ root, remote, mainRef });
  if (planned.upToDate) {
    log(`[sync] ${mainRef} 已是最新(${planned.local.slice(0, 10)})`);
    return { upToDate: true, mainRef, remote, head: planned.local, changed: 0 };
  }

  const { target, local } = planned;
  // 首次接入：目标提交自带配置，用它判断门禁范围；确认则由“首次接入”这件事本身要求。
  const project = bootstrap ? bootstrapProject(root, target) : trusted;
  const gate = syncConfirmRequired({ project, root, remote, mainRef, local, target });
  const targetTree = gitOk(root, ["rev-parse", "--verify", `${target}^{tree}`]);

  if (gate.required) {
    const confirm = readConfirm({ root, tree: gitOk(root, ["rev-parse", "--verify", `${target}^{tree}`]) });
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
  const pinned = pinnedVersionAt(root, target);
  if (pinned && pinned !== packageVersion() && !verifyVersion({ version: pinned }).ok) {
    throw new MergeError(
      [
        `目标提交锁定 harness ${pinned}，本机只装了 ${listVersions().join("、") || "无"}。`,
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
