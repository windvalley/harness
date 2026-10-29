import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  acceptancePath,
  deliveryAt,
  deliveryChange,
  deliverySettings,
  describeDelivery,
  gatePaths,
  gitHooksConfig,
  loadGateProject,
  mainBranch,
} from "../lib/config.mjs";
import { matchAny } from "../lib/glob.mjs";
import {
  changedPaths,
  git,
  gitOk,
  isAncestor,
  isClean,
  mainWorktreeRoot,
  refExists,
  resolveCommit,
  run,
  statusShort,
  treeOf,
  worktreeEntries,
} from "../lib/git.mjs";
import { appendLedger, dataDir, readRecord, writeRecord } from "../lib/store.mjs";
import { EVIDENCE_KIND, verify, verifyConfigDigest } from "../verify/verify.mjs";
import { entryTouched, followUps } from "../install/followups.mjs";
import { ensureHooksPath } from "../install/install.mjs";
import { REVIEW_KIND } from "../review/review.mjs";
import { approvalState, planEnforced, planRequirement } from "../plan/plan.mjs";
import { MERGE_TOKEN_ENV, mainUpdateToken } from "../githook.mjs";
import { leftoverWorktrees } from "../worktree/clean.mjs";

export class MergeError extends Error {
  constructor(message, code = "merge_refused") {
    super(message);
    this.code = code;
  }
}

export function acquireLock(root) {
  const file = join(dataDir(root), "merge.lock");
  if (existsSync(file)) {
    const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) throw new MergeError(`另一个合并正在进行(pid ${pid})，稍后重试`, "merge_locked");
    rmSync(file, { force: true });
  }
  const fd = openSync(file, "wx");
  writeSync(fd, String(process.pid));
  closeSync(fd);
  return () => rmSync(file, { force: true });
}

/**
 * 主 Worktree 能否接收合并：必须停在主分支、洁净、没有进行中的 git 操作。
 * 合并在这里拒绝；status 与 doctor 提前列出同样的问题，不必等到合并时才发现。
 */
export function mainWorktreeProblems(project, mainRoot) {
  const branch = mainBranch(project);
  const problems = [];
  const current = git(mainRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
  if (current !== branch) problems.push(`主 Worktree 当前不在 ${branch} 分支(实际 ${current || "detached"})`);
  if (!isClean(mainRoot)) problems.push(`主 Worktree 存在未提交或未跟踪文件，先处理后重试:\n${statusShort(mainRoot)}`);
  for (const marker of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]) {
    const probe = git(mainRoot, ["rev-parse", "--git-path", marker]).stdout.trim();
    const abs = probe.startsWith("/") ? probe : join(mainRoot, probe);
    if (existsSync(abs)) problems.push(`主 Worktree 存在进行中的 ${marker.replace("_HEAD", "").toLowerCase()} 操作`);
  }
  return problems;
}

export function ensureMainReady(project, mainRoot) {
  const [first] = mainWorktreeProblems(project, mainRoot);
  if (first) throw new MergeError(first);
}

function checkCommitMessages(project, root, baseCommit, branchCommit) {
  const rule = project.policy.resolved?.find?.((item) => item.kind === "commit-message");
  const pattern = project.config.merge?.commitMessagePattern;
  const forbid = project.config.merge?.forbidMessagePatterns ?? ["^Co-Authored-By:", "^Co-authored-by:"];
  if (!pattern && forbid.length === 0) return [];
  const commits = gitOk(root, ["rev-list", "--no-merges", `${baseCommit}..${branchCommit}`]).split("\n").filter(Boolean);
  const bad = [];
  for (const commit of commits) {
    const message = gitOk(root, ["log", "-1", "--format=%B", commit]).replace(/\n+$/, "");
    if (pattern && !new RegExp(pattern).test(message)) bad.push(`${commit.slice(0, 10)} 格式不符: ${message.split("\n")[0]}`);
    for (const item of forbid) {
      if (new RegExp(item, "im").test(message)) bad.push(`${commit.slice(0, 10)} 命中禁用内容: ${item}`);
    }
  }
  return bad;
}

export function mergeTree(root, mainCommit, branchCommit) {
  const result = git(root, ["merge-tree", "--write-tree", "--no-messages", mainCommit, branchCommit]);
  if (result.status === 0) return { clean: true, tree: result.stdout.trim().split("\n")[0] };
  const conflicts = result.stdout.split("\n").slice(1).filter(Boolean);
  return { clean: false, conflicts, stderr: result.stderr.trim() };
}

function buildMergeCommit(root, tree, mainCommit, branchCommit, subject, body) {
  const message = `${subject}\n\n${body}\n`;
  const res = run("git", ["commit-tree", tree, "-p", mainCommit, "-p", branchCommit, "-m", message], { cwd: root });
  if (res.status !== 0) throw new MergeError(`创建合并提交失败: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

export function planMergeResult({ project, root, branch }) {
  const mainRef = mainBranch(project);
  const mainCommit = resolveCommit(root, mainRef);
  const branchCommit = resolveCommit(root, branch);
  if (isAncestor(root, branchCommit, mainCommit)) {
    throw new MergeError(`${branch} 已经包含在 ${mainRef} 中，无需合并`, "already_merged");
  }
  if (isAncestor(root, mainCommit, branchCommit)) {
    return { fastForward: true, mainCommit, branchCommit, resultTree: treeOf(root, branchCommit), resultCommit: branchCommit };
  }
  const merged = mergeTree(root, mainCommit, branchCommit);
  if (!merged.clean) {
    throw new MergeError(
      `合并存在冲突，需要在任务分支上基于最新 ${mainRef} 解决后重试:\n  ${(merged.conflicts ?? []).join("\n  ") || merged.stderr}`,
      "conflict",
    );
  }
  const subject = `${project.config.merge?.subjectPrefix ?? "Merge: "}${branch}`;
  const body = `- 合并任务分支 ${branch}\n- 合并前 ${mainRef}=${mainCommit.slice(0, 12)} 任务=${branchCommit.slice(0, 12)}`;
  const resultCommit = buildMergeCommit(root, merged.tree, mainCommit, branchCommit, subject, body);
  return { fastForward: false, mainCommit, branchCommit, resultTree: merged.tree, resultCommit };
}

/**
 * 判定已有证据/评审能否沿用。
 * mainDelta：主分支自证据记录以来新增改动的文件集合。
 * 只有当某个检查的触发范围与 mainDelta 无交集时才复用它的结果，
 * 这样 main 前进一次不必整轮重跑，但被波及的检查一定重跑。
 */
export function reuseDecision({ project, root, evidence, mainCommit }) {
  if (evidence?.status !== "passed") return { evidenceReusable: false, rerunChecks: [], configChanged: false, mainDelta: [] };
  const mainDelta = changedPaths(root, evidence.baseCommit, mainCommit);
  // 检查配置变了（新增、删除或改了某项检查），旧证据不再代表当前该跑的检查集，整体交给 verify 按当前配置重算；
  // verify 会按每项检查的定义指纹沿用没变的结果，不会整轮重跑。
  if (evidence.configDigest !== verifyConfigDigest(project)) {
    return { evidenceReusable: false, rerunChecks: [], configChanged: true, mainDelta };
  }
  const plan = (project.verify.checks ?? []).filter((check) => evidence.checks?.some((item) => item.id === check.id));
  const touched = plan.filter((check) => mainDelta.some((path) => matchAny(path, check.when ?? [])));
  return { evidenceReusable: touched.length === 0, rerunChecks: touched.map((check) => check.id), configChanged: false, mainDelta };
}

/**
 * 评审看到的是“评审基线..分支提交”的 diff。主分支之后改了同一批文件时，合并结果里这些文件的内容评审没有看过，
 * 即使三方合并没有文本冲突也不能沿用。返回两边都改过的文件。
 * 早期手写的评审记录可能没有 baseCommit，按分叉点计算，与评审当时算出的基线一致。
 */
export function reviewStaleFiles({ root, review, mainCommit, branchCommit }) {
  const base = review.baseCommit ?? gitOk(root, ["merge-base", mainCommit, branchCommit]);
  const mainDelta = changedPaths(root, base, mainCommit);
  if (mainDelta.length === 0) return [];
  const branchFiles = new Set(changedPaths(root, base, branchCommit));
  return mainDelta.filter((path) => branchFiles.has(path));
}

/**
 * 合并与提交共用的门禁核对。返回固定下来的三个对象：主分支提交、任务提交与预期合并结果的 tree。
 * 任何一项不满足都抛 MergeError，调用方不需要重复判断。
 */
export async function checkGates({ project, root, branch, log = console.error, dryRun = false, label = "merge" }) {
  const bootstrap = Boolean(project.bootstrap);
  const mainRef = mainBranch(project);
  const policy = project.config.merge ?? {};
  const governance = project.config.governance ?? {};

  const mainCommit = resolveCommit(root, mainRef);
  const branchCommit = resolveCommit(root, branch);
  const baseCommit = gitOk(root, ["merge-base", mainCommit, branchCommit]);
  const badMessages = checkCommitMessages(project, root, baseCommit, branchCommit);
  if (badMessages.length > 0) {
    throw new MergeError(`提交信息不符合规范:\n  ${badMessages.join("\n  ")}`, "bad_commit_message");
  }

  const planned = planMergeResult({ project, root, branch });
  const { fastForward, resultTree, resultCommit: newHead } = planned;
  if (bootstrap && !fastForward) {
    throw new MergeError(
      `首次接入要求接入分支包含最新的 ${mainRef}：在分支上 git merge ${mainRef} 或变基后重试`,
      "bootstrap_not_fast_forward",
    );
  }
  if (bootstrap) log(`[${label}] 首次接入：${mainRef} 上还没有门禁配置，按 ${branch} 提议的配置验证，交付前必须由人确认`);
  log(
    fastForward
      ? `[${label}] 可 fast-forward: ${mainCommit.slice(0, 10)} -> ${branchCommit.slice(0, 10)}`
      : `[${label}] 三方合并成功，结果 tree=${resultTree.slice(0, 12)}`,
  );

  const resultPaths = changedPaths(root, mainCommit, newHead);

  // 门禁改动：需要人确认过这一版内容。
  const gate = gatePaths(project).flatMap((glob) => [glob]);
  const gateTouched = resultPaths.filter((path) => matchAny(path, gate));
  // 交付方式决定 Agent 能对远程做什么，它的变化不受 confirmOnGateChange 影响，一律要人确认。
  const before = bootstrap ? null : deliverySettings(project.config);
  let after;
  try {
    after = deliveryAt(root, newHead) ?? deliverySettings(undefined);
  } catch (error) {
    throw new MergeError(`合并结果里的交付设置无法解析: ${error.message}`, "delivery_invalid");
  }
  const change = deliveryChange(before, after);
  // 首次接入引入的是信任根本身，不受 confirmOnGateChange 开关影响，一律要人确认。
  if (bootstrap || change.changed || (governance.confirmOnGateChange !== false && gateTouched.length > 0)) {
    const confirm = readRecord(root, "confirm", resultTree);
    if (!confirm.ok || confirm.record.decision !== "approve") {
      // merge 与 submit 共用这段核对，拒绝信息按调用方说清是哪一步之前要确认。
      const when = label === "submit" ? "提交前" : "合并前";
      const reason = bootstrap
        ? `首次接入会把这个分支里的门禁配置变成主分支的信任根，需要人在${when}确认一次。`
        : change.changed
          ? `本次改动改变了交付设置（${describeChange(change)}），需要人在${when}确认一次。`
          : `本次改动涉及门禁配置或规则(${gateTouched.length} 个文件)，需要人在${when}确认一次。`;
      throw new MergeError(
        [
          reason,
          `  ${(change.changed ? resultPaths.filter((path) => matchAny(path, [".harness/config.json"])) : gateTouched).slice(0, 12).join("\n  ")}`,
          `由人查看并确认: harness confirm --branch ${branch}，确认无误后加 --yes`,
          "Agent 不能代为确认；在 Claude Code 里可以让用户在输入框执行 ! .harness/bin/harness confirm --branch <分支> --yes",
          `确认后重新运行 harness ${label} --branch ${branch}。`,
        ].join("\n"),
        "gate_change_unconfirmed",
      );
    }
    log(`[${label}] 门禁改动已确认(确认人: ${confirm.record.by ?? "user"})`);
  }

  // 方案：写了实施方案、改了库表或改动超过阈值的任务，必须有用户的实施授权记录，且授权后验收清单没有再改。
  // 实时拦截只能约束走了方案流程的任务，这里兜住没写方案就直接做了大改动的情况。
  let approval = null;
  if (planEnforced(project.policy)) {
    const need = planRequirement({ root, project, base: baseCommit, head: branchCommit });
    if (need.reasons.length > 0) {
      const acceptanceText = git(root, ["cat-file", "blob", `${branchCommit}:${acceptancePath(project, branch)}`]);
      const state = approvalState({ root, branch, acceptanceText: acceptanceText.status === 0 ? acceptanceText.stdout : null });
      if (!state.approved) {
        throw new MergeError(
          [
            `这次改动属于先方案后实施的任务（${need.reasons.join("；")}），没有有效的实施授权: ${state.reason}`,
            `先向用户说明方案（验收清单 ${acceptancePath(project, branch)}、行为说明与实施方案）；用户表达开始实施的意思后，`,
            `运行 harness approve --branch ${branch} --yes --note "<用户原话>" 记录授权，再重新运行。`,
            "用户没有同意时不要记录授权。",
          ].join("\n"),
          "plan_unapproved",
        );
      }
      approval = state.record.note;
      log(`[${label}] 已有实施授权(依据: ${state.record.note})`);
    }
  }

  // 意图：行为变更应有验收清单。清单可来自分支本身，会标记来源。
  const intent = project.config.intent ?? {};
  const enforcing = intent.mode ?? "checklist";
  const acceptanceRel = acceptancePath(project, branch);
  const branchAcceptance = git(root, ["cat-file", "blob", `${branchCommit}:${acceptanceRel}`]);
  const mainAcceptance = git(root, ["cat-file", "blob", `${mainRef}:${acceptanceRel}`]);
  const hasAcceptance = branchAcceptance.status === 0 || mainAcceptance.status === 0;
  if (enforcing === "required" && !hasAcceptance) {
    throw new MergeError(
      `本任务缺少验收清单: ${acceptanceRel}\n先写清单并提交，它会被独立评审用来核对需求符合度。`,
      "intent_missing",
    );
  }
  if (enforcing !== "off" && !hasAcceptance) {
    log(`[${label}] 注意: 没有验收清单，独立评审只能评工程质量，需求符合度会记为 unknown`);
  }

  // 证据：优先复用，只重跑被 main 前进波及的检查。合并与提交都要有绑定任务提交的证据。
  let evidenceRecord = null;
  let reviewRecord = null;
  if (policy.requireEvidence !== false) {
    let evidence = readRecord(root, EVIDENCE_KIND, branchCommit);
    let review = readRecord(root, REVIEW_KIND, branchCommit);
    const reuse = evidence.ok
      ? reuseDecision({ project, root, evidence: evidence.record, mainCommit })
      : { evidenceReusable: false, rerunChecks: [], configChanged: false };

    if (evidence.ok && reuse.evidenceReusable) {
      log(
        `[${label}] 复用已验证证据: 主分支新增改动未触及任何已执行的检查` +
          (evidence.record.reusedChecks?.length ? `(其中 ${evidence.record.reusedChecks.length} 项为再复用)` : ""),
      );
    } else {
      if (evidence.ok && reuse.configChanged) log(`[${label}] 检查配置在验证之后有变化，按当前配置重新验证`);
      else if (evidence.ok) log(`[${label}] 主分支改动波及 ${reuse.rerunChecks.join(", ") || "多项检查"}，重新验证`);
      else log(`[${label}] 没有针对该分支的验证证据(${evidence.reason})，先验证`);
      const outcome = await verify({ cwd: root, head: newHead, recordKey: branchCommit, base: mainRef, gateBranch: branch, log });
      if (outcome.status !== "passed") {
        throw new MergeError(`验证未通过(${outcome.status})，已拒绝`, "verify_failed");
      }
      evidence = readRecord(root, EVIDENCE_KIND, branchCommit);
      review = readRecord(root, REVIEW_KIND, branchCommit);
    }

    if (!evidence.ok || evidence.record.status !== "passed") {
      throw new MergeError(`证据无效: ${evidence.reason ?? evidence.record.status}`, "evidence_invalid");
    }
    evidenceRecord = evidence.record;

    if (policy.requireReview !== false) {
      // 不只信 verdict：记录里存在阻断级发现时，即使评审写了 approve 也不能放行。
      const blocking = review.ok ? (review.record.blocking ?? []) : [];
      const reviewReusable =
        review.ok &&
        review.record.verdict === "approve" &&
        review.record.reviewedCommit === branchCommit &&
        blocking.length === 0;
      if (reviewReusable) {
        const stale = reviewStaleFiles({ root, review: review.record, mainCommit, branchCommit });
        if (stale.length > 0) {
          throw new MergeError(
            [
              `主分支在评审之后改了本分支也改过的文件（${stale.length} 个），合并结果里这些文件的内容没有经过评审:`,
              `  ${stale.slice(0, 12).join("\n  ")}`,
              `在任务分支上 git merge ${mainRef}（或变基到 ${mainRef}）并提交，再重新运行 harness verify 与 harness review --branch ${branch}`,
            ].join("\n"),
            "review_stale",
          );
        }
        log(`[${label}] 复用该分支已通过的独立评审`);
      } else {
        throw new MergeError(
          review.ok
            ? `独立评审结论是 ${review.record.verdict}，不能继续。修复后重新运行 harness review --branch ${branch}`
            : `缺少对该分支的独立评审: ${review.reason}。运行 harness review --branch ${branch}`,
          review.ok ? "review_blocked" : "review_missing",
        );
      }
      reviewRecord = review.record;
    }
  }

  if (dryRun) log(`[${label}] dry-run: 全部门禁通过，未更新主分支`);
  return {
    bootstrap,
    mainRef,
    mainCommit,
    branchCommit,
    baseCommit,
    fastForward,
    resultTree,
    newHead,
    resultPaths,
    gateTouched,
    delivery: { before, after, changed: change.changed },
    evidence: evidenceRecord,
    review: reviewRecord,
    approval,
    dryRun,
  };
}

export function describeChange(change) {
  return `${describeDelivery(change.before)} -> ${describeDelivery(change.after)}`;
}

/**
 * 把主分支更新到合并结果。bootstrap 走 git merge --ff-only，让随分支入库的钩子先落在工作区；
 * 其余场景用带合并令牌的 update-ref 加 read-tree，令牌由 harness merge 与 harness sync 生成。
 */
export function advanceMain({ project, mainRoot, mainRef, mainCommit, newHead, resultTree, bootstrap, branch, log = console.error }) {
  if (bootstrap) {
    // 首次接入用快进合并：git 先检出新文件再更新引用，随分支入库的钩子（例如 husky）此时已是新内容。
    // 共用钩子目录里的原有主分支保护如果没有被接管，会在这里拒绝，报错给出处理方式。
    const ff = run("git", ["merge", "--ff-only", "--no-edit", newHead], { cwd: mainRoot });
    if (ff.status !== 0) {
      // git 先检出文件、再更新引用；引用被钩子拒绝时文件已经换成分支内容。
      // 合并前已确认主 Worktree 洁净，这里把检出的内容退回主分支，主 Worktree 恢复原样。
      if (resolveCommit(mainRoot, "HEAD") === mainCommit) run("git", ["reset", "-q", "--hard", mainCommit], { cwd: mainRoot });
      throw new MergeError(
        [
          `快进 ${mainRef} 失败: ${(ff.stderr || ff.stdout).trim().split("\n").slice(-6).join("\n")}`,
          "如果是原有的主分支保护拒绝了这次更新：在接入分支重新运行 harness init --take-over 由 harness 接管，提交后重新验证、确认并合并；",
          "或者按原有工具自己的方式合入这个分支。",
        ].join("\n"),
        "bootstrap_update_refused",
      );
    }
  } else {
    const update = run(
      "git",
      ["update-ref", "-m", `harness ${branch ? `merge ${branch}` : "sync"}`, `refs/heads/${mainRef}`, newHead, mainCommit],
      { cwd: mainRoot, env: { ...process.env, [MERGE_TOKEN_ENV]: mainUpdateToken(mainCommit, newHead) } },
    );
    if (update.status !== 0) throw new MergeError(`更新 ${mainRef} 失败: ${update.stderr.trim()}`);

    const sync = run("git", ["read-tree", "-m", "-u", mainCommit, newHead], { cwd: mainRoot });
    if (sync.status !== 0) {
      run("git", ["update-ref", "-m", "harness rollback", `refs/heads/${mainRef}`, mainCommit, newHead], {
        cwd: mainRoot,
        env: { ...process.env, [MERGE_TOKEN_ENV]: mainUpdateToken(newHead, mainCommit) },
      });
      throw new MergeError(`主 Worktree 同步文件失败，已回退 ${mainRef}: ${sync.stderr.trim()}`, "worktree_sync_failed");
    }
  }

  const mainTree = treeOf(mainRoot, "HEAD");
  if (mainTree !== resultTree) throw new MergeError(`更新后 ${mainRef} 的 tree 与预期不一致`, "tree_mismatch");
  if (!isClean(mainRoot)) throw new MergeError(`更新后主 Worktree 不洁净:\n${statusShort(mainRoot)}`, "worktree_dirty");
}

/**
 * 主分支更新之后要做的事：入口变化时刷新本机安装、列出客户端那一侧的动作、执行合并后命令。
 * label 只影响日志前缀，merge 与 sync 共用同一段逻辑。
 */
export function afterMainUpdate({ project, root, mainRoot, resultPaths, bootstrap, hooksDirBefore, policy, log, label, branch = null }) {
  let refresh = null;
  if (bootstrap || entryTouched(resultPaths, project)) {
    const shim = join(mainRoot, ".harness", "bin", "harness");
    if (existsSync(shim)) {
      const result = run(shim, ["install", "--local"], { cwd: mainRoot });
      refresh = { exit: result.status };
      const hooksPathLine = result.stdout.split("\n").find((line) => line.includes("core.hooksPath"));
      if (hooksPathLine) log(`[${label}] ${hooksPathLine.trim()}`);
      if (result.status !== 0) log(`[${label}] 注意: 刷新本机钩子失败(exit ${result.status})，在主 Worktree 运行 harness install --local: ${result.stderr.trim().slice(-300)}`);
      if (!isClean(mainRoot)) log(`[${label}] 注意: 刷新后主 Worktree 出现改动，说明分支里的入口不是用当前版本生成的:\n${statusShort(mainRoot)}`);
    }
  }
  const notes = followUps({ mainRoot, changed: resultPaths, bootstrap, hooksDirBefore });

  let postMerge = null;
  if (Array.isArray(policy.postMergeCommand) && policy.postMergeCommand.length > 0) {
    const [cmd, ...args] = policy.postMergeCommand;
    log(`[${label}] 执行合并后同步: ${policy.postMergeCommand.join(" ")} (主 Worktree)`);
    const post = run(cmd, args, { cwd: mainRoot });
    postMerge = { exit: post.status, tail: (post.stdout + post.stderr).split("\n").slice(-20).join("\n") };
    if (post.status !== 0) {
      appendLedger(root, { event: `${label}.post_failed`, branch, exit: post.status });
      throw new MergeError(
        `主分支已经更新，但合并后同步失败(exit ${post.status})，不得启动服务，也不得宣称完成:\n${postMerge.tail}`,
        "post_merge_failed",
      );
    }
  }
  return { refresh, notes, postMerge };
}

export async function mergeTask({ cwd, branch, dryRun = false, log = console.error }) {
  // 首次接入时主分支还没有配置，按接入分支提议的配置执行，并强制要求人工确认。
  const project = loadGateProject(cwd, { branch });
  const bootstrap = Boolean(project.bootstrap);
  const root = project.root;
  const mainRef = mainBranch(project);
  const policy = project.config.merge ?? {};

  if (!branch) throw new MergeError("必须指定要合并的任务分支: --branch <name>");
  if (branch === mainRef) throw new MergeError("不能把主分支合并到自身");
  if (!refExists(root, branch)) throw new MergeError(`分支不存在: ${branch}`);

  // 远程交付下主分支只由 harness sync 快进；本地再合并会与远程分叉，之后 submit 也会因基线不一致被拒绝。
  const delivery = deliverySettings(project.config);
  if (delivery.mode === "remote") {
    throw new MergeError(
      [
        `当前是远程交付（${delivery.provider}，远程 ${delivery.remote}），不合并到本地主分支。`,
        `改为运行 harness submit --branch ${branch}，由平台合并；平台合入后用 harness sync 更新本地主分支。`,
      ].join("\n"),
      "delivery_remote",
    );
  }

  const mainRoot = mainWorktreeRoot(root);
  const release = acquireLock(root);
  try {
    ensureMainReady(project, mainRoot);

    // 项目接管了钩子目录时，core.hooksPath 可能被旧分支里的工具改走（例如 husky 的 prepare 在依赖安装时改回自己的目录），
    // 指向不存在的目录时 git 静默跳过钩子。更新主分支前改回来，主分支保护按主 Worktree 里确认过的钩子执行。
    const hooks = gitHooksConfig(project.config);
    if (hooks) {
      const healed = ensureHooksPath({ root: mainRoot, hooks });
      if (healed.state === "switched") log(`[merge] core.hooksPath 被改成了 ${healed.previous ?? "(未设置)"}，已改回 ${healed.target}`);
    }

    const gates = await checkGates({ project, root, branch, log, dryRun });
    const { mainCommit, branchCommit, fastForward, resultTree, newHead, resultPaths, gateTouched } = gates;
    if (dryRun) return { dryRun: true, fastForward, newHead, resultTree, gateTouched };

    const latestMain = resolveCommit(root, mainRef);
    if (latestMain !== mainCommit) {
      throw new MergeError(
        `${mainRef} 在合并过程中前进了(${mainCommit.slice(0, 10)} -> ${latestMain.slice(0, 10)})，重新运行 harness merge 即可复用已有证据`,
        "main_moved",
      );
    }

    advanceMain({ project, mainRoot, mainRef, mainCommit, newHead, resultTree, bootstrap, branch, log });

    appendLedger(root, { event: "merge", branch, fastForward, head: newHead, tree: resultTree, base: mainCommit, bootstrap });
    log(`[merge] ${mainRef} 已更新到 ${newHead.slice(0, 12)}`);

    const { refresh, notes, postMerge } = afterMainUpdate({
      project,
      root,
      mainRoot,
      resultPaths,
      bootstrap,
      hooksDirBefore: gitHooksConfig(project.config)?.hooksDir ?? null,
      policy,
      log,
      label: "merge",
      branch,
    });

    // 任务 Worktree 合并后保留：会话常常还停在里面，也可能要回来补改。需要时由用户运行 harness worktree clean 清理。
    try {
      const own = worktreeEntries(mainRoot).find((entry) => entry.branch === branch);
      const leftover = leftoverWorktrees({ root: mainRoot, mainRef }).length;
      if (own || leftover > 0) {
        log(`[merge] ${own ? `任务 Worktree 保留在 ${own.path}；` : ""}已合并但还没清理的 Worktree 有 ${leftover} 个，需要时运行 harness worktree clean 预览后清理`);
      }
    } catch {
      // 只是提示，读不到 Worktree 列表不影响合并结果。
    }

    return { dryRun: false, bootstrap, fastForward, newHead, resultTree, gateTouched, postMerge, refresh, followUps: notes };
  } finally {
    release();
  }
}

export { writeRecord };
