import { computeMetrics } from "../golden/metrics.mjs";
import { loadCurrentProject, deliverySettings, mainBranch } from "../lib/config.mjs";
import { redact } from "../lib/redact.mjs";
import { scanRecords } from "../lib/store.mjs";
import { resolvePolicy } from "../policy/resolve.mjs";
import { doctor } from "../install/doctor.mjs";
import { conformance } from "../conformance.mjs";
import { openPostMergeObligations } from "../status.mjs";
import { listProjects } from "./projects.mjs";
import { readObservedLedger } from "./ledger.mjs";
import { captureHealth, readHealthHistory } from "./health.mjs";
import { buildTaskFunnel } from "./analysis.mjs";

export const SNAPSHOT_SCHEMA = 1;
const WINDOW_DAYS = new Set([7, 30, 90]);

function errorWarning(code, error) {
  return { code, detail: redact(error?.message ?? String(error)) };
}

function activeDays(events, cutoff) {
  return new Set(events.filter((event) => Date.parse(event.at) >= cutoff).map((event) => event.at.slice(0, 10))).size;
}

function eventTimeline(events) {
  return events.slice(-30).reverse().map((event) => ({
    id: event.id ?? null,
    at: event.at,
    event: event.event,
    outcome: event.verdict ?? event.status ?? event.outcome ?? null,
    branch: event.branch ?? null,
    taskId: event.taskId ?? null,
    checkId: event.checkId ?? null,
    rule: event.rule ?? null,
    client: event.client ?? null,
    failed: event.failed ?? [],
    harnessVersion: event.harnessVersion ?? null,
  }));
}

function configSummary(project) {
  const resolved = resolvePolicy(project.policy);
  const checks = project.verify.checks ?? [];
  return {
    sourceRef: project.sourceRef ?? "worktree",
    sourceCommit: project.sourceCommit ?? null,
    bootstrap: Boolean(project.bootstrap),
    mainBranch: mainBranch(project),
    delivery: deliverySettings(project.config),
    rules: resolved.rules.length,
    checks: checks.length,
    automaticChecks: checks.filter((check) => check.tier !== "extended" && check.tier !== "advisory").length,
    extendedChecks: checks.filter((check) => check.tier === "extended").length,
    requireReview: project.config.merge?.requireReview !== false,
    requireEvidence: project.config.merge?.requireEvidence !== false,
  };
}

function healthSummary(root) {
  const doctorReport = doctor({ cwd: root });
  const conformanceReport = conformance({ cwd: root });
  return {
    doctor: {
      ok: doctorReport.ok,
      checks: doctorReport.checks.map((check) => ({ id: check.id, ok: check.ok, verified: check.verified ?? null, detail: redact(check.detail) })),
    },
    conformance: {
      ok: conformanceReport.ok,
      pendingCount: conformanceReport.pendingCount,
      failedCount: conformanceReport.failedCount,
      checks: conformanceReport.checks.map((check) => ({ id: check.id, layer: check.layer, ok: check.ok, pending: Boolean(check.pending), detail: redact(check.detail) })),
    },
  };
}

function repeated(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].map(([id, count]) => ({ id, count })).filter((item) => item.count > 1).sort((a, b) => b.count - a.count);
}

function buildInsights(project) {
  const insights = [];
  const add = (code, summary, command, evidence, uncertainty = "提示只描述已记录现象，不自动推断根因") => {
    insights.push({ code, projectId: project.projectId, summary, command, evidence, uncertainty });
  };
  for (const check of project.health?.doctor.checks ?? []) {
    if (!check.ok) add("doctor_check_failed", `${check.id} 当前未通过：${check.detail}`, "harness doctor", `采集时点 ${project.health.capturedAt}`);
  }
  if (project.config?.automaticChecks === 0) {
    add("automatic_checks_missing", "没有可自动执行的验证检查", "harness conformance", "当前生效配置中的自动检查数为 0", "项目可能依赖外部证据，需结合实际研发流程判断");
  }
  for (const item of project.repeatedFailedChecks.slice(0, 5)) {
    add("verify_check_repeated", `检查 ${item.id} 在已记录验证中失败 ${item.count} 次`, "harness verify --branch <分支>", `${item.count} 条正式验证事件`);
  }
  for (const item of project.policyByRule.filter((entry) => entry.count >= 3).slice(0, 5)) {
    add("policy_denials_repeated", `规则 ${item.id} 已记录 ${item.count} 次拒绝`, "harness rules", `${item.count} 条 policy.deny 事件`, "拒绝可能表示规则有效，也可能提示工作方式不匹配，需要人工复核");
  }
  if (project.postMerge.pending.length > 0) {
    add("post_merge_pending", `${project.postMerge.pending.length} 项合并后验收待完成`, "harness status --post-merge", project.postMerge.pending.map((item) => `${item.branch}:${item.checkId}`).join("、"), "待办只反映当前本机记录");
  }
  return insights;
}

function projectSnapshot(project, { cutoff, now, includeHealth }) {
  const warnings = [];
  let ledger = { events: [], coverage: { exists: false }, warnings: [] };
  if (["active", "uninstalled"].includes(project.status)) {
    try {
      ledger = readObservedLedger(project.mainWorktree, { projectId: project.projectId });
      warnings.push(...ledger.warnings);
    } catch (error) {
      warnings.push(errorWarning("ledger_read_failed", error));
    }
  }
  const scopedEvents = ledger.events.filter((event) => Date.parse(event.at) >= cutoff);
  const metrics = computeMetrics(ledger.events, { sinceDays: Math.round((now - cutoff) / 86_400_000), now });
  const snapshot = {
    projectId: project.projectId,
    displayName: project.displayName,
    commonDir: project.commonDir,
    mainWorktree: project.mainWorktree,
    status: project.status,
    state: warnings.some((warning) => warning.code === "ledger_read_failed") ? "read_failed" : !ledger.coverage.exists ? "no_data" : scopedEvents.length === 0 ? "no_activity" : "active",
    firstSeenAt: project.firstSeenAt,
    lastRegisteredAt: project.lastRegisteredAt,
    lastHarnessVersion: project.lastHarnessVersion ?? null,
    latestEventHarnessVersion: [...ledger.events].reverse().find((event) => event.harnessVersion)?.harnessVersion ?? null,
    activeDays: activeDays(ledger.events, cutoff),
    activityCount: scopedEvents.length,
    lastActivityAt: ledger.coverage.lastEventAt ?? null,
    metrics,
    recentEvents: eventTimeline(ledger.events),
    repeatedFailedChecks: repeated(ledger.events.filter((event) => event.event === "verify").flatMap((event) => event.failed ?? [])),
    policyByRule: repeated(ledger.events.filter((event) => event.event === "policy.deny").map((event) => event.rule)),
    policyByClient: repeated(ledger.events.filter((event) => event.event === "policy.deny").map((event) => event.client)),
    coverage: ledger.coverage,
    warnings,
    config: null,
    health: null,
    records: null,
    postMerge: { pending: [] },
  };
  if (project.status === "active") {
    try {
      snapshot.config = configSummary(loadCurrentProject(project.mainWorktree));
    } catch (error) {
      warnings.push(errorWarning("config_read_failed", error));
    }
    if (includeHealth) {
      try {
        snapshot.health = { capturedAt: new Date(now).toISOString(), ...healthSummary(project.mainWorktree) };
      } catch (error) {
        warnings.push(errorWarning("health_read_failed", error));
      }
      try {
        snapshot.records = scanRecords(project.mainWorktree);
      } catch (error) {
        warnings.push(errorWarning("records_read_failed", error));
      }
      try {
        const obligations = openPostMergeObligations({ cwd: project.mainWorktree });
        snapshot.postMerge = {
          pending: obligations.open.map((item) => ({ checkId: item.checkId, branch: item.branch, howToVerify: redact(item.howToVerify ?? ""), problem: item.problem ? redact(item.problem) : null })),
        };
      } catch (error) {
        warnings.push(errorWarning("obligations_read_failed", error));
      }
    }
  }
  snapshot.insights = buildInsights(snapshot);
  Object.defineProperty(snapshot, "_events", { value: ledger.events, enumerable: false });
  snapshot.taskFunnel = buildTaskFunnel(snapshot);
  const delivered = snapshot.taskFunnel.tasks.filter((task) => task.delivery);
  snapshot.taskRates = {
    deliveredTasks: delivered.length,
    verifyPerDeliveredTask: delivered.length ? delivered.reduce((sum, task) => sum + task.verifyRuns, 0) / delivered.length : null,
    reviewPerDeliveredTask: delivered.length ? delivered.reduce((sum, task) => sum + task.reviewRuns, 0) / delivered.length : null,
  };
  return snapshot;
}

function emptyCoverage() {
  return {
    registeredProjects: 0,
    readSucceededProjects: 0,
    readFailedProjects: 0,
    noDataProjects: 0,
    noActivityProjects: 0,
    missingProjects: 0,
    unreadableProjects: 0,
    invalidProjects: 0,
    uninstalledProjects: 0,
    parsedEvents: 0,
    invalidLines: 0,
    invalidTimestamps: 0,
    legacyEvents: 0,
    duplicateEvents: 0,
    unknownEvents: 0,
    firstEventAt: null,
    lastEventAt: null,
    limitations: ["registered_projects_only", "workflow_events_only", "ledger_is_best_effort", "unsigned_ledger"],
  };
}

export function buildSnapshot({ days = 30, now = Date.now(), includeHealth = true, captureHealth: shouldCaptureHealth = false } = {}) {
  if (!WINDOW_DAYS.has(days)) throw new Error("时间范围只支持 7、30、90 天");
  const timestamp = typeof now === "number" ? now : new Date(now).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("采集时间无效");
  const cutoff = timestamp - days * 86_400_000;
  const warnings = [];
  let registered;
  try {
    registered = listProjects();
  } catch (error) {
    registered = [];
    warnings.push(errorWarning("registry_read_failed", error));
  }
  const projects = registered.map((project) => projectSnapshot(project, { cutoff, now: timestamp, includeHealth: includeHealth || shouldCaptureHealth }));
  for (const project of projects) {
    if (shouldCaptureHealth) captureHealth(project, timestamp);
    const history = readHealthHistory(project.projectId);
    project.healthHistory = history.samples;
    warnings.push(...history.warnings.map((warning) => ({ ...warning, projectId: project.projectId })));
  }
  const allEvents = projects.flatMap((project) => project._events.map((event) => ({
    ...event,
    tree: event.tree ? `${project.projectId}:${event.tree}` : event.tree,
  })));
  const metrics = computeMetrics(allEvents, { sinceDays: days, now: timestamp });
  const coverage = emptyCoverage();
  coverage.registeredProjects = registered.length;
  for (const project of projects) {
    if (project.state === "read_failed") coverage.readFailedProjects += 1;
    else if (["active", "uninstalled"].includes(project.status)) coverage.readSucceededProjects += 1;
    if (project.state === "no_data") coverage.noDataProjects += 1;
    if (project.state === "no_activity") coverage.noActivityProjects += 1;
    for (const key of ["missing", "unreadable", "invalid", "uninstalled"]) {
      if (project.status === key) coverage[`${key}Projects`] += 1;
    }
    for (const key of ["parsedEvents", "invalidLines", "invalidTimestamps", "legacyEvents", "duplicateEvents", "unknownEvents"]) {
      coverage[key] += project.coverage[key] ?? 0;
    }
    if (project.coverage.firstEventAt && (!coverage.firstEventAt || project.coverage.firstEventAt < coverage.firstEventAt)) coverage.firstEventAt = project.coverage.firstEventAt;
    if (project.coverage.lastEventAt && (!coverage.lastEventAt || project.coverage.lastEventAt > coverage.lastEventAt)) coverage.lastEventAt = project.coverage.lastEventAt;
    warnings.push(...project.warnings.map((warning) => ({ ...warning, projectId: project.projectId })));
  }
  return {
    schemaVersion: SNAPSHOT_SCHEMA,
    generatedAt: new Date(timestamp).toISOString(),
    timeRange: { days, since: new Date(cutoff).toISOString(), until: new Date(timestamp).toISOString(), weekBoundary: "UTC_MONDAY" },
    projects,
    metrics,
    coverage,
    warnings,
    insights: projects.flatMap((project) => project.insights),
    healthHistory: projects.flatMap((project) => project.healthHistory.map((sample) => ({ projectId: project.projectId, ...sample }))),
    taskFunnel: {
      tasks: projects.flatMap((project) => project.taskFunnel.tasks),
      unlinkedEvents: projects.reduce((sum, project) => sum + project.taskFunnel.unlinkedEvents, 0),
    },
  };
}
