import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { acceptancePath, gatePaths, loadTrustedProject, mainBranch } from "../lib/config.mjs";
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
  treeOf,
} from "../lib/git.mjs";
import { appendLedger, dataDir, readRecord, writeRecord } from "../lib/store.mjs";
import { EVIDENCE_KIND, reusableChecks, verify } from "../verify/verify.mjs";
import { REVIEW_KIND } from "../review/review.mjs";
import { MERGE_TOKEN_ENV, mainUpdateToken } from "../githook.mjs";

export class MergeError extends Error {
  constructor(message, code = "merge_refused") {
    super(message);
    this.code = code;
  }
}

function acquireLock(root) {
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

function ensureMainReady(project, mainRoot) {
  const branch = mainBranch(project);
  const current = git(mainRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
  if (current !== branch) throw new MergeError(`主 Worktree 当前不在 ${branch} 分支(实际 ${current || "detached"})`);
  if (!isClean(mainRoot)) {
    throw new MergeError(`主 Worktree 存在未提交或未跟踪文件，先处理后重试:\n${gitOk(mainRoot, ["status", "--short"])}`);
  }
  for (const marker of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]) {
    const probe = git(mainRoot, ["rev-parse", "--git-path", marker]).stdout.trim();
    const abs = probe.startsWith("/") ? probe : join(mainRoot, probe);
    if (existsSync(abs)) throw new MergeError(`主 Worktree 存在进行中的 ${marker.replace("_HEAD", "").toLowerCase()} 操作`);
  }
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
export function reuseDecision({ project, root, evidence, review, mainCommit, branchCommit }) {
  const checksTouched = [];
  let reusable = false;
  if (evidence?.status === "passed") {
    const mainDelta = changedPaths(root, evidence.baseCommit, mainCommit);
    const plan = (project.verify.checks ?? []).filter((check) => evidence.checks?.some((item) => item.id === check.id));
    const touched = plan.filter((check) => mainDelta.some((path) => matchAny(path, check.when ?? [])));
    checksTouched.push(...touched.map((check) => check.id));
    reusable = touched.length === 0;
  }

  let reviewReusable = false;
  if (review?.verdict === "approve" && review.reviewedCommit === branchCommit && evidence) {
    const mainDelta = changedPaths(root, evidence.baseCommit, mainCommit);
    const branchFiles = changedPaths(root, evidence.base, branchCommit);
    reviewReusable = !mainDelta.some((path) => branchFiles.includes(path));
  }

  return { evidenceReusable: reusable, rerunChecks: checksTouched, reviewReusable };
}

export async function mergeTask({ cwd, branch, dryRun = false, log = console.error }) {
  const project = loadTrustedProject(cwd);
  const root = project.root;
  const mainRef = mainBranch(project);
  const policy = project.config.merge ?? {};
  const governance = project.config.governance ?? {};

  if (!branch) throw new MergeError("必须指定要合并的任务分支: --branch <name>");
  if (branch === mainRef) throw new MergeError("不能把主分支合并到自身");
  if (!refExists(root, branch)) throw new MergeError(`分支不存在: ${branch}`);

  const mainRoot = mainWorktreeRoot(root);
  const release = acquireLock(root);
  try {
    ensureMainReady(project, mainRoot);

    const mainCommit = resolveCommit(root, mainRef);
    const branchCommit = resolveCommit(root, branch);
    const baseCommit = gitOk(root, ["merge-base", mainCommit, branchCommit]);
    const badMessages = checkCommitMessages(project, root, baseCommit, branchCommit);
    if (badMessages.length > 0) {
      throw new MergeError(`提交信息不符合规范:\n  ${badMessages.join("\n  ")}`, "bad_commit_message");
    }

    const planned = planMergeResult({ project, root, branch });
    const { fastForward, resultTree, resultCommit: newHead } = planned;
    log(
      fastForward
        ? `[merge] 可 fast-forward: ${mainCommit.slice(0, 10)} -> ${branchCommit.slice(0, 10)}`
        : `[merge] 三方合并成功，结果 tree=${resultTree.slice(0, 12)}`,
    );

    const resultPaths = changedPaths(root, mainCommit, newHead);

    // 门禁改动：需要人确认过这一版内容。
    const gate = gatePaths(project).flatMap((glob) => [glob]);
    const gateTouched = resultPaths.filter((path) => matchAny(path, gate));
    if (governance.confirmOnGateChange !== false && gateTouched.length > 0) {
      const confirm = readRecord(root, "confirm", resultTree);
      if (!confirm.ok || confirm.record.decision !== "approve") {
        throw new MergeError(
          [
            `本次改动涉及门禁配置或规则(${gateTouched.length} 个文件)，需要你在合并前确认一次。`,
            `  ${gateTouched.slice(0, 12).join("\n  ")}`,
            "查看并确认: harness confirm --branch <分支>",
            "确认后重新运行 harness merge。",
          ].join("\n"),
          "gate_change_unconfirmed",
        );
      }
      log(`[merge] 门禁改动已确认(确认人: ${confirm.record.by ?? "user"})`);
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
      log(`[merge] 注意: 没有验收清单，独立评审只能评工程质量，需求符合度会记为 unknown`);
    }

    // 证据：优先复用，只重跑被 main 前进波及的检查。
    if (policy.requireEvidence !== false) {
      let evidence = readRecord(root, EVIDENCE_KIND, branchCommit);
      let review = readRecord(root, REVIEW_KIND, branchCommit);
      const reuse = evidence.ok
        ? reuseDecision({ project, root, evidence: evidence.record, review: review.ok ? review.record : null, mainCommit, branchCommit })
        : { evidenceReusable: false, rerunChecks: [], reviewReusable: false };

      if (evidence.ok && reuse.evidenceReusable) {
        log(
          `[merge] 复用已验证证据: 主分支新增改动未触及任何已执行的检查` +
            (evidence.record.reusedChecks?.length ? `(其中 ${evidence.record.reusedChecks.length} 项为再复用)` : ""),
        );
      } else {
        if (evidence.ok) log(`[merge] 主分支改动波及 ${reuse.rerunChecks.join(", ") || "多项检查"}，重新验证`);
        else log(`[merge] 没有针对该分支的验证证据(${evidence.reason})，先验证`);
        const outcome = await verify({ cwd: root, head: newHead, recordKey: branchCommit, base: mainRef, log });
        if (outcome.status !== "passed") {
          throw new MergeError(`验证未通过(${outcome.status})，已拒绝合并`, "verify_failed");
        }
        evidence = readRecord(root, EVIDENCE_KIND, branchCommit);
        review = readRecord(root, REVIEW_KIND, branchCommit);
      }

      if (!evidence.ok || evidence.record.status !== "passed") {
        throw new MergeError(`证据无效: ${evidence.reason ?? evidence.record.status}`, "evidence_invalid");
      }

      if (policy.requireReview !== false) {
        // 不只信 verdict：记录里存在阻断级发现时，即使评审写了 approve 也不能放行。
        const blocking = review.ok ? (review.record.blocking ?? []) : [];
        const reviewReusable =
          review.ok &&
          review.record.verdict === "approve" &&
          review.record.reviewedCommit === branchCommit &&
          blocking.length === 0;
        if (reviewReusable) {
          log("[merge] 复用该分支已通过的独立评审");
        } else {
          throw new MergeError(
            review.ok
              ? `独立评审结论是 ${review.record.verdict}，不能合并。修复后重新运行 harness review --branch ${branch}`
              : `缺少对该分支的独立评审: ${review.reason}。运行 harness review --branch ${branch}`,
            review.ok ? "review_blocked" : "review_missing",
          );
        }
      }
    }

    if (dryRun) {
      log("[merge] dry-run: 全部门禁通过，未更新主分支");
      return { dryRun: true, fastForward, newHead, resultTree, gateTouched };
    }

    const latestMain = resolveCommit(root, mainRef);
    if (latestMain !== mainCommit) {
      throw new MergeError(
        `${mainRef} 在合并过程中前进了(${mainCommit.slice(0, 10)} -> ${latestMain.slice(0, 10)})，重新运行 harness merge 即可复用已有证据`,
        "main_moved",
      );
    }

    const update = run(
      "git",
      ["update-ref", "-m", `harness merge ${branch}`, `refs/heads/${mainRef}`, newHead, mainCommit],
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

    const mainTree = treeOf(mainRoot, "HEAD");
    if (mainTree !== resultTree) throw new MergeError(`合并后 ${mainRef} 的 tree 与预期不一致`, "tree_mismatch");
    if (!isClean(mainRoot)) throw new MergeError(`合并后主 Worktree 不洁净:\n${gitOk(mainRoot, ["status", "--short"])}`, "worktree_dirty");

    appendLedger(root, { event: "merge", branch, fastForward, head: newHead, tree: resultTree, base: mainCommit });
    log(`[merge] ${mainRef} 已更新到 ${newHead.slice(0, 12)}`);

    let postMerge = null;
    if (Array.isArray(policy.postMergeCommand) && policy.postMergeCommand.length > 0) {
      const [cmd, ...args] = policy.postMergeCommand;
      log(`[merge] 执行合并后同步: ${policy.postMergeCommand.join(" ")} (主 Worktree)`);
      const post = run(cmd, args, { cwd: mainRoot });
      postMerge = { exit: post.status, tail: (post.stdout + post.stderr).split("\n").slice(-20).join("\n") };
      if (post.status !== 0) {
        appendLedger(root, { event: "merge.post_failed", branch, exit: post.status });
        throw new MergeError(
          `合并已完成但合并后同步失败(exit ${post.status})，不得启动服务，也不得宣称合并完成:\n${postMerge.tail}`,
          "post_merge_failed",
        );
      }
    }

    return { dryRun: false, fastForward, newHead, resultTree, gateTouched, postMerge };
  } finally {
    release();
  }
}

export { writeRecord };
