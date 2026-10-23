import { gatePaths, loadGateProject, mainBranch } from "./lib/config.mjs";
import { matchAny } from "./lib/glob.mjs";
import { changedPaths, gitOk, isAncestor, mainWorktreeRoot, refExists } from "./lib/git.mjs";
import { readRecord } from "./lib/store.mjs";
import { EVIDENCE_KIND } from "./verify/verify.mjs";
import { REVIEW_KIND } from "./review/review.mjs";
import { CONFIRM_KIND } from "./confirm/confirm.mjs";
import { mainWorktreeProblems, planMergeResult } from "./merge/merge.mjs";

// 确认记录绑定合并结果的 tree：快进时就是分支的 tree，三方合并时算出合并后的 tree。
function confirmFor(project, root, branch) {
  try {
    return readRecord(root, CONFIRM_KIND, planMergeResult({ project, root, branch }).resultTree);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

/**
 * 只读地汇总“这个分支现在能不能合并”。
 * 不跑任何检查、不调用评审，只读取已有记录并判断是否仍然有效。
 */
export function branchStatus({ cwd, branch }) {
  const project = loadGateProject(cwd, { branch });
  const root = project.root;
  const mainRef = mainBranch(project);
  const result = { branch, mainRef, steps: [], ready: false, blockers: [] };
  const add = (id, state, detail) => result.steps.push({ id, state, detail });

  if (!refExists(root, branch)) {
    add("branch", "fail", `分支不存在: ${branch}`);
    result.blockers.push("分支不存在");
    return result;
  }
  const branchCommit = gitOk(root, ["rev-parse", "--verify", `${branch}^{commit}`]);
  const mainCommit = gitOk(root, ["rev-parse", "--verify", `${mainRef}^{commit}`]);
  result.branchCommit = branchCommit;
  result.mainCommit = mainCommit;

  if (isAncestor(root, branchCommit, mainCommit)) {
    add("branch", "done", "该分支已经包含在主分支中");
    result.ready = true;
    return result;
  }
  add("branch", "ok", `待合入 ${branchCommit.slice(0, 10)} -> ${mainRef}`);

  // 合并在主 Worktree 里更新主分支，它不就绪时其他条件都满足也合不进去。
  const mainProblems = mainWorktreeProblems(project, mainWorktreeRoot(root));
  if (mainProblems.length > 0) {
    add("main-worktree", "fail", mainProblems.join("；"));
    result.blockers.push("主 Worktree 未就绪");
  } else {
    add("main-worktree", "ok", `主 Worktree 停在 ${mainRef} 且洁净`);
  }

  const evidence = readRecord(root, EVIDENCE_KIND, branchCommit);
  if (!evidence.ok) {
    add("evidence", "fail", `缺少验证证据：${evidence.reason}。运行 harness verify --branch ${branch}`);
    result.blockers.push("缺验证证据");
  } else if (evidence.record.status !== "passed") {
    add("evidence", "fail", `证据状态是 ${evidence.record.status}，需要修好后重跑 verify`);
    result.blockers.push("验证未通过");
  } else {
    const mainDelta = changedPaths(root, evidence.record.baseCommit, mainCommit);
    const checks = project.verify.checks ?? [];
    const touched = checks
      .filter((check) => evidence.record.checks?.some((item) => item.id === check.id))
      .filter((check) => mainDelta.some((path) => matchAny(path, check.when ?? [])));
    const pending = evidence.record.notExecuted?.length ?? 0;
    const advisory = evidence.record.advisory?.length ?? 0;
    if (touched.length === 0) {
      add("evidence", "ok", `验证通过，主分支自验证以来新增 ${mainDelta.length} 个文件，未波及已执行的检查，可直接复用`);
    } else {
      add("evidence", "warn", `验证通过，但主分支新增改动波及 ${touched.map((c) => c.id).join(", ")}，合并时会重跑`);
    }
    if (pending > 0) add("evidence:notExecuted", "warn", `${pending} 项检查未执行，合并后需在汇报里说明`);
    if (advisory > 0) add("evidence:advisory", "info", `${advisory} 项咨询项，仅提示`);
  }

  const review = readRecord(root, REVIEW_KIND, branchCommit);
  const blocking = review.ok ? (review.record.blocking ?? []) : [];
  if (!review.ok) {
    add("review", "fail", `缺少独立评审：${review.reason}。运行 harness review --branch ${branch}`);
    result.blockers.push("缺独立评审");
  } else if (review.record.verdict !== "approve" || blocking.length > 0) {
    add("review", "fail", `评审结论 ${review.record.verdict}${blocking.length ? `，${blocking.length} 条阻断级发现` : ""}`);
    result.blockers.push("评审未通过");
  } else {
    add("review", "ok", `评审通过（需求符合度 ${review.record.requirementFit?.rating ?? "?"}，工程质量 ${review.record.engineeringQuality?.rating ?? "?"}，清单来源 ${review.record.acceptanceSource ?? "无"}）`);
  }

  if (project.bootstrap) {
    // 首次接入：分支里的配置就是待确认的信任根，不论改了哪些文件都要人确认。
    const confirms = confirmFor(project, root, branch);
    if (confirms.ok) add("gate", "ok", "首次接入的门禁配置已确认");
    else {
      add("gate", "fail", `首次接入，合并前需要人确认这份门禁配置：harness confirm --branch ${branch}`);
      result.blockers.push("首次接入待确认");
    }
    result.ready = result.blockers.length === 0;
    return result;
  }

  // 门禁改动：只判断本次分支改到的文件是否落在门禁范围，真正合并时以合并结果为准。
  const branchPaths = changedPaths(root, evidence.ok ? evidence.record.base : gitOk(root, ["merge-base", mainCommit, branchCommit]), branchCommit);
  const gate = gatePaths(project);
  const gateTouched = branchPaths.filter((path) => matchAny(path, gate));
  if (gateTouched.length === 0) {
    add("gate", "ok", "本次没有改动门禁配置与规则");
  } else {
    const confirms = confirmFor(project, root, branch);
    const anyConfirm = confirms.ok;
    if (anyConfirm) add("gate", "ok", `门禁改动已确认（${gateTouched.length} 个文件）`);
    else {
      add("gate", "fail", `改动涉及门禁 ${gateTouched.length} 个文件，合并前需要人工确认：harness confirm --branch ${branch}`);
      result.blockers.push("门禁改动待确认");
    }
  }

  const acceptance = project.config.intent?.mode ?? "checklist";
  if (acceptance === "off") {
    add("acceptance", "skip", "未启用验收清单要求");
  } else {
    const rel = `${project.config.intent?.dir ?? "acceptance"}/${branch.replace(/[^0-9A-Za-z._-]+/g, "-")}.md`;
    add("acceptance", "info", `验收清单约定位置：${rel}（存在时评审会核对需求符合度）`);
  }

  result.ready = result.blockers.length === 0;
  return result;
}

export function formatStatus(status) {
  const mark = { ok: "ok", done: "ok", warn: "!!", fail: "FAIL", info: "-", skip: "-" };
  const lines = [`分支 ${status.branch} -> ${status.mainRef}`, ""];
  for (const step of status.steps) lines.push(`  [${mark[step.state] ?? step.state}] ${step.id}: ${step.detail}`);
  lines.push("");
  if (status.ready) lines.push("可以合并：harness merge --branch " + status.branch);
  else lines.push(`还差 ${status.blockers.length} 步：${status.blockers.join("、")}`);
  return lines.join("\n");
}
