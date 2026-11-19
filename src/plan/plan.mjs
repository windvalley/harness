import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { acceptancePath, loadGateProject, mainBranch, trustedMainRef } from "../lib/config.mjs";
import { acceptanceDigest, describeAcceptanceChange, hasSectionedDigest } from "../lib/acceptance.mjs";
import { matchAny } from "../lib/glob.mjs";
import { changedPaths, git, mergeBase, refExists, resolveCommit, showBlob } from "../lib/git.mjs";
import { redact } from "../lib/redact.mjs";
import { appendLedger, readRecord, writeRecord } from "../lib/store.mjs";
import { postMergeHits } from "../verify/checks.mjs";
import { prepareGrant, readGrant, stageApprovalProblem, stageLanding, writeGrant } from "./stages.mjs";

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

// 风险信号：paths 命中要人确认（T2），deps 命中要实施授权（T1，启用 plan-first 时生效）。
// mode: enforce（默认）按上面执行；observe 只记录命中的信号、不拦截，用来在真实项目里先看误报再决定要不要执行。
// exclude 只豁免 paths：测试夹具、说明文档放在敏感目录里不该要人确认；deps 不受它影响，免得项目自己加进去的依赖清单被误豁免。
// 配置里没有 risk 就都不启用，已接入项目升级后行为不变；init 给新项目写入下面的默认值。
// 默认 deps 只放声明依赖的清单：锁文件常被 npm install、go mod tidy 顺带改动，package.json 里还有 scripts 等无关字段，默认都不放；项目确有需要时自己加。
export const RISK_DEFAULTS = {
  paths: [".github/workflows/**", ".gitlab-ci.yml", ".circleci/**", "**/Jenkinsfile", "**/Dockerfile", "deploy/**"],
  exclude: ["**/*.md", "**/testdata/**", "**/test/**", "**/tests/**", "**/__tests__/**", "**/fixtures/**"],
  deps: ["**/go.mod", "**/requirements*.txt", "**/Pipfile", "**/Gemfile"],
};

/** 读取风险配置；形状不对时返回 error，由调用方按需要人确认处理（出错就按最严处理）。 */
export function riskSettings(config) {
  const raw = config?.risk;
  if (raw === undefined || raw === null) return { paths: [], deps: [], exclude: [], observe: false, active: false, error: null };
  const isGlobs = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
  const broken = (error) => ({ paths: [], deps: [], exclude: [], observe: false, active: true, error });
  if (typeof raw !== "object" || Array.isArray(raw)) return broken("risk 必须是对象");
  for (const key of ["paths", "deps", "exclude"]) {
    if (raw[key] !== undefined && !isGlobs(raw[key])) return broken(`risk.${key} 必须是字符串数组`);
  }
  if (raw.mode !== undefined && !["enforce", "observe"].includes(raw.mode)) return broken("risk.mode 只能是 enforce 或 observe");
  const paths = raw.paths ?? [];
  const deps = raw.deps ?? [];
  return { paths, deps, exclude: raw.exclude ?? [], observe: raw.mode === "observe", active: paths.length > 0 || deps.length > 0, error: null };
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
 * 属于多阶段方案的记录还要通过阶段校验；at 是读取携带分支方案材料的提交，缺省用分支名。
 */
export function approvalState({ root, branch, acceptanceText, at }) {
  const found = readRecord(root, PLAN_KIND, recordKey(branch));
  if (!found.ok) return { approved: false, reason: found.code === "missing" ? "还没有记录用户的实施授权" : found.reason };
  if (found.record.branch !== branch) return { approved: false, reason: `授权记录属于分支 ${found.record.branch}` };
  if (acceptanceText === null || acceptanceText === undefined) return { approved: false, reason: "缺少验收清单" };
  if (found.record.acceptanceHash !== sha(acceptanceText)) {
    // 只报“改过”会让人自己 diff；有可比的摘要时顺带说清改了哪个章节、增删几条。
    return { approved: false, reason: `授权之后验收清单又改过${describeChange({ root, record: found.record, acceptanceText })}，需要向用户说明改动并重新取得同意` };
  }
  if (found.record.stages) {
    const problem = stageApprovalProblem({ root, branch, link: found.record.stages, acceptanceText, at });
    if (problem) return { approved: false, reason: problem };
  }
  return { approved: true, record: found.record };
}

/**
 * 授权清单的差异说明。记录里有带章节的摘要时直接比；
 * 更早的记录只存了粗粒度数组，先按授权时的提交把原清单读回来重算摘要，读不回来就不给差异，不猜。
 */
function describeChange({ root, record, acceptanceText }) {
  const current = acceptanceDigest(acceptanceText);
  const recorded = record.acceptanceLines;
  if (hasSectionedDigest(recorded)) {
    const change = describeAcceptanceChange(recorded, current);
    return change ? `（${change}）` : "";
  }
  const original = restoreAcceptance({ root, record });
  if (original === null) return "";
  const change = describeAcceptanceChange(acceptanceDigest(original), current);
  return change ? `（${change}）` : "";
}

/** 授权时提交里的验收清单；记录里没写提交或对应文件取不到时返回 null。 */
function restoreAcceptance({ root, record }) {
  if (!record.branchCommit || typeof record.branchCommit !== "string") return null;
  const path = record.acceptancePath ?? `.harness/acceptance/${record.branch.replace(/[^0-9A-Za-z._-]+/g, "-")}.md`;
  try {
    const text = showBlob(root, record.branchCommit, path);
    if (typeof text === "string" && sha(text) === record.acceptanceHash) return text;
  } catch {
    // 提交已被清理：按“无法还原”处理，不给差异。
  }
  return null;
}

/** 分支的授权记录（只认能通过校验、属于这个分支的），没有时返回 null。 */
export function approvalRecord(root, branch) {
  const found = readRecord(root, PLAN_KIND, recordKey(branch));
  return found.ok && found.record.branch === branch ? found.record : null;
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
function planRequirement({ root, project, base, head }) {
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
 * 机械风险评估。每个信号带着自己的要求，一次改动的要求取并集：
 * approve 里的原因要实施授权（T1，启用 plan-first 时由调用方执行），confirm 里的原因要人确认（T2），两者互不替代。
 * 档位只用于显示：有 confirm 为 T2，只有 approve 为 T1，都没有为 T0 自动放行。
 * 判定读主分支的配置，任务分支放宽不了自己的档位；配置写坏时按需要人确认处理。
 */
export function assessRisk({ root, project, base, head }) {
  const need = planRequirement({ root, project, base, head });
  const risk = riskSettings(project.config);
  const approve = [...need.reasons];
  const confirm = [];
  const observed = [];
  if (risk.error) confirm.push(`风险配置无效（${risk.error}），按需要人确认处理`);
  else if (risk.active) {
    const paths = changedPaths(root, base, head);
    const sensitive = paths.filter((path) => matchAny(path, risk.paths) && !matchAny(path, risk.exclude));
    const deps = paths.filter((path) => matchAny(path, risk.deps));
    const sensitiveText = sensitive.length > 0 ? `敏感路径 ${sensitive.slice(0, 3).join(", ")}${sensitive.length > 3 ? ` 等 ${sensitive.length} 个` : ""}` : null;
    const depsText = deps.length > 0 ? `依赖清单变化 ${deps.slice(0, 3).join(", ")}` : null;
    if (sensitiveText) (risk.observe ? observed : confirm).push(sensitiveText);
    if (depsText) (risk.observe ? observed : approve).push(depsText);
  }
  const tier = confirm.length > 0 ? 2 : approve.length > 0 ? 1 : 0;
  return { tier, reasons: approve, confirmReasons: confirm, observed, active: risk.active, lines: need.lines, markers: need.markers, settings: need.settings };
}

/**
 * 提交前就给 Agent 看的风险提示：交付时才发现要授权或要人确认，前面的实现可能要返工。
 * 返回要输出的行，没有命中信号时为空；评估本身出错不影响验证。
 */
export function riskHints({ root, project, base, head, branch }) {
  let risk;
  try {
    risk = assessRisk({ root, project, base, head });
  } catch {
    return [];
  }
  const lines = [];
  for (const item of risk.observed) lines.push(`RISK 观察（不拦截）: ${item}`);
  if (risk.reasons.length > 0 && planEnforced(project.policy)) {
    lines.push(`RISK 要实施授权: ${risk.reasons.join("；")}。先写方案并向用户说明，用户同意后运行 harness approve --branch ${branch} --yes --note "<用户原话>"；改动本不该这么大时，现在拆小或撤掉无关改动`);
    // 已有记录但已失效时，最贵的错误是 Agent 以为还能合并；这里直接说出失效原因。
    const stale = staleApproval({ root, project, branch });
    if (stale) lines.push(`RISK 实施授权已失效: ${stale}。向用户说明改动并重新取得同意后再 approve`);
  }
  if (risk.confirmReasons.length > 0) {
    lines.push(`RISK 要人确认: ${risk.confirmReasons.join("；")}。验证与评审通过后运行 harness confirm --branch ${branch} 展示摘要，由人在自己的终端带 --yes 确认`);
  }
  return lines;
}

/** 有授权记录但不通过校验时返回原因；没有记录属于正常阶段，返回 null，交给上面的通用提示。 */
function staleApproval({ root, project, branch }) {
  try {
    // 清单被删除时把 null 交给 approvalState：它能区分“从没授权”和“授权过但清单没了”，
    // 提前返回会把后者说成普通的“要实施授权”，把真正的原因吞掉。
    const text = showBlob(root, branch, acceptancePath(project, branch));
    const state = approvalState({ root, branch, acceptanceText: text });
    if (state.approved || /还没有记录用户的实施授权/.test(state.reason)) return null;
    return state.reason.replace(/，需要向用户说明改动并重新取得同意$/, "");
  } catch {
    return null;
  }
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
  const need = assessRisk({ root, project, base, head: branchCommit });
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
    postMerge: postMergeHits({ verify: project.verify, changed: paths }),
    bootstrap: Boolean(project.bootstrap),
    approval: approvalState({ root, branch, acceptanceText: acceptance }),
  };
}

/**
 * 记录实施授权。授权来自用户在对话里的表态，命令只负责落档：note 必须照录用户原话，
 * 合并、status 与评审都会显示它，事后可以核对 Agent 是否真的得到了同意。
 * stages 给出阶段文件时，同时记录覆盖全部阶段的方案级授权，本分支是携带它的分支；
 * fromStages 给出阶段文件时，按已有的方案级授权为后续阶段记录授权，原话照搬，不接受新的 note。
 */
export function approvePlan({ cwd, branch, note = "", stages = null, fromStages = null, stage = null }) {
  if (fromStages) return deriveStage({ cwd, branch, note, file: fromStages, stage });
  const raw = String(note).trim();
  if (!raw) {
    throw new Error("记录实施授权要用 --note 照录用户表示同意实施的原话，例如 --note \"可以，开始实施\"；用户还没有同意时停下等待");
  }
  // 原话会进记录、账本和 PR/MR 描述：在入口处遮盖一次，所有下游输出都不会带出凭据。
  // 遮掉的只是凭据值，授权措辞仍然原样保留，事后仍可核对。
  const quote = redact(raw);
  const summary = planSummary({ cwd, branch });
  if (summary.acceptance === null) {
    throw new Error(`分支 ${branch} 上还没有提交验收清单 ${summary.acceptancePath}，先把方案提交到任务分支再记录授权`);
  }
  const by = userInfo().username;
  const approvedAt = new Date().toISOString();
  let link = null;
  let prepared = null;
  if (stages) {
    const project = loadGateProject(cwd, { branch });
    prepared = prepareGrant({ project, root: summary.root, branch, at: summary.branchCommit, file: stages, stage });
    link = { file: stages, stage: prepared.stage, role: "carrier" };
    // 先写方案级授权再写分支记录：中途失败时分支记录还是旧的，不会指向一份不存在的方案级授权。
    writeGrant(summary.root, { ...prepared.grant, note: quote, by, approvedAt, carrier: { branch, stage: prepared.stage } });
  }
  const record = writeRecord(summary.root, PLAN_KIND, recordKey(branch), {
    branch,
    branchCommit: summary.branchCommit,
    acceptanceHash: sha(summary.acceptance),
    acceptanceLines: acceptanceDigest(summary.acceptance),
    // 记下清单路径：旧记录要按授权时的提交还原原清单才能给出章节级差异。
    acceptancePath: summary.acceptancePath,
    planFiles: summary.planFiles,
    by,
    note: quote,
    approvedAt,
    ...(link ? { stages: link } : {}),
  });
  appendLedger(summary.root, {
    event: "plan.approve",
    branch,
    commit: summary.branchCommit,
    // 记录会被同分支的下一次授权覆盖，账本里留下原话与清单指纹，事后才能核对授权时同意了哪些内容。
    note: quote,
    acceptanceHash: record.acceptanceHash.slice(0, 16),
    ...(link ? { stages: link.file, stage: link.stage, role: link.role } : {}),
  });
  return { record, summary, stages: prepared ? { total: prepared.grant.stages.length, stage: prepared.stage, hints: prepared.hints } : null };
}

/** 按方案级授权为后续阶段记录授权：主分支上的阶段文件、本分支清单都要与授权时一致，前序阶段都已合入。 */
function deriveStage({ cwd, branch, note, file, stage }) {
  if (String(note ?? "").trim()) throw new Error("--from-stages 不接受 --note：原话取自方案级授权记录；用户同意了新的方案时，用 --stages 重新记录方案级授权");
  if (!stage) throw new Error("--from-stages 需要用 --stage 指定阶段");
  const summary = planSummary({ cwd, branch });
  if (summary.acceptance === null) {
    throw new Error(`分支 ${branch} 上还没有提交验收清单 ${summary.acceptancePath}，先把阶段验收清单复制过来并提交`);
  }
  const root = summary.root;
  const found = readGrant(root, file);
  if (!found.ok) throw new Error(`没有可用的方案级授权（${found.reason}），需要向用户说明方案并用 --stages 记录授权`);
  const grant = found.record;
  const project = loadGateProject(cwd, { branch });
  const mainCommit = resolveCommit(root, mainBranch(project));
  const onMain = showBlob(root, mainCommit, file);
  if (onMain === null || sha(onMain) !== grant.stagesHash) {
    throw new Error(`主分支上的阶段文件 ${file} 与方案授权时不一致或不存在，需要向用户说明并重新授权`);
  }
  const index = grant.stages.findIndex((item) => item.id === stage);
  if (index < 0) throw new Error(`方案 ${file} 的授权里没有阶段 ${stage}`);
  const target = grant.stages[index];
  if (sha(summary.acceptance) !== target.acceptanceHash) {
    const change = target.acceptanceLines ? describeAcceptanceChange(target.acceptanceLines, acceptanceDigest(summary.acceptance)) : null;
    throw new Error(
      `分支 ${branch} 的验收清单 ${summary.acceptancePath} 与阶段 ${stage} 授权时的清单 ${target.acceptance} 不一致${change ? `（${change}）` : ""}；先把阶段清单原样复制过来，内容要改时向用户说明并重新授权`,
    );
  }
  const landing = stageLanding({ root, file, stages: grant.stages, mainCommit });
  const pending = landing.slice(0, index).find((item) => !item.landed);
  if (pending) throw new Error(`前序阶段 ${pending.id} 还没有合入主分支，先交付它再开始阶段 ${stage}`);
  const record = writeRecord(root, PLAN_KIND, recordKey(branch), {
    branch,
    branchCommit: summary.branchCommit,
    acceptanceHash: sha(summary.acceptance),
    acceptanceLines: acceptanceDigest(summary.acceptance),
    acceptancePath: summary.acceptancePath,
    planFiles: summary.planFiles,
    by: userInfo().username,
    note: grant.note,
    approvedAt: new Date().toISOString(),
    stages: { file, stage, role: "derived" },
  });
  appendLedger(root, {
    event: "plan.approve",
    branch,
    commit: summary.branchCommit,
    note: grant.note,
    acceptanceHash: record.acceptanceHash.slice(0, 16),
    stages: file,
    stage,
    role: "derived",
  });
  return { record, summary, derived: { file, stage } };
}

export function formatPlanSummary(summary) {
  const lines = [`分支: ${summary.branch} (${summary.branchCommit.slice(0, 10)})`];
  if (!summary.enforced) lines.push("注意: 主分支的 policy.json 没有启用 plan-first 预设，授权记录不会被实时拦截与合并检查使用");
  lines.push(summary.reasons.length ? `需要实施授权: ${summary.reasons.join("；")}` : `按当前改动属于直接实施的范围（代码改动 ${summary.lines} 行）`);
  lines.push(summary.approval.approved ? `已记录实施授权（依据：${summary.approval.record.note}，${summary.approval.record.approvedAt}）` : `授权状态: ${summary.approval.reason}`);
  // 交付时才发现清单里的合并后条目没有对应检查，前面的实现可能要返工；登记授权时先摊开。
  if (summary.postMerge.length > 0) {
    lines.push("合并后检查:");
    for (const item of summary.postMerge) {
      const when = item.when.length > 0 ? item.when.join(", ") : "(未配置 when)";
      lines.push(
        item.hits.length > 0
          ? `  ${item.id}: 本次改动命中 ${item.hits.length} 个路径（when: ${when}）`
          : `  ${item.id}: 本次改动没有命中，合并后不会产生这项义务（when: ${when}）`,
      );
    }
  } else {
    lines.push("合并后检查: 主分支没有配置 phase=post-merge 的检查，验收清单不要写「合并后验收」章节");
  }
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
