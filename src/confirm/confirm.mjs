import { userInfo } from "node:os";
import { deliveryAt, deliveryChange, deliveryGrant, deliverySettings, describeDelivery, gatePaths, loadGateProject, mainBranch } from "../lib/config.mjs";
import { matchAny } from "../lib/glob.mjs";
import { changedPaths, gitOk } from "../lib/git.mjs";
import { appendLedger, writeRecord } from "../lib/store.mjs";
import { resolvePolicy } from "../policy/resolve.mjs";
import { planMergeResult } from "../merge/merge.mjs";

export const CONFIRM_KIND = "confirm";

/**
 * 门禁改动的确认摘要。只读，不写任何记录。
 * 用户在合并前看这一段，就知道这次会改掉哪些门禁文件、规则条数和检查项如何变化。
 */
export function confirmSummary({ cwd, branch }) {
  const project = loadGateProject(cwd, { branch });
  const root = project.root;
  const mainRef = mainBranch(project);
  const planned = planMergeResult({ project, root, branch });
  const paths = changedPaths(root, planned.mainCommit, planned.resultCommit);
  const gate = gatePaths(project);
  const gateTouched = paths.filter((path) => matchAny(path, gate));
  const codeTouched = gateTouched.filter((path) => path.startsWith(".harness/"));

  const delivery = describeDeliveryChange({ project, root, planned });
  const ruleDiff = describeRuleDiff({ root, mainCommit: planned.mainCommit, resultCommit: planned.resultCommit });
  const checkDiff = describeCheckDiff({ root, project, mainCommit: planned.mainCommit, resultCommit: planned.resultCommit });

  return {
    branch,
    mainRef,
    bootstrap: Boolean(project.bootstrap),
    proposal: project.bootstrap ? describeProposal(project) : null,
    resultTree: planned.resultTree,
    resultCommit: planned.resultCommit,
    fastForward: planned.fastForward,
    changedCount: paths.length,
    gateTouched,
    delivery,
    codeTouched,
    ruleDiff,
    checkDiff,
  };
}

/**
 * 交付设置的变化单独列出来：它决定 Agent 能对远程做什么，改它就是改授权范围，
 * 不受 confirmOnGateChange 影响，摘要里必须写清改前改后与由此授予的权限。
 * 首次接入没有“改前”，只有提议值。
 */
function describeDeliveryChange({ project, root, planned }) {
  if (project.bootstrap) {
    let after;
    try {
      after = deliveryAt(root, planned.resultCommit) ?? deliverySettings(undefined);
    } catch {
      return null;
    }
    return { before: null, after, changed: false, grant: deliveryGrant(after) };
  }
  const before = deliverySettings(project.config);
  let after;
  try {
    after = deliveryAt(root, planned.resultCommit) ?? deliverySettings(undefined);
  } catch (error) {
    return { before, after: null, changed: false, grant: null, error: error.message };
  }
  const change = deliveryChange(before, after);
  return { before, after, changed: change.changed, grant: deliveryGrant(after) };
}

/**
 * 规则差异按“生效规则”比较，而不是只看项目自有的 rules 数组。
 * 只统计自有 rules 会漏掉 disabled 关掉某条预设规则的情况，而那正是最需要人看见的改动。
 */
function describeRuleDiff({ root, mainCommit, resultCommit }) {
  const path = ".harness/policy.json";
  const before = safeJson(root, mainCommit, path);
  const after = safeJson(root, resultCommit, path);
  if (!before || !after) return null;
  const beforeRules = safeResolve(before);
  const afterRules = safeResolve(after);
  if (!beforeRules || !afterRules) {
    return { before: null, after: null, added: [], removed: [], presetsBefore: before.presets ?? [], presetsAfter: after.presets ?? [] };
  }
  const beforeIds = new Set(beforeRules.rules.map((rule) => rule.id));
  const afterIds = new Set(afterRules.rules.map((rule) => rule.id));
  return {
    before: beforeIds.size,
    after: afterIds.size,
    added: [...afterIds].filter((id) => !beforeIds.has(id)),
    removed: [...beforeIds].filter((id) => !afterIds.has(id)),
    overlays: overlaidRules(beforeRules.rules, afterRules.rules),
    presetsBefore: before.presets ?? [],
    presetsAfter: after.presets ?? [],
  };
}

/** 首次接入时把提议的配置摘要给人看：确认的对象就是它。 */
function describeProposal(project) {
  const resolved = safeResolve(project.policy);
  const merge = project.config.merge ?? {};
  return {
    rules: resolved?.rules.length ?? 0,
    presets: project.policy.presets ?? [],
    ownRules: (project.policy.rules ?? []).length,
    disabled: project.policy.disabled ?? [],
    checks: (project.verify.checks ?? []).length,
    checkIds: (project.verify.checks ?? []).map((check) => check.id),
    requireEvidence: merge.requireEvidence !== false,
    requireReview: merge.requireReview !== false,
    confirmOnGateChange: project.config.governance?.confirmOnGateChange !== false,
    postMergeCommand: Array.isArray(merge.postMergeCommand) ? merge.postMergeCommand.join(" ") : null,
  };
}

function safeResolve(policy) {
  try {
    return resolvePolicy(policy);
  } catch {
    return null;
  }
}

// 同 id 但内容不同的规则（项目里覆盖了预设），确认时也要点名，否则改宽了某条规则看不出来。
function overlaidRules(before, after) {
  const beforeById = new Map(before.map((rule) => [rule.id, rule]));
  const changed = [];
  for (const rule of after) {
    const prior = beforeById.get(rule.id);
    if (!prior) continue;
    const strip = (item) => JSON.stringify({ ...item, preset: undefined });
    if (strip(prior) !== strip(rule)) changed.push(rule.id);
  }
  return changed;
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
  const project = loadGateProject(cwd, { branch });
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
  if (summary.bootstrap && summary.proposal) {
    const p = summary.proposal;
    lines.push("首次接入：确认后这份配置成为主分支的门禁信任根");
    lines.push(`  拦截规则 ${p.rules} 条（预设 ${p.presets.join(",") || "无"}，项目自有 ${p.ownRules} 条${p.disabled.length ? `，关闭 ${p.disabled.join(",")}` : ""}）`);
    lines.push(`  验证检查 ${p.checks} 项：${p.checkIds.join(", ")}`);
    lines.push(`  合并要求：证据 ${p.requireEvidence ? "必需" : "不要求"}，评审 ${p.requireReview ? "必需" : "不要求"}，门禁改动确认 ${p.confirmOnGateChange ? "必需" : "不要求"}`);
    if (p.postMergeCommand) lines.push(`  合并后命令：${p.postMergeCommand}`);
  }
  if (summary.delivery) {
    const d = summary.delivery;
    if (d.error) {
      lines.push(`交付设置: 合并结果里无法解析（${d.error}）`);
    } else if (d.changed) {
      lines.push(`交付设置: ${describeDelivery(d.before)} -> ${describeDelivery(d.after)}`);
      lines.push(`  由此授予: ${d.grant}`);
    } else {
      lines.push(`交付设置: ${describeDelivery(d.after)}${d.before ? "（本次不变）" : ""}`);
      // 首次接入没有“改前”，确认的就是这份授权本身，同样要写明。
      lines.push(`  ${d.before ? "当前权限" : "由此授予"}: ${d.grant}`);
    }
  }
  if (summary.ruleDiff) {
    const { before, after, added, removed, overlays = [], presetsBefore, presetsAfter } = summary.ruleDiff;
    lines.push(`拦截规则: ${before ?? "?"} -> ${after ?? "?"}`);
    if (added.length) lines.push(`  新增: ${added.join(", ")}`);
    if (removed.length) lines.push(`  移除: ${removed.join(", ")}`);
    if (overlays.length) lines.push(`  内容有改动: ${overlays.join(", ")}`);
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
