import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { acceptancePath, loadGateProject, loadGuardProject } from "../lib/config.mjs";
import { matchAny } from "../lib/glob.mjs";
import { changedPaths, git, gitOk, showBlob, worktreeEntries } from "../lib/git.mjs";
import { appendLedger } from "../lib/store.mjs";
import { listEscalations } from "../escalate/escalate.mjs";
import { approvalRecord, approvalState, planSettings } from "../plan/plan.mjs";
import { formatProgress, nextStageStep, stageProgress } from "../plan/stages.mjs";
import { branchStatus } from "../status.mjs";
import { bindingProblem, escalationBinding } from "../escalate/binding.mjs";
import { readSession, saveSession } from "./session.mjs";

// 收尾检查：Agent 要结束一轮回复时，核对本会话推进过的任务是否已经交付，没有交付又没有上报阻塞就让它接着做。
// 只拦 Agent 自己能接着做的步骤；等用户授权、等人工确认这类要人做的事不拦。

// Agent 能自己接着做的阻塞项，按交付流程的先后排列，第一项决定提示的下一步。
// 提交信息规则与提交信息排在最前：规则决定提交信息合不合规，改写提交会让后面的证据与评审全部作废，要先改完再往下走。
const AGENT_STEPS = [
  "branch_commit_rule_invalid",
  "bad_commit_message",
  "bad_branch_name",
  "evidence_failed",
  "evidence_missing",
  "review_rejected",
  "review_stale",
  "review_missing",
  "acceptance_missing",
];

// 门禁只差验证或评审时，分支可能还在实施中，验收清单没做完就不该先验证。
const IMPLEMENTING_STEPS = new Set(["evidence_missing", "review_missing"]);

// 同一进展指纹最多拦截的次数，超过后放行并通知用户，避免把会话困在循环里。
const IDLE_BLOCKS_DEFAULT = 3;

/** 读取 stop.idleBlocks：正整数有效；没配置用缺省值；配置了但不是正整数（包括 stop 不是对象）时按缺省值处理并标记回退。 */
export function idleBlocksSetting(config) {
  const stop = config?.stop;
  if (stop === undefined) return { limit: IDLE_BLOCKS_DEFAULT, fallback: false };
  if (stop === null || typeof stop !== "object" || Array.isArray(stop)) return { limit: IDLE_BLOCKS_DEFAULT, fallback: true };
  if (!("idleBlocks" in stop)) return { limit: IDLE_BLOCKS_DEFAULT, fallback: false };
  const value = stop.idleBlocks;
  if (Number.isInteger(value) && value >= 1) return { limit: value, fallback: false };
  return { limit: IDLE_BLOCKS_DEFAULT, fallback: true };
}

function nextStep(code, { branch, mainRef, evidenceNextStep }) {
  switch (code) {
    case "branch_commit_rule_invalid":
      return `修正 .harness/policy.json 的 commit-message 规则（与 config.json 的旧字段只留一处）并提交，再重新 harness verify、harness review --branch ${branch}`;
    case "bad_commit_message":
      return `在任务分支改写不符合规范的提交信息（git commit --amend 或变基），再重新 harness verify、harness review --branch ${branch}`;
    case "bad_branch_name":
      return "按 .harness/policy.json 的 branch-name 规则修正任务分支名称并核对验收清单路径，再运行 harness status --branch <修正后的分支名>；已有证据与评审仍有效时可复用";
    case "evidence_failed":
      return evidenceNextStep || `修好失败的检查后运行 harness verify --branch ${branch}`;
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

/** 只认当前 SHA 与待验收义务快照，旧的无 head 上报保守视为过期。 */
function escalatedAtBinding(branch, binding, escalations) {
  if (!binding.head) return false;
  const keys = binding.obligations;
  return escalations.some((item) =>
    item.context?.bindingStatus !== "unbound" && item.context?.branch === branch && item.context.head === binding.head &&
    JSON.stringify(item.context.obligations ?? []) === JSON.stringify(keys),
  );
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

/** 分支已被删除（例如合并后清理了 Worktree）时，只要还有到期而未登记的合并后验收义务，就仍然要接着做。 */
function missingBranchOwed({ root, branch, status, escalations }) {
  const mainCommit = gitOk(root, ["rev-parse", "--verify", `${status.mainRef}^{commit}`]);
  const binding = escalationBinding(root, branch, mainCommit);
  const open = binding.pending;
  if (open.length === 0 || escalatedAtBinding(branch, binding, escalations)) return null;
  const item = open[0];
  return {
    branch,
    status,
    dirty: [],
    missing: `合并后验收待完成：${[...new Set(open.map((entry) => entry.checkId))].join("、")}`,
    next: `${item.howToVerify}；成功后运行 harness attest --branch ${branch} --check ${item.checkId} --command "<实际命令>" --report <报告>`,
  };
}

/** 判断一个分支还欠什么。返回 null 表示不需要 Agent 接着做：已交付、要等人，或者已经上报；要人处理的事返回 { human }。 */
function owedBy({ project, root, branch, escalations, worktrees, sessionBranches }) {
  const status = branchStatus({ cwd: root, branch });
  if (status.codes.includes("branch_missing")) return missingBranchOwed({ root, branch, status, escalations });
  const worktree = worktrees.get(branch) ?? null;
  const dirty = dirtyPaths(worktree);
  // 方案交出后停下等用户同意实施，正是规则要求的；已经动了代码却没有授权，同样要等用户。
  if (status.codes.includes("plan_unapproved") || awaitingApproval({ root, branch, status, worktree, dirty })) return null;
  const candidates = escalations.filter((item) => item.context?.branch === branch && item.context?.bindingStatus !== "unbound" && typeof item.context?.head === "string");
  if (candidates.length > 0) {
    const binding = escalationBinding(root, branch, status.mainCommit);
    if (binding.head === status.branchCommit && escalatedAtBinding(branch, binding, candidates)) return null;
  }
  const owed = (missing, next) => ({ branch, status, dirty, missing, next });
  // 分支已经在主分支里，但 Worktree 里还有没提交的改动：典型情况是新分支上改了文件就结束了。
  if (status.merged) {
    if (status.postMerge?.pending.length > 0) {
      const item = status.postMerge.pending[0];
      return owed(`合并后验收待完成：${status.postMerge.pending.map((entry) => entry.id).join("、")}`, `${item.howToVerify}；成功后运行 harness attest --branch ${branch} --check ${item.id} --command "<实际命令>" --report <报告>`);
    }
    if (dirty.length > 0) {
      const sample = dirty.slice(0, 3).join("、") + (dirty.length > 3 ? " 等" : "");
      return owed(`任务 Worktree 里有 ${dirty.length} 个文件没有提交（${sample}）`, "属于本任务的提交后 harness verify、harness review 并交付，不属于的清理掉或在回复里说明");
    }
    return stageOwed({ project, root, branch, status, sessionBranches, owed });
  }
  const pending = AGENT_STEPS.filter((code) => status.codes.includes(code));
  if (pending.length > 0) {
    const result = owed(`还差 ${status.blockers.join("、")}`, nextStep(pending[0], status));
    // 缺验证或缺评审时，Agent 可能还在实施；提示照给门禁的下一步，同时说明验收没做完时先继续实现。
    if (IMPLEMENTING_STEPS.has(pending[0])) result.implementing = true;
    return result;
  }
  // 剩下的都要人来做（门禁改动确认、主 Worktree 不洁净），交给 Agent 的汇报说明。
  if (status.blockers.length > 0) return null;
  if (status.delivery.mode === "remote") {
    if (status.submitted?.current && status.submitted.stage === "ready") return null;
    return owed("门禁已经齐备，还没有提交 PR/MR", `harness submit --branch ${branch}`);
  }
  const hint = status.pushTarget ? `（合并后会推送到 ${status.pushTarget.remote}/${status.pushTarget.mainRef}，属于已确认的交付授权，不需要另行请示）` : "";
  return owed("门禁已经齐备，还没有合并", `harness merge --branch ${branch}${hint}`);
}

/**
 * 已合入的阶段分支：所属方案还有没开始或没交付的后续阶段时，Agent 要接着做；
 * 方案级授权失效时不生成欠项，交给用户重新授权。下一阶段的分支本会话正在做时，由那条分支自己的核对负责。
 */
function stageOwed({ project, root, branch, status, sessionBranches, owed }) {
  const link = approvalRecord(root, branch)?.stages;
  if (!link) return null;
  const progress = stageProgress({ root, link, mainCommit: status.mainCommit });
  if (progress.invalid) return { branch, human: `${branch}：${formatProgress(progress)}` };
  const next = progress.next;
  if (!next) return null;
  if (next.open.length > 0) {
    if (next.open.some((name) => sessionBranches.has(name))) return null;
    return owed(`方案 ${progress.file} 的下一阶段 ${next.id} 在分支 ${next.open[0]} 上还没有交付`, `接着完成分支 ${next.open[0]}：harness status --branch ${next.open[0]}`);
  }
  return owed(`方案 ${progress.file} 还有后续阶段 ${next.id}（${next.title}）没有开始`, nextStageStep({ project, progress, mainRef: status.mainRef }));
}

/** 进展指纹：分支顶端、阻塞项、欠项与任务 Worktree 里未提交文件的内容。两次结束之间指纹没变，说明没有进展。 */
function fingerprint(owed, worktrees) {
  const parts = owed.map(({ branch, status, dirty, missing }) => {
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
    const postMerge = (status.postMerge?.completed ?? []).join(",");
    return [branch, status.branchCommit, status.codes.join(","), postMerge, missing, hash.digest("hex")].join(":");
  });
  return createHash("sha256").update(parts.sort().join("\n")).digest("hex");
}

export function formatStopReason(owed, human = []) {
  const lines = ["[harness] 收尾检查：本会话推进过的任务还没有交付完成，接着做，不要结束这一轮。"];
  for (const { branch, missing, next } of owed) lines.push(`- ${branch}：${missing}；下一步 ${next}`);
  if (human.length > 0) lines.push(`另外需要用户处理：${human.join("；")}；在回复里向用户说明。`);
  if (owed.some((item) => item.implementing)) {
    lines.push("验收清单还有未实现的条目时，先继续实现并提交，实现完成后再运行 harness verify；暂时不该验证不是结束这一轮的理由。");
  }
  lines.push(
    "harness 命令经项目入口 .harness/bin/harness 运行。",
    "按 .harness/rules/harness.md 的“一次任务”连续推进到合并（远程交付到 submit）；轮次长短、耗时与上下文大小都不是停下的理由。",
    "每一轮以工具调用推进；回应客户端的进度提醒后继续调用工具，不要只用文字汇报就结束。",
    "需要人决定时，参考 .harness/rules/core.md 的基础停止条件与 .harness/config.json 的 escalate.triggers，先运行 harness escalate open 写明阻塞与选项（context.branch 填任务分支），再结束这一轮并向用户说明。",
    "用户在本轮明确要求暂停时，在回复里照录用户原话说明为什么停下。",
  );
  return lines.join("\n");
}

/** 放行时给用户看的通知：会话停在哪、还欠什么、拦了几次、怎么恢复。 */
export function formatReleaseNotice(owed, blocks, idle) {
  const items = owed.map(({ branch, missing }) => `${branch} ${missing}`).join("；");
  const fallback = idle.fallback ? `（stop.idleBlocks 配置无效，已按 ${idle.limit} 处理）` : "";
  return `会话没有交付就结束了：${items}。收尾检查已连续拦截 ${blocks} 次仍没有进展，本次放行${fallback}。发送“继续”即可让 Agent 接着做。`;
}

/**
 * 客户端的 Stop 事件调用。返回 { decision: "allow" | "block", reason }。
 * 同一会话的进展指纹不变时，最多拦截 stop.idleBlocks 次（缺省 3），之后放行并在账本记 stop.unresolved，避免把会话困在循环里；
 * 第一次放行时返回 notice，由钩子入口展示给用户，harness status 也会显示这次未上报的结束。
 */
export function stopCheck({ cwd, client, session }) {
  const project = loadGuardProject(cwd);
  if (!project || !session) return { decision: "allow" };
  const root = project.root;
  const state = readSession(root, { client, session });
  if (!state) return { decision: "allow" };

  const escalations = listEscalations(root, "open");
  const worktrees = new Map(worktreeEntries(root).map((entry) => [entry.branch, entry.path]));
  const sessionBranches = new Set(Object.keys(state.branches));
  const results = [...sessionBranches]
    .map((branch) => {
      try {
        return owedBy({ project, root, branch, escalations, worktrees, sessionBranches });
      } catch (error) {
        // 判断不了的分支不困住会话，同时保留诊断并继续核对其他任务。
        appendLedger(root, { event: "stop.error", branch, error: bindingProblem(root, error), client });
        return null;
      }
    })
    .filter(Boolean);
  const owed = results.filter((item) => !item.human);
  const human = results.filter((item) => item.human).map((item) => item.human);
  if (owed.length === 0) {
    // 只差人来处理时放行；同一条提示只给一次，不在每次结束时重复。
    const text = human.join("；");
    const notice = human.length > 0 && state.lastNotice !== text ? `${text}。` : undefined;
    if (state.lastBlock || notice) {
      delete state.lastBlock;
      if (notice) state.lastNotice = text;
      saveSession(root, state);
    }
    return { decision: "allow", owed, notice };
  }

  const print = fingerprint(owed, worktrees);
  if (state.lastBlock?.fingerprint === print) {
    if (state.lastBlock.unresolved) return { decision: "allow", owed, unresolved: true };
    // 旧版会话记录没有 blocks，或记录被改坏时，当作已经拦过一次。
    const recorded = state.lastBlock.blocks;
    const blocks = Number.isInteger(recorded) && recorded >= 1 ? recorded : 1;
    const idle = idleBlocksSetting(project.config);
    if (blocks < idle.limit) {
      state.lastBlock.blocks = blocks + 1;
      saveSession(root, state);
      appendLedger(root, { event: "stop.block", branches: owed.map((item) => item.branch), client });
      return { decision: "block", reason: formatStopReason(owed, human), owed };
    }
    for (const { branch, status, missing } of owed) {
      appendLedger(root, { event: "stop.unresolved", branch, head: status.branchCommit, missing, blocks, client });
    }
    state.lastBlock.unresolved = true;
    saveSession(root, state);
    return { decision: "allow", owed, unresolved: true, notice: formatReleaseNotice(owed, blocks, idle) };
  }

  state.lastBlock = { fingerprint: print, at: new Date().toISOString(), blocks: 1 };
  saveSession(root, state);
  appendLedger(root, { event: "stop.block", branches: owed.map((item) => item.branch), client });
  return { decision: "block", reason: formatStopReason(owed, human), owed };
}
