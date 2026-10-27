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

// 任务分级的机械部分：写了实施方案、改了库表、代码改动超过阈值，都属于要先取得实施授权的任务。
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

/**
 * 方案是否已有实施授权：用户在对话里表达开始实施的意思后，由 Agent 照录原话记录。
 * 记录绑定验收清单的内容，之后清单再改就要重新取得授权。
 */
export function approvalState({ root, branch, acceptanceText }) {
  const found = readRecord(root, PLAN_KIND, recordKey(branch));
  if (!found.ok) return { approved: false, reason: found.code === "missing" ? "还没有记录用户的实施授权" : found.reason };
  if (found.record.branch !== branch) return { approved: false, reason: `授权记录属于分支 ${found.record.branch}` };
  if (acceptanceText === null || acceptanceText === undefined) return { approved: false, reason: "缺少验收清单" };
  if (found.record.acceptanceHash !== sha(acceptanceText)) return { approved: false, reason: "授权之后验收清单又改过，需要向用户说明改动并重新取得同意" };
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

/** 合并时判断这次改动是否需要实施授权，返回原因列表，空列表表示属于直接实施的范围。 */
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
 * 实时拦截用：任务 Worktree 里写了实施方案、还没有授权记录时返回 true。
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

/** 记录授权前的方案摘要，只读。 */
export function planSummary({ cwd, branch }) {
  if (!branch) throw new Error("用法: harness approve --branch <任务分支>");
  const project = loadGateProject(cwd, { branch });
  const root = project.root;
  const mainRef = mainBranch(project);
  if (branch === mainRef) throw new Error("主分支不需要实施授权");
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

/**
 * 记录实施授权。授权来自用户在对话里的表态，命令只负责落档：note 必须照录用户原话，
 * 合并、status 与评审都会显示它，事后可以核对 Agent 是否真的得到了同意。
 */
export function approvePlan({ cwd, branch, note = "" }) {
  const quote = String(note).trim();
  if (!quote) {
    throw new Error("记录实施授权要用 --note 照录用户表示同意实施的原话，例如 --note \"可以，开始实施\"；用户还没有同意时停下等待");
  }
  const summary = planSummary({ cwd, branch });
  if (summary.acceptance === null) {
    throw new Error(`分支 ${branch} 上还没有提交验收清单 ${summary.acceptancePath}，先把方案提交到任务分支再记录授权`);
  }
  const record = writeRecord(summary.root, PLAN_KIND, recordKey(branch), {
    branch,
    branchCommit: summary.branchCommit,
    acceptanceHash: sha(summary.acceptance),
    planFiles: summary.planFiles,
    by: userInfo().username,
    note: quote,
    approvedAt: new Date().toISOString(),
  });
  appendLedger(summary.root, { event: "plan.approve", branch, commit: summary.branchCommit });
  return { record, summary };
}

export function formatPlanSummary(summary) {
  const lines = [`分支: ${summary.branch} (${summary.branchCommit.slice(0, 10)})`];
  if (!summary.enforced) lines.push("注意: 主分支的 policy.json 没有启用 plan-first 预设，授权记录不会被实时拦截与合并检查使用");
  lines.push(summary.reasons.length ? `需要实施授权: ${summary.reasons.join("；")}` : `按当前改动属于直接实施的范围（代码改动 ${summary.lines} 行）`);
  lines.push(summary.approval.approved ? `已记录实施授权（依据：${summary.approval.record.note}，${summary.approval.record.approvedAt}）` : `授权状态: ${summary.approval.reason}`);
  lines.push("方案文件:");
  for (const path of summary.planFiles) lines.push(`  ${path}`);
  if (summary.planFiles.length === 0) lines.push("  (无)");
  if (summary.otherFiles.length > 0) {
    lines.push(`授权前分支上已有 ${summary.otherFiles.length} 个方案以外的改动:`);
    for (const path of summary.otherFiles.slice(0, 20)) lines.push(`  ${path}`);
  }
  lines.push(`验收清单 ${summary.acceptancePath}:`);
  lines.push(summary.acceptance === null ? "  (分支上还没有提交，无法记录授权)" : summary.acceptance.trimEnd());
  return lines.join("\n");
}
