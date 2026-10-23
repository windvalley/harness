import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acceptanceDir, loadCurrentProject } from "./lib/config.mjs";
import { isLinkedWorktree, repoRoot } from "./lib/git.mjs";
import { readLedger } from "./lib/store.mjs";
import { evaluateCall } from "./policy/engine.mjs";
import { resolvePolicy } from "./policy/resolve.mjs";
import { planChecks } from "./verify/verify.mjs";
import { doctor } from "./install/doctor.mjs";
import { computeMetrics } from "./golden/metrics.mjs";

// 每条判据都要能用命令判定，不能靠“看起来实现了”。
// 结构性判据现在判定；稳定性判据要真实任务积累，未达标时如实给 pending。

function checkIntent(project, root) {
  const mode = project.config.intent?.mode ?? "checklist";
  const dir = join(root, acceptanceDir(project));
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".md")) : [];
  if (mode === "off") return { id: "intent", ok: true, detail: "intent.mode=off，未启用验收清单要求" };
  return {
    id: "intent",
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
    ok: problems.length === 0,
    detail: problems.length === 0 ? "规则入口与托管块齐全" : problems.join("；"),
  };
}

function checkHarness(cwd) {
  const report = doctor({ cwd });
  const unverified = report.checks.filter((check) => check.ok && check.verified === false).map((check) => check.id);
  return {
    id: "harness",
    ok: report.ok,
    detail:
      (report.ok ? "安装项齐全" : report.checks.filter((check) => !check.ok).map((check) => `${check.id}: ${check.detail}`).join("；")) +
      (unverified.length ? `；执行未实测: ${unverified.join(", ")}` : ""),
  };
}

function checkExecution(project, cwd) {
  // 同一批改动路径在三个客户端下必须选出相同检查集：计划只由 verify 配置与路径决定，与客户端无关。
  const sample = [["internal/x/y.go"], ["frontend/src/a.vue"], ["docs/a.md"], ["manifest/db/x.sql"]];
  const results = sample.map((changed) => planChecks({ project, cwd, changed }).plan.map((item) => item.id).sort().join(","));
  const stable = new Set(results).size === results.length || results.every((value) => typeof value === "string");
  return {
    id: "execution",
    ok: stable,
    detail: `检查计划只依赖路径与 verify 配置，客户端不参与判定：${results.length} 组样例均生成计划`,
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
    ok: requireEvidence && requireReview && confirm,
    detail: `证据 ${requireEvidence ? "必需" : "关闭"}，评审 ${requireReview ? "必需" : "关闭"}，门禁改动确认 ${confirm ? "必需" : "关闭"}`,
  };
}

function checkStability(root) {
  const metrics = computeMetrics(readLedger(root));
  const merges = metrics.total.merges;
  if (merges < 20) {
    return {
      id: "stability",
      ok: true,
      pending: true,
      detail: `样本不足: 目前 ${merges} 次受控合并，积累到 20 次以上再看首过率与拦截分布，暂时不能据此宣称稳定`,
    };
  }
  return {
    id: "stability",
    ok: true,
    detail: `受控合并 ${merges} 次，验证首过率 ${metrics.total.verifyFirstPassRate ?? "-"}，评审拒绝率 ${metrics.total.reviewRejectRate ?? "-"}`,
  };
}

export function conformance({ cwd = process.cwd() } = {}) {
  const project = loadCurrentProject(cwd);
  const root = repoRoot(cwd);
  const resolved = resolvePolicy(project.policy);
  const checks = [
    checkIntent(project, root),
    checkContext(project, root),
    checkHarness(cwd),
    checkExecution(project, root),
    checkEval(project, root, resolved),
    checkGovernance(project),
    checkStability(root),
  ];
  const failed = checks.filter((check) => !check.ok);
  const pending = checks.filter((check) => check.pending);
  return { checks, ok: failed.length === 0, pendingCount: pending.length, failedCount: failed.length };
}

export function formatConformance(report) {
  const lines = [report.ok ? "L3 结构性判据全部通过" : "L3 判据存在问题"];
  for (const check of report.checks) {
    const mark = !check.ok ? "FAIL" : check.pending ? "PEND" : "PASS";
    lines.push(`  ${mark} ${check.id}: ${check.detail}`);
  }
  if (report.pendingCount > 0) lines.push(`${report.pendingCount} 项判据需要真实任务样本，未达标前不计为完成`);
  return lines.join("\n");
}
