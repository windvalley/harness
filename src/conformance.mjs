import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acceptanceDir, loadCurrentProject } from "./lib/config.mjs";
import { isLinkedWorktree, repoRoot } from "./lib/git.mjs";
import { readLedger } from "./lib/store.mjs";
import { evaluateCall } from "./policy/engine.mjs";
import { resolvePolicy } from "./policy/resolve.mjs";
import { checkConfigProblem } from "./verify/verify.mjs";
import { doctor } from "./install/doctor.mjs";
import { computeMetrics } from "./golden/metrics.mjs";

// 每条判据都要能用命令判定，不能靠“看起来实现了”。
// 结构性判据现在判定；稳定性判据要真实任务积累，未达标时如实给 pending。

function checkIntent(project, root) {
  const mode = project.config.intent?.mode ?? "checklist";
  const dir = join(root, acceptanceDir(project));
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".md")) : [];
  if (mode === "off") return { id: "intent", layer: "config", ok: true, detail: "intent.mode=off，未启用验收清单要求" };
  return {
    id: "intent",
    layer: "config",
    ok: true,
    detail: `intent.mode=${mode}，验收清单 ${files.length} 份；评审会把清单来源(主分支/任务分支)写进记录`,
  };
}

function checkContext(project, root) {
  const problems = [];
  const ruleDir = join(root, ".harness", "rules");
  for (const name of ["core.md", "harness.md"]) {
    if (!existsSync(join(ruleDir, name))) problems.push(`缺少 .harness/rules/${name}`);
  }
  const agents = join(root, "AGENTS.md");
  if (!existsSync(agents) || !readFileSync(agents, "utf8").includes("<!-- harness:start -->")) {
    problems.push("AGENTS.md 缺少 harness 托管块");
  }
  return {
    id: "context",
    layer: "config",
    ok: problems.length === 0,
    detail: problems.length === 0 ? "规则入口与托管块齐全" : problems.join("；"),
  };
}

function checkHarness(report) {
  return {
    id: "harness",
    layer: "config",
    ok: report.ok,
    detail: report.ok ? "安装项齐全" : report.checks.filter((check) => !check.ok).map((check) => `${check.id}: ${check.detail}`).join("；"),
  };
}

function checkClients(report) {
  const unverified = report.checks.filter((check) => check.ok && check.verified === false).map((check) => check.id);
  if (unverified.length === 0) return { id: "clients", layer: "behavior", ok: true, detail: "已接入的客户端链路均已实测" };
  return {
    id: "clients",
    layer: "behavior",
    ok: true,
    pending: true,
    detail: `客户端是否真的执行了拦截还没有实测: ${unverified.join(", ")}；配置就位不等于行为已验证`,
  };
}

function checkGolden(root) {
  const total = computeMetrics(readLedger(root)).total;
  if (total.goldenRuns === 0) {
    return { id: "golden", layer: "behavior", ok: true, pending: true, detail: "还没有重放过黄金任务，运行 harness golden 取得规则判定的行为证据" };
  }
  const rate = total.goldenLastPassRate;
  return {
    id: "golden",
    layer: "behavior",
    ok: rate === 1,
    detail: `共重放 ${total.goldenRuns} 次，最近一次通过率 ${rate === null ? "-" : `${(rate * 100).toFixed(0)}%`}`,
  };
}

function checkExecution(project) {
  // 检查计划只由 verify 配置与改动路径决定，客户端不参与；这里判定的是配置里会自动执行的检查能否真正执行。
  const checks = project.verify?.checks ?? [];
  const auto = checks.filter((check) => check.tier !== "extended" && check.tier !== "advisory");
  const invalid = auto.map((check) => ({ id: check.id, problem: checkConfigProblem(check) })).filter((item) => item.problem);
  if (invalid.length > 0) {
    return {
      id: "execution",
      layer: "behavior",
      ok: false,
      detail: `写错的自动检查: ${invalid.map((item) => `${item.id}(${item.problem.reason})`).join("；")}`,
    };
  }
  if (auto.length === 0) {
    return {
      id: "execution",
      layer: "behavior",
      ok: true,
      pending: true,
      detail: "没有会自动执行的检查，源码改动不会得到任何实际验证，先在 .harness/verify.json 声明项目的测试命令",
    };
  }
  const manual = checks.length - auto.length - checks.filter((check) => check.tier === "advisory").length;
  return {
    id: "execution",
    layer: "behavior",
    ok: true,
    detail: `${auto.length} 项自动检查命令可执行${manual > 0 ? `，${manual} 项需人工补验` : ""}`,
  };
}

function checkEval(project, root, resolved) {
  const probe = evaluateCall({
    policy: resolved,
    root,
    call: { kind: "shell", command: "git stash" },
    context: { linkedWorktree: isLinkedWorktree(root) },
  });
  return {
    id: "eval",
    layer: "behavior",
    ok: probe.decision === "deny" && Boolean(probe.fix),
    detail: probe.decision === "deny" ? "策略在无客户端场景下也能判定并给出修复方式，证据与评审绑定分支提交" : "策略未命中内置样例",
  };
}

function checkGovernance(project) {
  const requireEvidence = project.config.merge?.requireEvidence !== false;
  const requireReview = project.config.merge?.requireReview !== false;
  const confirm = project.config.governance?.confirmOnGateChange !== false;
  return {
    id: "governance",
    layer: "config",
    ok: requireEvidence && requireReview && confirm,
    detail: `证据 ${requireEvidence ? "必需" : "关闭"}，评审 ${requireReview ? "必需" : "关闭"}，门禁改动确认 ${confirm ? "必需" : "关闭"}`,
  };
}

export const STABILITY_MIN_MERGES = 20;
export const STABILITY_MAX_POST_MERGE_FAILURE_RATE = 0.05;

function checkStability(root) {
  const metrics = computeMetrics(readLedger(root));
  const { merges, postMergeFailures, goldenRuns, goldenLastPassRate } = metrics.total;
  const stats = `验证首过率 ${metrics.total.verifyFirstPassRate ?? "-"}，评审拒绝率 ${metrics.total.reviewRejectRate ?? "-"}`;
  if (merges < STABILITY_MIN_MERGES) {
    return {
      id: "stability",
      layer: "stability",
      ok: true,
      pending: true,
      detail: `样本不足: 目前 ${merges} 次受控合并，积累到 ${STABILITY_MIN_MERGES} 次以上再看首过率与拦截分布，暂时不能据此宣称稳定`,
    };
  }
  const failureRate = postMergeFailures / merges;
  const reasons = [];
  if (failureRate > STABILITY_MAX_POST_MERGE_FAILURE_RATE) {
    reasons.push(`合并后验证失败 ${postMergeFailures}/${merges} 次，超过 ${STABILITY_MAX_POST_MERGE_FAILURE_RATE * 100}%`);
  }
  if (goldenRuns === 0) reasons.push("从未重放过黄金任务");
  else if (goldenLastPassRate !== 1) reasons.push("最近一次黄金任务没有全部通过");
  if (reasons.length > 0) {
    return { id: "stability", layer: "stability", ok: true, pending: true, detail: `受控合并 ${merges} 次，${stats}；暂不能宣称稳定: ${reasons.join("；")}` };
  }
  return { id: "stability", layer: "stability", ok: true, detail: `受控合并 ${merges} 次，合并后失败 ${postMergeFailures} 次，${stats}，黄金任务最近一次全部通过` };
}

const LAYERS = [
  ["config", "配置就位"],
  ["behavior", "行为已验证"],
  ["stability", "运行稳定"],
];

function layerStatus(checks) {
  if (checks.some((check) => !check.ok)) return "fail";
  if (checks.some((check) => check.pending)) return "pending";
  return "pass";
}

export function conformance({ cwd = process.cwd() } = {}) {
  const project = loadCurrentProject(cwd);
  const root = repoRoot(cwd);
  const resolved = resolvePolicy(project.policy);
  const doctorReport = doctor({ cwd });
  const checks = [
    checkIntent(project, root),
    checkContext(project, root),
    checkHarness(doctorReport),
    checkGovernance(project),
    checkExecution(project),
    checkEval(project, root, resolved),
    checkGolden(root),
    checkClients(doctorReport),
    checkStability(root),
  ];
  const failed = checks.filter((check) => !check.ok);
  const pending = checks.filter((check) => check.pending);
  const layers = LAYERS.map(([id, label]) => ({ id, label, status: layerStatus(checks.filter((check) => check.layer === id)) }));
  return { checks, layers, ok: failed.length === 0, pendingCount: pending.length, failedCount: failed.length };
}

export function formatConformance(report) {
  const lines = [report.ok ? "L3 结构性判据全部通过" : "L3 判据存在问题"];
  const text = { pass: "已达成", pending: "待验证", fail: "有问题" };
  for (const layer of report.layers) {
    lines.push(`${layer.label}: ${text[layer.status]}`);
    for (const check of report.checks.filter((item) => item.layer === layer.id)) {
      const mark = !check.ok ? "FAIL" : check.pending ? "PEND" : "PASS";
      lines.push(`  ${mark} ${check.id}: ${check.detail}`);
    }
  }
  if (report.pendingCount > 0) lines.push(`${report.pendingCount} 项判据缺少证据，未达标前不计为完成`);
  return lines.join("\n");
}
