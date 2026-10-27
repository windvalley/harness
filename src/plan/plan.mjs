import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { acceptancePath, loadGateProject, mainBranch, trustedMainRef } from "../lib/config.mjs";
import { matchAny } from "../lib/glob.mjs";
import { changedPaths, git, mergeBase, refExists, resolveCommit, showBlob } from "../lib/git.mjs";
import { appendLedger, readRecord, writeRecord } from "../lib/store.mjs";

export const PLAN_KIND = "plan";
export const PLAN_PRESET = "plan-first";

// 任务分级的机械部分：写了实施方案、改了库表、代码改动超过阈值，都属于要先批准方案的任务。
const DEFAULTS = {
  maxLines: 500,
  markers: ["docs/changes/*/plan.md"],
  triggers: ["**/migrations/**", "**/*.sql"],
  exclude: [
    "**/*_test.go",
    "**/*.test.*",
    "**/*.spec.*",
    "**/test/**",
    "**/tests/**",
    "**/__tests__/**",
    "**/testdata/**",
    "docs/**",
    "**/*.md",
    "**/*.lock",
    "**/package-lock.json",
    "**/pnpm-lock.yaml",
    "**/go.sum",
    ".harness/**",
  ],
};

export function planSettings(config) {
  return { ...DEFAULTS, ...(config?.intent?.plan ?? {}) };
}

export function planEnforced(policy) {
  return (policy?.presets ?? []).includes(PLAN_PRESET);
}

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

function recordKey(branch) {
  return branch.replace(/[^0-9A-Za-z._-]+/g, "-");
}

/** 方案是否已经批准：批准记录绑定验收清单的内容，批准之后清单再改就要重新批准。 */
export function approvalState({ root, branch, acceptanceText }) {
  const found = readRecord(root, PLAN_KIND, recordKey(branch));
  if (!found.ok) return { approved: false, reason: found.code === "missing" ? "方案还没有经人批准" : found.reason };
  if (found.record.branch !== branch) return { approved: false, reason: `批准记录属于分支 ${found.record.branch}` };
  if (acceptanceText === null || acceptanceText === undefined) return { approved: false, reason: "缺少验收清单" };
  if (found.record.acceptanceHash !== sha(acceptanceText)) return { approved: false, reason: "批准之后验收清单又改过，需要重新批准" };
  return { approved: true, record: found.record };
}

/** 统计代码改动行数（新增加删除），测试、文档、锁文件与门禁文件不计。 */
export function codeLines(root, base, head, exclude) {
  const out = git(root, ["diff", "--numstat", "--no-renames", "-z", base, head]).stdout;
  let total = 0;
  for (const entry of out.split("\0").filter(Boolean)) {
    const [added, removed, path] = entry.split("\t");
    if (!path || matchAny(path, exclude)) continue;
    total += (Number(added) || 0) + (Number(removed) || 0);
  }
  return total;
}

/** 合并时判断这次改动是否需要已批准的方案，返回原因列表，空列表表示属于直接实施的范围。 */
export function planRequirement({ root, project, base, head }) {
  const settings = planSettings(project.config);
  const paths = changedPaths(root, base, head);
  const reasons = [];
  const markers = paths.filter((path) => matchAny(path, settings.markers));
  if (markers.length > 0) reasons.push(`分支写了实施方案 ${markers[0]}`);
  const triggers = paths.filter((path) => matchAny(path, settings.triggers) && !matchAny(path, settings.exclude));
  if (triggers.length > 0) reasons.push(`改了库表相关文件 ${triggers.slice(0, 3).join(", ")}`);
  const lines = codeLines(root, base, head, settings.exclude);
  if (lines > settings.maxLines) reasons.push(`代码改动 ${lines} 行，超过 ${settings.maxLines} 行`);
  return { reasons, lines, markers, settings };
}

/**
 * 实时拦截用：任务 Worktree 里写了实施方案、方案还没批准时返回 true。
 * 方案按工作区判断（含未提交与未跟踪的文件），Agent 刚写完方案、还没提交时同样生效。
 */
export function worktreePlanPending({ root, branch, project }) {
  if (!branch || ["main", "master"].includes(branch)) return false;
  let mainRef;
  try {
    mainRef = trustedMainRef(root);
  } catch {
    return false;
  }
  const base = git(root, ["merge-base", mainRef, "HEAD"]);
  if (base.status !== 0) return false;
  const tracked = git(root, ["diff", "--name-only", "--no-renames", "-z", base.stdout.trim()]).stdout.split("\0");
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout.split("\0");
  const settings = planSettings(project.config);
  if (![...tracked, ...untracked].some((path) => path && matchAny(path, settings.markers))) return false;
  const file = join(root, acceptancePath(project, branch));
  const text = existsSync(file) ? readFileSync(file, "utf8") : null;
  return !approvalState({ root, branch, acceptanceText: text }).approved;
}

/** 批准前给人看的摘要，只读。 */
export function planSummary({ cwd, branch }) {
  if (!branch) throw new Error("用法: harness approve --branch <任务分支>");
  const project = loadGateProject(cwd, { branch });
  const root = project.root;
  const mainRef = mainBranch(project);
  if (branch === mainRef) throw new Error("主分支不需要批准方案");
  if (!refExists(root, branch)) throw new Error(`分支不存在: ${branch}`);
  const branchCommit = resolveCommit(root, branch);
  const base = mergeBase(root, resolveCommit(root, mainRef), branchCommit);
  const rel = acceptancePath(project, branch);
  const acceptance = showBlob(root, branchCommit, rel);
  const need = planRequirement({ root, project, base, head: branchCommit });
  const dirs = need.markers.map((path) => path.slice(0, path.lastIndexOf("/") + 1));
  const paths = changedPaths(root, base, branchCommit);
  const planFiles = paths.filter((path) => path === rel || dirs.some((dir) => path.startsWith(dir)));
  const otherFiles = paths.filter((path) => !planFiles.includes(path));
  return {
    root,
    branch,
    branchCommit,
    acceptancePath: rel,
    acceptance,
    planFiles,
    otherFiles,
    reasons: need.reasons,
    lines: need.lines,
    enforced: planEnforced(project.policy),
    approval: approvalState({ root, branch, acceptanceText: acceptance }),
  };
}

export function approvePlan({ cwd, branch, note = "" }) {
  const summary = planSummary({ cwd, branch });
  if (summary.acceptance === null) {
    throw new Error(`分支 ${branch} 上还没有提交验收清单 ${summary.acceptancePath}，先把方案提交到任务分支再批准`);
  }
  const record = writeRecord(summary.root, PLAN_KIND, recordKey(branch), {
    branch,
    branchCommit: summary.branchCommit,
    acceptanceHash: sha(summary.acceptance),
    planFiles: summary.planFiles,
    by: userInfo().username,
    note,
    approvedAt: new Date().toISOString(),
  });
  appendLedger(summary.root, { event: "plan.approve", branch, commit: summary.branchCommit });
  return { record, summary };
}

export function formatPlanSummary(summary) {
  const lines = [`分支: ${summary.branch} (${summary.branchCommit.slice(0, 10)})`];
  if (!summary.enforced) lines.push("注意: 主分支的 policy.json 没有启用 plan-first 预设，批准记录不会被实时拦截与合并检查使用");
  lines.push(summary.reasons.length ? `需要批准方案: ${summary.reasons.join("；")}` : `按当前改动属于直接实施的范围（代码改动 ${summary.lines} 行）`);
  lines.push(summary.approval.approved ? `已批准（${summary.approval.record.by}，${summary.approval.record.approvedAt}）` : `批准状态: ${summary.approval.reason}`);
  lines.push("方案文件:");
  for (const path of summary.planFiles) lines.push(`  ${path}`);
  if (summary.planFiles.length === 0) lines.push("  (无)");
  if (summary.otherFiles.length > 0) {
    lines.push(`批准前分支上已有 ${summary.otherFiles.length} 个方案以外的改动:`);
    for (const path of summary.otherFiles.slice(0, 20)) lines.push(`  ${path}`);
  }
  lines.push(`验收清单 ${summary.acceptancePath}:`);
  lines.push(summary.acceptance === null ? "  (分支上还没有提交，无法批准)" : summary.acceptance.trimEnd());
  return lines.join("\n");
}
