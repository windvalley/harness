import { acceptancePath, loadGateProject } from "./lib/config.mjs";
import { showBlob, statusShort, worktreeEntries } from "./lib/git.mjs";
import { redact } from "./lib/redact.mjs";
import { listEscalations } from "./escalate/escalate.mjs";
import { planSummary } from "./plan/plan.mjs";
import { branchStatus } from "./status.mjs";

const EVIDENCE_STEPS = new Set([
  "evidence",
  "evidence:attested",
  "evidence:postMerge",
  "review",
  "plan",
  "gate",
  "risk",
  "post-merge",
  "submit",
  "stages",
]);

const clean = (value) => redact(value ?? "");
const command = (name, branch) => `harness ${name} --branch ${branch}`;

function relatedEscalations(root, branch) {
  try {
    return { items: listEscalations(root).filter((item) => item.context?.branch === branch), problem: null };
  } catch (error) {
    return { items: [], problem: error.message };
  }
}

export function branchHandoff({ cwd, branch }) {
  const status = branchStatus({ cwd, branch });
  const project = loadGateProject(cwd, { branch });
  const root = project.root;
  let summary = null;
  let summaryProblem = null;
  try {
    summary = planSummary({ cwd, branch });
  } catch (error) {
    summaryProblem = error.message;
  }
  const path = acceptancePath(project, branch);
  const branchAcceptance = status.branchCommit ? showBlob(root, status.branchCommit, path) : null;
  const mainAcceptance = branchAcceptance === null && status.mainCommit ? showBlob(root, status.mainCommit, path) : null;
  const approvedPlanFiles = summary?.approval?.approved ? summary.approval.record.planFiles ?? [] : [];
  const planFiles = [...new Set([...(summary?.planFiles ?? []), ...approvedPlanFiles])]
    .filter((file) => file !== path)
    .sort();
  let worktrees = [];
  let worktreeProblem = null;
  try {
    worktrees = worktreeEntries(root)
      .filter((entry) => entry.branch === branch)
      .map((entry) => {
        try {
          return { ...entry, dirty: statusShort(entry.path), problem: null };
        } catch (error) {
          return { ...entry, dirty: "", problem: error.message };
        }
      });
  } catch (error) {
    worktreeProblem = error.message;
  }
  return {
    status,
    summary,
    summaryProblem,
    acceptance: { path, text: branchAcceptance ?? mainAcceptance, source: branchAcceptance !== null ? "任务分支" : mainAcceptance !== null ? "主分支" : null },
    planFiles,
    worktrees,
    worktreeProblem,
    escalations: relatedEscalations(root, branch),
  };
}

function addNextSteps(handoff, lines) {
  const initialLength = lines.length;
  const { status } = handoff;
  const branch = status.branch;
  const steps = new Map(status.steps.map((step) => [step.id, step]));
  if (status.merged) {
    for (const item of status.postMerge?.pending ?? []) {
      lines.push(`完成合并后验收 ${item.id}：harness attest --branch ${branch} --check ${item.id} --command "<实际命令>" --report <报告>`);
    }
    if (lines.length === initialLength) lines.push("无需重复交付；核对最终用户验收、未执行项和实际环境。");
    return;
  }
  if (steps.get("acceptance")?.state === "fail") lines.push(`补齐并提交验收清单 ${handoff.acceptance.path}。`);
  if (steps.get("plan")?.state === "fail") lines.push(`向用户说明当前方案与变化，取得同意后运行 ${command("approve", branch)} --yes --note "<用户原话>"。`);
  if (steps.get("evidence")?.state === "fail") lines.push(`处理验证缺项后运行 ${command("verify", branch)}。`);
  if (steps.get("review")?.state === "fail") lines.push(`处理评审发现及前置验证后运行 ${command("review", branch)}。`);
  for (const id of ["gate", "risk"]) {
    if (steps.get(id)?.state === "fail") lines.push(`运行 ${command("confirm", branch)} 展示摘要，由人核对后在自己的终端带 --yes 确认。`);
  }
  if (status.ready) {
    if (status.delivery?.mode === "remote") {
      lines.push(status.submitted?.current && status.submitted.stage === "ready"
        ? "等待平台合并；合入后运行 harness sync 更新本地主分支。"
        : `门禁已齐备，运行 ${command("submit", branch)}。`);
    } else {
      lines.push(`门禁已齐备，运行 ${command("merge", branch)}。`);
    }
  }
  for (const item of handoff.escalations.items.filter((item) => item.status === "answered")) {
    lines.push(`查看已答复上报并接续：harness escalate resume --id ${item.id}。`);
  }
  if (lines.length === initialLength) lines.push(`处理阻塞与注意项，再用 ${command("status", branch)} 核对。`);
}

export function formatHandoff(handoff) {
  const { status, summary } = handoff;
  const lines = [
    "# 任务交接",
    "",
    "## 分支与基线",
    "",
    `- 任务分支：\`${clean(status.branch)}\``,
    `- 分支 HEAD：\`${status.branchCommit ?? "未知"}\``,
    `- 主分支：\`${clean(status.mainRef)}\``,
    `- 主分支 HEAD：\`${status.mainCommit ?? "未知"}\``,
    `- 交付方式：${status.delivery?.mode === "remote" ? "远程交付（PR/MR）" : "本地交付"}`,
    `- 当前状态：${status.merged ? "已合入主分支" : status.ready ? "门禁已齐备，待交付" : `待完成 ${status.blockers.length} 项门禁`}`,
    "",
    "## 需求与已确认决策",
    "",
    `- 验收清单：${handoff.acceptance.source ? `\`${handoff.acceptance.path}\`（来自${handoff.acceptance.source}）` : `没有验收清单 \`${handoff.acceptance.path}\``}`,
  ];
  if (handoff.planFiles.length > 0) {
    lines.push("- 已提交方案与需求文件：");
    for (const path of handoff.planFiles) lines.push(`  - \`${clean(path)}\``);
  } else {
    lines.push("- 没有已提交方案与需求文件。");
  }
  if (summary?.approval?.approved) {
    const record = summary.approval.record;
    lines.push(`- 有效实施授权：${clean(record.note)}（记录人 ${clean(record.by)}，时间 ${record.approvedAt}）。`);
  } else {
    const reason = summary?.approval?.reason ?? handoff.summaryProblem ?? "未读取授权状态";
    const optional = summary?.reasons.length === 0 ? "；按当前改动不需要实施授权" : "";
    lines.push(`- 没有有效实施授权：${clean(reason)}${optional}。`);
  }
  lines.push("", "## 验收清单正文", "");
  lines.push(handoff.acceptance.text === null ? "没有验收清单，需求符合度仍需补齐依据。" : clean(handoff.acceptance.text).trimEnd());
  lines.push("", "## Worktree 与未提交改动", "");
  if (handoff.worktrees.length === 0) lines.push("- 未检出到 Worktree。");
  for (const entry of handoff.worktrees) {
    lines.push(`- Worktree：\`${clean(entry.path)}\``);
    if (entry.problem) lines.push(`  - 无法读取工作区状态：${clean(entry.problem)}`);
    else if (!entry.dirty) lines.push("  - 未提交改动：无。");
    else {
      lines.push("  - 未提交改动：", "", "```text", clean(entry.dirty), "```");
    }
  }
  if (handoff.worktreeProblem) lines.push(`- 无法枚举 Worktree：${clean(handoff.worktreeProblem)}`);
  lines.push("", "## 当前有效证据", "");
  const completed = status.steps.filter((step) => (["ok", "done"].includes(step.state) || (step.id === "stages" && step.state === "info")) && EVIDENCE_STEPS.has(step.id));
  if (completed.length === 0) lines.push("- 没有已登记且当前有效的完成证据。");
  for (const step of completed) lines.push(`- ${step.id}：${clean(step.detail)}`);
  lines.push("", "## 阻塞与注意项", "");
  const unresolved = status.steps.filter((step) => ["fail", "warn"].includes(step.state));
  if (unresolved.length === 0) lines.push("- 无。");
  for (const step of unresolved) lines.push(`- ${step.id}：${clean(step.detail)}`);
  lines.push("", "## 相关上报与外部状态", "");
  if (handoff.escalations.problem) lines.push(`- 无法读取上报：${clean(handoff.escalations.problem)}`);
  else if (handoff.escalations.items.length === 0) lines.push("- 没有关联上报。");
  for (const item of handoff.escalations.items) {
    lines.push(`- ${item.id}（${item.status}）：${clean(item.blocker)}`);
    const attempted = Array.isArray(item.attempted) ? item.attempted.join("；") : item.attempted;
    lines.push(`  - 情况：${clean(item.situation)}；已尝试：${clean(attempted)}`);
    if (item.status === "open") lines.push(`  - 建议动作：${clean(item.resumeHint ?? item.defaultAction)}。`);
    if (item.status === "answered") lines.push(`  - 人工答复：${clean(item.answer?.choice)}；${clean(item.answer?.note)}。`);
    if (item.status === "resolved") lines.push(`  - 技术解除：${clean(item.resolution?.reason)}；证据：${clean(item.resolution?.evidence)}。`);
  }
  lines.push("- 外部副作用与恢复点：没有结构化记录；接手前核对上述上报、方案文件和实际环境，不能把未记录解释为不存在。");
  lines.push("", "## 下一步", "");
  addNextSteps(handoff, lines);
  lines.push("", "## 恢复入口", "");
  lines.push(`- \`${command("status", status.branch)}\``);
  lines.push(`- \`${command("status --handoff", status.branch)}\``);
  return lines.join("\n");
}
