import { userInfo } from "node:os";
import { gatePaths, loadTrustedProject, mainBranch } from "../lib/config.mjs";
import { matchAny } from "../lib/glob.mjs";
import { changedPaths, gitOk } from "../lib/git.mjs";
import { appendLedger, writeRecord } from "../lib/store.mjs";
import { planMergeResult } from "../merge/merge.mjs";

export const CONFIRM_KIND = "confirm";

/**
 * 门禁改动的确认摘要。只读，不写任何记录。
 * 用户在合并前看这一段，就知道这次会改掉哪些门禁文件、规则条数和检查项如何变化。
 */
export function confirmSummary({ cwd, branch }) {
  const project = loadTrustedProject(cwd);
  const root = project.root;
  const mainRef = mainBranch(project);
  const planned = planMergeResult({ project, root, branch });
  const paths = changedPaths(root, planned.mainCommit, planned.resultCommit);
  const gate = gatePaths(project);
  const gateTouched = paths.filter((path) => matchAny(path, gate));
  const codeTouched = gateTouched.filter((path) => path.startsWith(".harness/"));

  const ruleDiff = describeRuleDiff({ root, project, mainCommit: planned.mainCommit, resultCommit: planned.resultCommit });
  const checkDiff = describeCheckDiff({ root, project, mainCommit: planned.mainCommit, resultCommit: planned.resultCommit });

  return {
    branch,
    mainRef,
    resultTree: planned.resultTree,
    resultCommit: planned.resultCommit,
    fastForward: planned.fastForward,
    changedCount: paths.length,
    gateTouched,
    codeTouched,
    ruleDiff,
    checkDiff,
  };
}

function describeRuleDiff({ root, project, mainCommit, resultCommit }) {
  const path = ".harness/policy.json";
  const before = safeJson(root, mainCommit, path);
  const after = safeJson(root, resultCommit, path);
  if (!before || !after) return null;
  const ids = (value) => new Set((value.rules ?? []).map((rule) => rule.id));
  const beforeIds = ids(before);
  const afterIds = ids(after);
  return {
    before: beforeIds.size,
    after: afterIds.size,
    added: [...afterIds].filter((id) => !beforeIds.has(id)),
    removed: [...beforeIds].filter((id) => !afterIds.has(id)),
    presetsBefore: before.presets ?? [],
    presetsAfter: after.presets ?? [],
  };
}

function describeCheckDiff({ root, project, mainCommit, resultCommit }) {
  const path = ".harness/verify.json";
  const before = safeJson(root, mainCommit, path);
  const after = safeJson(root, resultCommit, path);
  if (!before || !after) return null;
  const ids = (value) => new Set((value.checks ?? []).map((check) => check.id));
  const beforeIds = ids(before);
  const afterIds = ids(after);
  return {
    before: beforeIds.size,
    after: afterIds.size,
    added: [...afterIds].filter((id) => !beforeIds.has(id)),
    removed: [...beforeIds].filter((id) => !afterIds.has(id)),
  };
}

function safeJson(root, commit, rel) {
  try {
    const out = gitOk(root, ["cat-file", "blob", `${commit}:${rel}`]);
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** 记录一次人工确认。记录绑定合并结果的 tree，内容一变确认即失效。 */
export function approveConfirm({ cwd, branch, note = "" }) {
  const project = loadTrustedProject(cwd);
  const root = project.root;
  const summary = confirmSummary({ cwd, branch });
  const { resultTree, ...rest } = summary;
  const record = writeRecord(root, CONFIRM_KIND, resultTree, {
    decision: "approve",
    by: userInfo().username,
    note,
    confirmedAt: new Date().toISOString(),
    summary: rest,
  });
  appendLedger(root, { event: "confirm.approve", branch, tree: resultTree, gateFiles: summary.gateTouched.length });
  return { record, summary };
}

export function formatSummary(summary) {
  const lines = [
    `分支: ${summary.branch} -> ${summary.mainRef}${summary.fastForward ? "(快进)" : "(三方合并)"}`,
    `合并结果 tree: ${summary.resultTree.slice(0, 12)}  改动文件: ${summary.changedCount}`,
    `门禁文件: ${summary.gateTouched.length} 个`,
    ...summary.gateTouched.slice(0, 20).map((path) => `  ${path}`),
  ];
  if (summary.ruleDiff) {
    const { before, after, added, removed, presetsBefore, presetsAfter } = summary.ruleDiff;
    lines.push(`拦截规则: ${before} -> ${after}`);
    if (added.length) lines.push(`  新增: ${added.join(", ")}`);
    if (removed.length) lines.push(`  移除: ${removed.join(", ")}`);
    if (presetsBefore.join() !== presetsAfter.join()) {
      lines.push(`  预设: ${presetsBefore.join(",") || "无"} -> ${presetsAfter.join(",") || "无"}`);
    }
  }
  if (summary.checkDiff) {
    const { before, after, added, removed } = summary.checkDiff;
    lines.push(`验证检查: ${before} -> ${after}`);
    if (added.length) lines.push(`  新增: ${added.join(", ")}`);
    if (removed.length) lines.push(`  移除: ${removed.join(", ")}`);
  }
  if (summary.gateTouched.length === 0) lines.push("本次没有改动门禁文件，无需确认。");
  return lines.join("\n");
}
