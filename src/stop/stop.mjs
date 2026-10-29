import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { acceptancePath, loadGateProject, loadGuardProject } from "../lib/config.mjs";
import { matchAny } from "../lib/glob.mjs";
import { changedPaths, git, showBlob, worktreeEntries } from "../lib/git.mjs";
import { appendLedger } from "../lib/store.mjs";
import { listEscalations } from "../escalate/escalate.mjs";
import { approvalState, planSettings } from "../plan/plan.mjs";
import { branchStatus } from "../status.mjs";
import { readSession, saveSession } from "./session.mjs";

// 收尾检查：Agent 要结束一轮回复时，核对本会话推进过的任务是否已经交付，没有交付又没有上报阻塞就让它接着做。
// 只拦 Agent 自己能接着做的步骤；等用户授权、等人工确认这类要人做的事不拦。

// Agent 能自己接着做的阻塞项，按交付流程的先后排列，第一项决定提示的下一步。
const AGENT_STEPS = ["evidence_failed", "evidence_missing", "review_rejected", "review_stale", "review_missing", "acceptance_missing"];

function nextStep(code, { branch, mainRef }) {
  switch (code) {
    case "evidence_failed":
      return `修好失败的检查并提交，再运行 harness verify --branch ${branch}`;
    case "evidence_missing":
      return `harness verify --branch ${branch}`;
    case "review_rejected":
      return `按评审发现修复并提交，再重新 harness verify、harness review --branch ${branch}`;
    case "review_stale":
      return `在任务分支上 git merge ${mainRef} 并提交，再重新 harness verify、harness review --branch ${branch}`;
    case "review_missing":
      return `harness review --branch ${branch}`;
    case "acceptance_missing":
      return "补写验收清单并提交到任务分支";
    default:
      return `harness status --branch ${branch}`;
  }
}

/** 上报之后分支没有新提交时，认为 Agent 已经把决定交给了人；之后接着干又提交了，旧的上报就不再算数。 */
function escalatedAfterHead(root, branch, escalations) {
  const committed = git(root, ["log", "-1", "--format=%cI", branch]).stdout.trim();
  if (!committed) return false;
  return escalations.some((item) => item.context?.branch === branch && Date.parse(item.openedAt) >= Date.parse(committed));
}

/** 任务 Worktree 里没有提交的改动（含未跟踪文件），按仓库相对路径列出。 */
function dirtyPaths(path) {
  if (!path) return [];
  const entries = git(path, ["status", "--porcelain", "-z", "--untracked-files=all"]).stdout.split("\0");
  const paths = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // 改名与复制在下一项给出原路径，跳过。
    if (/^[RC]/.test(entry)) i += 1;
  }
  return paths;
}

/**
 * 只写了方案、还没有实施授权：先方案后实施的任务交出方案后停下等用户同意，正是规则要求的。
 * 改动全部落在验收清单与实施方案所在的目录里才算，已经动了代码的不算。
 */
function awaitingApproval({ root, branch, status, worktree, dirty }) {
  let project;
  try {
    project = loadGateProject(root, { branch });
  } catch {
    return false;
  }
  const committed = status.merged ? [] : changedPaths(root, git(root, ["merge-base", status.mainCommit, status.branchCommit]).stdout.trim(), status.branchCommit);
  const paths = [...new Set([...committed, ...dirty])];
  if (paths.length === 0) return false;
  const acceptance = acceptancePath(project, branch);
  const planDirs = paths.filter((path) => matchAny(path, planSettings(project.config).markers)).map((path) => `${dirname(path)}/`);
  if (!paths.every((path) => path === acceptance || planDirs.some((dir) => path.startsWith(dir)))) return false;
  const file = worktree ? join(worktree, acceptance) : null;
  const text = file && existsSync(file) ? readFileSync(file, "utf8") : showBlob(root, status.branchCommit, acceptance);
  return !approvalState({ root, branch, acceptanceText: text }).approved;
}

/** 判断一个分支还欠什么。返回 null 表示不需要 Agent 接着做：已交付、要等人，或者已经上报。 */
function owedBy({ root, branch, escalations, worktrees }) {
  let status;
  try {
    status = branchStatus({ cwd: root, branch });
  } catch {
    // 判断不了的分支不拦，不能因为门禁自己出错把会话困住。
    return null;
  }
  if (status.codes.includes("branch_missing")) return null;
  const worktree = worktrees.get(branch) ?? null;
  const dirty = dirtyPaths(worktree);
  // 方案交出后停下等用户同意实施，正是规则要求的；已经动了代码却没有授权，同样要等用户。
  if (status.codes.includes("plan_unapproved") || awaitingApproval({ root, branch, status, worktree, dirty })) return null;
  if (escalatedAfterHead(root, branch, escalations)) return null;
  const owed = (missing, next) => ({ branch, status, dirty, missing, next });
  // 分支已经在主分支里，但 Worktree 里还有没提交的改动：典型情况是新分支上改了文件就结束了。
  if (status.merged) {
    if (dirty.length === 0) return null;
    const sample = dirty.slice(0, 3).join("、") + (dirty.length > 3 ? " 等" : "");
    return owed(`任务 Worktree 里有 ${dirty.length} 个文件没有提交（${sample}）`, "属于本任务的提交后 harness verify、harness review 并交付，不属于的清理掉或在回复里说明");
  }
  const pending = AGENT_STEPS.filter((code) => status.codes.includes(code));
  if (pending.length > 0) return owed(`还差 ${status.blockers.join("、")}`, nextStep(pending[0], status));
  // 剩下的都要人来做（门禁改动确认、主 Worktree 不洁净），交给 Agent 的汇报说明。
  if (status.blockers.length > 0) return null;
  if (status.delivery.mode === "remote") {
    if (status.submitted?.current && status.submitted.stage === "ready") return null;
    return owed("门禁已经齐备，还没有提交 PR/MR", `harness submit --branch ${branch}`);
  }
  return owed("门禁已经齐备，还没有合并", `harness merge --branch ${branch}`);
}

/** 进展指纹：分支顶端、阻塞项与任务 Worktree 里未提交文件的内容。两次结束之间指纹没变，说明没有进展。 */
function fingerprint(owed, worktrees) {
  const parts = owed.map(({ branch, status, dirty }) => {
    const path = worktrees.get(branch);
    const hash = createHash("sha256");
    // 只改了文件还没提交时，内容变化同样算进展；未跟踪的文件 git diff 看不到，直接读内容。
    for (const rel of [...dirty].sort()) {
      const file = join(path, rel);
      hash.update(`${rel}\0`);
      try {
        if (statSync(file).isFile()) hash.update(readFileSync(file));
      } catch {
        hash.update("(deleted)");
      }
    }
    return [branch, status.branchCommit, status.codes.join(","), hash.digest("hex")].join(":");
  });
  return createHash("sha256").update(parts.sort().join("\n")).digest("hex");
}

export function formatStopReason(owed) {
  const lines = ["[harness] 收尾检查：本会话推进过的任务还没有交付完成，接着做，不要结束这一轮。"];
  for (const { branch, missing, next } of owed) lines.push(`- ${branch}：${missing}；下一步 ${next}`);
  lines.push(
    "harness 命令经项目入口 .harness/bin/harness 运行。",
    "按 .harness/rules/harness.md 的“一次任务”连续推进到合并（远程交付到 submit）；轮次长短、耗时与上下文大小都不是停下的理由。",
    "缺权限、需要用户拍板、没有合并授权，或必要验证被外部问题阻塞时，先运行 harness escalate open 写明阻塞与选项（context.branch 填任务分支），再结束这一轮并向用户说明。",
    "用户在本轮明确要求暂停时，在回复里照录用户原话说明为什么停下。",
  );
  return lines.join("\n");
}

/**
 * 客户端的 Stop 事件调用。返回 { decision: "allow" | "block", reason }。
 * 同一会话两次结束之间没有任何进展时放行，并在账本记 stop.unresolved，避免把会话困在循环里，
 * 由 harness status 把这次未上报的结束展示给人。
 */
export function stopCheck({ cwd, client, session }) {
  const project = loadGuardProject(cwd);
  if (!project || !session) return { decision: "allow" };
  const root = project.root;
  const state = readSession(root, { client, session });
  if (!state) return { decision: "allow" };

  const escalations = listEscalations(root, "open");
  const worktrees = new Map(worktreeEntries(root).map((entry) => [entry.branch, entry.path]));
  const owed = Object.keys(state.branches)
    .map((branch) => owedBy({ root, branch, escalations, worktrees }))
    .filter(Boolean);
  if (owed.length === 0) {
    if (state.lastBlock) {
      delete state.lastBlock;
      saveSession(root, state);
    }
    return { decision: "allow", owed };
  }

  const print = fingerprint(owed, worktrees);
  if (state.lastBlock?.fingerprint === print) {
    if (!state.lastBlock.unresolved) {
      for (const { branch, status, missing } of owed) {
        appendLedger(root, { event: "stop.unresolved", branch, head: status.branchCommit, missing, client });
      }
      state.lastBlock.unresolved = true;
      saveSession(root, state);
    }
    return { decision: "allow", owed, unresolved: true };
  }

  state.lastBlock = { fingerprint: print, at: new Date().toISOString() };
  saveSession(root, state);
  appendLedger(root, { event: "stop.block", branches: owed.map((item) => item.branch), client });
  return { decision: "block", reason: formatStopReason(owed), owed };
}
