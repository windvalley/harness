import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { deliverySettings, describeDelivery, loadCurrentProject, loadGateProject, loadGuardProject, loadTrustedProject, mainBranch } from "./lib/config.mjs";
import { changedPaths, git, gitOk, mainWorktreeRoot, mergeBase, repoRoot, resolveCommit } from "./lib/git.mjs";
import { keyStatus, readLedger, rotateKey, scanRecords } from "./lib/store.mjs";
import { resolvePolicy, ruleStats } from "./policy/resolve.mjs";
import { evaluateCall } from "./policy/engine.mjs";
import { guard, renderDenial } from "./adapters/index.mjs";
import { claude } from "./adapters/claude.mjs";
import { codex } from "./adapters/codex.mjs";
import { dsh } from "./adapters/dsh.mjs";
import { planChecks, verify } from "./verify/verify.mjs";
import { MergeError, mergeTask } from "./merge/merge.mjs";
import { submitTask } from "./delivery/submit.mjs";
import { syncTask } from "./delivery/sync.mjs";
import { reviewBranch } from "./review/review.mjs";
import { approveConfirm, confirmSummary, formatSummary } from "./confirm/confirm.mjs";
import { approvePlan, formatPlanSummary, planSummary } from "./plan/plan.mjs";
import { checkCommitMessage, checkStaged, guardReference } from "./githook.mjs";
import { answerEscalation, listEscalations, openEscalation, readEscalation, resumePlan } from "./escalate/escalate.mjs";
import { runGolden } from "./golden/golden.mjs";
import { computeMetrics, formatMetrics } from "./golden/metrics.mjs";
import { initProject, upgradeProject } from "./install/init.mjs";
import { uninstall } from "./install/uninstall.mjs";
import { branchStatus, formatStatus } from "./status.mjs";
import { stopCheck } from "./stop/stop.mjs";
import { installAll, installLocal, installVersion, listVersions, pruneVersions, publishVersion, versionDir } from "./install/install.mjs";
import { formatSurvey } from "./install/survey.mjs";
import { followUps } from "./install/followups.mjs";
import { doctor, formatDoctor } from "./install/doctor.mjs";
import { conformance, formatConformance } from "./conformance.mjs";
import { cleanWorktrees, formatCleanPlan, formatCleanResult, planCleanup } from "./worktree/clean.mjs";
import { packageVersion } from "./install/managed.mjs";

const ADAPTERS = { claude, codex, dsh };

const USAGE = `harness <命令> [参数]

工程流程
  verify   [--head <ref>] [--base <ref>] [--branch <名称>] [--no-reuse] [--plan]   对分支验证并写签名证据；--plan 只列出会执行的检查
  review   --branch <名称>                          独立评审
  status   --branch <名称>                           只读汇总：还差哪几步才能合并
  confirm  --branch <名称> [--yes]                   查看门禁改动；--yes 记录人工确认
  approve  --branch <名称> [--yes --note <原话>]     查看任务方案；用户同意实施后加 --yes，--note 照录用户原话
  merge    --branch <名称> [--dry-run]               受控合并到主分支（本地交付）
  submit   --branch <名称>                           推送核对过的提交并创建或更新 PR/MR（远程交付）
  sync     [--remote <远程>]                         把本地主分支快进到远程主分支；--remote 只在首次接入时使用
  worktree clean [--yes] [--with-local-files]       预览已合并的任务 Worktree；--yes 才删除，含 .env 这类本机文件的要再加 --with-local-files

体检与度量
  doctor                                             安装与接入自检
  conformance                                        检查 L3 判据
  metrics  [--days <n>]                              按周度量
  golden   [--worktree]                              重放黄金任务；--worktree 按工作区配置而不是主分支
  rules                                              列出解析后的拦截规则

接入与维护
  init     [--dry-run] [--take-over] [--force]       接入或升级当前项目：先调查现状，--dry-run 只预览
  install  [--take-over] [--local] [--version <v>]   重新生成入口与钩子；--local 只刷新本机共用部分；--version 只装指定版本
  upgrade                                            升级项目到当前版本
  uninstall [--purge] [--dry-run]                    解除接入；--purge 连 .harness/ 一起删
  versions                                           列出已安装的版本
  prune    [--keep <v,...>] [--dry-run]              清理旧版本，默认只保留当前版本
  publish  [--version <v>]                           把当前代码装进版本目录
  version                                            打印版本
  key      <status|rotate> [--yes]                   证据密钥现状；rotate 由人执行，会作废全部已有记录

客户端与钩子入口
  githook  <pre-commit|commit-msg|reference-transaction>   由 git 钩子调用
  hook     --client <claude|codex|dsh> [--event <pre-tool-use|stop>]   由客户端钩子调用，读 stdin；stop 是收尾检查
  check    --kind <shell|write|read|search|commit> ... [--on-main] [--linked-worktree] [--ignored]   手工判定一次调用

人用
  escalate <open|list|show|answer|resume>             例外上报
`;

function print(text) {
  process.stdout.write(`${text}\n`);
}

async function cmdVerify(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      head: { type: "string" },
      base: { type: "string" },
      branch: { type: "string" },
      plan: { type: "boolean", default: false },
      "no-reuse": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const cwd = process.cwd();
  if (values.plan) return cmdVerifyPlan({ cwd, branch: values.branch ?? values.head ?? "HEAD", base: values.base, json: values.json });
  const head = values.branch ?? values.head ?? "HEAD";
  // 证据按“被验证的提交”索引，不按分支名（名字里可能有 /，且分支会移动）。
  const recordKey = values.branch ? git(repoRoot(cwd), ["rev-parse", "--verify", `${values.branch}^{commit}`]).stdout.trim() : undefined;
  const outcome = await verify({ cwd, head, base: values.base, reuse: !values["no-reuse"], recordKey, gateBranch: values.branch ?? values.head });
  if (values.json) print(JSON.stringify(outcome.record, null, 2));
  const lines = [`验证结果: ${outcome.status}`];
  for (const item of outcome.results) {
    lines.push(`  ${item.skipped ? "SKIP" : item.exit === 0 ? "PASS" : "FAIL"} ${item.id}${item.reused ? " (复用)" : ""}`);
  }
  for (const item of outcome.notExecuted) lines.push(`  NOT_EXECUTED ${item.id}: ${item.reason}`);
  for (const item of outcome.advisory ?? []) lines.push(`  ADVISORY ${item.id}: ${item.hint}`);
  process.stderr.write(`${lines.join("\n")}\n`);
  for (const item of outcome.results.filter((entry) => entry.exit !== 0 && !entry.skipped)) {
    process.stderr.write(`\n--- ${item.id} 失败输出(末尾) ---\n${item.tail ?? ""}\n`);
  }
  return outcome.status === "passed" ? 0 : 1;
}

/** 只算不改：列出这次会选中哪些检查、哪些记为未执行，不执行也不写证据。 */
function cmdVerifyPlan({ cwd, branch, base, json }) {
  const project = loadGateProject(cwd, { branch });
  const root = project.root;
  const mainRef = base ?? mainBranch(project);
  const head = resolveCommit(root, branch);
  const baseCommit = resolveCommit(root, mainRef);
  const baseOfHead = mergeBase(root, baseCommit, head);
  const changed = changedPaths(root, baseOfHead, head);
  // 已删除的路径不能交给选择器；其余以当前工作区估算（在该分支的 Worktree 里运行时与真实验证一致）。
  const deleted = new Set(
    gitOk(root, ["diff", "--name-only", "--diff-filter=D", "--no-renames", baseOfHead, head]).split("\n").filter(Boolean),
  );
  const { plan, notExecuted, advisory, docOnly } = planChecks({
    project,
    cwd: root,
    changed,
    exists: (path) => !deleted.has(path) && existsSync(join(root, path)),
  });
  if (json) {
    print(JSON.stringify({ base: mainRef, head, changed, docOnly, plan, notExecuted, advisory }, null, 2));
    return 0;
  }
  print(`相对 ${mainRef} 变更 ${changed.length} 个文件${docOnly ? "（仅文档）" : ""}`);
  for (const item of plan) print(`  RUN  ${item.id}  ${item.cmd.join(" ")}${item.cwd && item.cwd !== "." ? `  (cwd ${item.cwd})` : ""}`);
  for (const item of notExecuted) print(`  TODO ${item.id}  ${item.reason}`);
  for (const item of advisory) print(`  HINT ${item.id}  ${item.hint}`);
  return 0;
}

async function cmdReview(argv) {
  const { values } = parseArgs({ args: argv, options: { branch: { type: "string" } } });
  if (!values.branch) {
    process.stderr.write("用法: harness review --branch <名称>\n");
    return 2;
  }
  try {
    const record = await reviewBranch({ cwd: process.cwd(), branch: values.branch });
    const lines = [
      `评审结论: ${record.verdict}`,
      `  需求符合度: ${record.requirementFit?.rating} - ${record.requirementFit?.evidence ?? ""}`,
      `  工程质量: ${record.engineeringQuality?.rating} - ${record.engineeringQuality?.evidence ?? ""}`,
      `  验收清单来源: ${record.acceptanceSource ?? "无"}`,
      `  评审后端: ${record.backend ?? "未知"}`,
    ];
    for (const item of record.findings) {
      lines.push(`  [${item.severity}] ${item.file}${item.line ? `:${item.line}` : ""} ${item.summary}`);
      lines.push(`      场景: ${item.scenario}`);
    }
    process.stderr.write(`${lines.join("\n")}\n`);
    return record.verdict === "approve" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`评审失败: ${error.message}\n`);
    return 1;
  }
}

async function cmdMerge(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { branch: { type: "string" }, "dry-run": { type: "boolean", default: false } },
  });
  try {
    const result = await mergeTask({ cwd: process.cwd(), branch: values.branch, dryRun: values["dry-run"] });
    print(JSON.stringify(result, null, 2));
    if (result.followUps?.length > 0) {
      process.stderr.write(`\n合并完成，还需要在客户端做:\n${result.followUps.map((note) => `  - ${note}`).join("\n")}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof MergeError) {
      process.stderr.write(`合并被拒绝(${error.code}): ${error.message}\n`);
      return error.code === "post_merge_failed" ? 3 : 1;
    }
    throw error;
  }
}

const DELIVERY_EXIT = { post_merge_failed: 3 };

async function cmdSubmit(argv) {
  const { values } = parseArgs({ args: argv, options: { branch: { type: "string" } } });
  if (!values.branch) {
    process.stderr.write("用法: harness submit --branch <名称>\n");
    return 2;
  }
  try {
    const result = await submitTask({ cwd: process.cwd(), branch: values.branch, log: (line) => process.stderr.write(`${line}\n`) });
    print(result.url);
    print(JSON.stringify(result, null, 2));
    if (result.followUps?.length > 0) {
      process.stderr.write(`\n提交完成，还需要在客户端做:\n${result.followUps.map((note) => `  - ${note}`).join("\n")}\n`);
    }
    return 0;
  } catch (error) {
    if (error.code) {
      process.stderr.write(`提交被拒绝(${error.code}): ${error.message}\n`);
      return DELIVERY_EXIT[error.code] ?? 1;
    }
    throw error;
  }
}

function cmdSync(argv) {
  const { values } = parseArgs({ args: argv, options: { remote: { type: "string" } } });
  try {
    const result = syncTask({ cwd: process.cwd(), remote: values.remote ?? null, log: (line) => process.stderr.write(`${line}\n`) });
    print(JSON.stringify(result, null, 2));
    if (result.followUps?.length > 0) {
      process.stderr.write(`\n同步完成，还需要在客户端做:\n${result.followUps.map((note) => `  - ${note}`).join("\n")}\n`);
    }
    return 0;
  } catch (error) {
    if (error.code) {
      process.stderr.write(`同步被拒绝(${error.code}): ${error.message}\n`);
      return DELIVERY_EXIT[error.code] ?? 1;
    }
    throw error;
  }
}

async function cmdConfirm(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { branch: { type: "string" }, yes: { type: "boolean", default: false }, note: { type: "string" } },
  });
  if (!values.branch) {
    process.stderr.write("用法: harness confirm --branch <名称> [--yes] [--note 说明]\n");
    return 2;
  }
  if (!values.yes) {
    print(formatSummary(confirmSummary({ cwd: process.cwd(), branch: values.branch })));
    print("\n以上为只读摘要。确认无误后加 --yes 记录本次确认。");
    return 0;
  }
  const { summary } = approveConfirm({ cwd: process.cwd(), branch: values.branch, note: values.note ?? "" });
  print(`已确认合并结果 tree ${summary.resultTree.slice(0, 12)}，涉及门禁文件 ${summary.gateTouched.length} 个。`);
  return 0;
}

function cmdApprove(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { branch: { type: "string" }, yes: { type: "boolean", default: false }, note: { type: "string" } },
  });
  if (!values.branch) {
    process.stderr.write("用法: harness approve --branch <名称> [--yes --note <用户同意实施的原话>]\n");
    return 2;
  }
  if (!values.yes) {
    print(formatPlanSummary(planSummary({ cwd: process.cwd(), branch: values.branch })));
    print("\n以上为只读摘要。用户表达开始实施的意思后，加 --yes --note \"<用户原话>\" 记录授权；验收清单之后再改，要重新取得同意。");
    return 0;
  }
  const { summary } = approvePlan({ cwd: process.cwd(), branch: values.branch, note: values.note ?? "" });
  print(`已记录 ${values.branch} 的实施授权（依据：${values.note.trim()}；验收清单 ${summary.acceptancePath}，方案文件 ${summary.planFiles.length} 个）。`);
  return 0;
}

async function cmdWorktree(argv) {
  const [action, ...rest] = argv;
  if (action !== "clean") {
    process.stderr.write("用法: harness worktree clean [--yes] [--with-local-files]\n");
    return 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: { yes: { type: "boolean", default: false }, "with-local-files": { type: "boolean", default: false } },
  });
  // 进度写到 stderr，结果写到 stdout：重定向结果时照样能看到进度。
  const options = { cwd: process.cwd(), withLocalFiles: values["with-local-files"], log: (line) => process.stderr.write(`${line}\n`) };
  if (!values.yes) {
    print(formatCleanPlan(planCleanup(options)));
    return 0;
  }
  const outcome = await cleanWorktrees(options);
  print(formatCleanResult(outcome));
  return outcome.interrupted ? 130 : 0;
}

function cmdGithook(argv) {
  const [name] = argv;
  const cwd = process.cwd();
  const root = repoRoot(cwd);
  const project = loadGuardProject(cwd);
  // 没接入 harness 的仓库（或钩子残留）直接放行，不能挡住正常的 git 操作。
  if (!project) return 0;
  const resolved = resolvePolicy(project.policy);

  if (name === "pre-commit") {
    const result = checkStaged({ root, resolved });
    if (result.decision === "deny") {
      process.stderr.write(`${formatDenialText(result)}\n`);
      return 1;
    }
    return 0;
  }
  if (name === "commit-msg") {
    const messageFile = argv[1];
    if (!messageFile) {
      process.stderr.write("[harness] commit-msg 钩子缺少提交信息文件参数\n");
      return 1;
    }
    const result = checkCommitMessage({ root, resolved, messageFile });
    if (result.decision === "deny") {
      process.stderr.write(`${formatDenialText(result)}\n`);
      return 1;
    }
    return 0;
  }
  if (name === "reference-transaction") {
    const input = readFileSync(0, "utf8");
    const getRef = (ref) => {
      const out = git(root, ["rev-parse", "--verify", "--quiet", ref]);
      return out.status === 0 ? out.stdout.trim() : null;
    };
    const result = guardReference({ input, token: process.env.HARNESS_MERGE_TOKEN ?? "", cwd: root, getRef });
    if (result.decision === "deny") {
      process.stderr.write(`${result.reason}\n${mainWriteHint(project)}\n`);
      return 1;
    }
    return 0;
  }
  process.stderr.write(`未知的 git 钩子: ${name}\n`);
  return 2;
}

/** 主分支保护拒绝时的正确做法，按项目的交付方式给出；配置读不出时按默认的本地交付提示。 */
function mainWriteHint(project) {
  let settings;
  try {
    settings = deliverySettings(project.config);
  } catch {
    settings = deliverySettings(undefined);
  }
  if (settings.mode === "remote") {
    return [
      `本项目是远程交付（${settings.provider}，远程 ${settings.remote}）：本地主分支不合并，只由 harness sync 从平台主分支快进。`,
      "正确做法: 在任务分支提交后运行 harness submit --branch <任务分支> 创建或更新 PR/MR，平台合入后运行 harness sync。",
    ].join("\n");
  }
  return [
    "本地主分支只允许由 harness merge 更新，它会先核对证据与评审；从远程主分支快进用 harness sync。",
    "正确做法: 在任务分支提交后运行 harness merge --branch <任务分支>。",
  ].join("\n");
}

/** 接管钩子目录时 core.hooksPath 的处理结果，state 取值见 ensureHooksPath。 */
function formatHooksPath({ state, target, current, previous }) {
  switch (state) {
    case "ok":
      return `core.hooksPath 已指向 ${target}`;
    case "switched":
      return `core.hooksPath 已从 ${previous ?? "(未设置)"} 改为 ${target}，所有 Worktree 执行这一份钩子`;
    case "pending":
      return `主 Worktree 里还没有生成的钩子，core.hooksPath 保持 ${current ?? "(未设置)"}；合入主分支后 harness merge 自动切换到 ${target}`;
    default:
      return `已写入公共配置，但 core.hooksPath 仍是 ${current}，可能被 Worktree 级配置覆盖，检查 config.worktree 后运行 harness install --local`;
  }
}

function formatDenialText(result) {
  return [`[harness] 已拦截: ${result.reason}`, result.detail ? `对象: ${result.detail}` : "", result.fix ? `正确做法: ${result.fix}` : "", `规则: ${result.rule}`]
    .filter(Boolean)
    .join("\n");
}

function cmdHook(argv) {
  const { values } = parseArgs({ args: argv, options: { client: { type: "string" }, event: { type: "string", default: "pre-tool-use" } } });
  const adapter = ADAPTERS[values.client];
  if (!adapter) {
    process.stderr.write(`未知客户端: ${values.client ?? "(缺失)"}\n`);
    return 2;
  }
  if (values.event === "stop") return cmdStopHook(adapter);
  if (values.event !== "pre-tool-use") {
    process.stderr.write(`未知钩子事件: ${values.event}，可选 pre-tool-use 或 stop\n`);
    return 2;
  }
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.stderr.write("[harness] 钩子输入不是有效 JSON，按失败处理\n");
    return 2;
  }
  const outcome = guard({ adapter, payload });
  if (outcome.decision === "error") {
    process.stderr.write(`[harness] 门禁无法加载项目配置: ${outcome.message}\n`);
    return 2;
  }
  if (outcome.decision === "deny") {
    const rendered = renderDenial(outcome);
    if (rendered.stdout) process.stdout.write(rendered.stdout);
    process.stderr.write(rendered.stderr);
    return rendered.exitCode;
  }
  return 0;
}

/**
 * Claude Code 与 Codex 的 Stop 事件：输出 {"decision":"block","reason":...} 让 Agent 接着做，什么都不输出则放行。
 * 收尾检查出错时放行并提示，不能因为门禁自己的问题把会话困住。
 */
function cmdStopHook(adapter) {
  const notice = (text) => process.stdout.write(`${JSON.stringify({ systemMessage: `[harness] ${text}` })}\n`);
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    notice("收尾检查的输入不是有效 JSON，本次放行");
    return 0;
  }
  try {
    const outcome = stopCheck({ cwd: payload?.cwd || process.cwd(), client: adapter.name, session: payload?.session_id });
    if (outcome.decision === "block") process.stdout.write(`${JSON.stringify({ decision: "block", reason: outcome.reason })}\n`);
  } catch (error) {
    notice(`收尾检查出错，本次放行: ${error.message}`);
  }
  return 0;
}

function cmdCheck(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      kind: { type: "string" },
      command: { type: "string" },
      path: { type: "string" },
      content: { type: "string" },
      glob: { type: "string" },
      "on-main": { type: "boolean", default: false },
      "linked-worktree": { type: "boolean", default: false },
      ignored: { type: "boolean", default: false },
    },
  });
  const project = loadTrustedProject(process.cwd());
  const resolved = resolvePolicy(project.policy);
  const call =
    values.kind === "shell"
      ? { kind: "shell", command: values.command ?? "" }
      : { kind: values.kind, path: values.path, content: values.content, glob: values.glob };
  const context = { onMainBranch: values["on-main"], linkedWorktree: values["linked-worktree"], ignored: values.ignored };
  const result = evaluateCall({ policy: resolved, root: project.root, call, context });
  if (result.decision === "deny") {
    process.stderr.write(`${formatDenialText(result)}\n`);
    return 1;
  }
  print("allow");
  return 0;
}

function cmdEscalate(argv) {
  const [action, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: { file: { type: "string" }, id: { type: "string" }, status: { type: "string" }, choice: { type: "string" }, note: { type: "string" } },
  });
  const root = repoRoot(process.cwd());
  try {
    switch (action) {
      case "open": {
        const raw = values.file ? readFileSync(values.file, "utf8") : readFileSync(0, "utf8");
        const record = openEscalation(root, JSON.parse(raw));
        print(JSON.stringify(record, null, 2));
        process.stderr.write(`已创建 ${record.id}。答复: harness escalate answer --id ${record.id} --choice <${record.options.map((o) => o.id).join("|")}>\n`);
        return 0;
      }
      case "list":
        print(JSON.stringify(listEscalations(root, values.status), null, 2));
        return 0;
      case "show":
        print(JSON.stringify(readEscalation(root, values.id), null, 2));
        return 0;
      case "answer":
        print(JSON.stringify(answerEscalation(root, values.id, { choice: values.choice, note: values.note }), null, 2));
        return 0;
      case "resume": {
        const plan = resumePlan(root, values.id);
        print(JSON.stringify(plan, null, 2));
        return plan.ready ? 0 : 1;
      }
      default:
        process.stderr.write("用法: harness escalate <open|list|show|answer|resume>\n");
        return 2;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

const RECORD_CODE_LABELS = {
  key_rotated: "由另一把密钥签发",
  signature: "签名不符",
  key_missing: "密钥缺失无法校验",
  key_invalid: "密钥格式不正确无法校验",
  mismatch: "与目标不一致",
  unparsable: "无法解析",
};

function describeScan() {
  let scan;
  try {
    scan = scanRecords(repoRoot(process.cwd()));
  } catch {
    // 不在 git 仓库里时只报告密钥本身。
    return null;
  }
  const parts = Object.entries(scan.byCode).map(([code, count]) => `${RECORD_CODE_LABELS[code] ?? code} ${count} 条`);
  return `本仓库记录: 共 ${scan.total} 条，当前密钥可校验 ${scan.ok} 条${parts.length ? `；${parts.join("，")}` : ""}`;
}

function cmdKey(argv) {
  const [action = "status", ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { yes: { type: "boolean", default: false } } });
  if (action === "status") {
    const status = keyStatus();
    const lines = [`证据密钥: ${status.file}`];
    if (!status.exists) {
      lines.push("  不存在。下次运行 verify、review 或 install 时会自动生成；已有记录将无法校验");
    } else {
      lines.push(status.valid ? `  指纹: ${status.fingerprint}` : `  不可用: ${status.reason}`);
      const mode = status.mode.toString(8).padStart(3, "0");
      lines.push(status.private ? `  权限: ${mode}，仅本人可读` : `  权限: ${mode}，其他用户可读，需要由人收紧为 600`);
    }
    const scan = describeScan();
    if (scan) lines.push(scan);
    print(lines.join("\n"));
    return status.exists && status.valid && status.private ? 0 : 1;
  }
  if (action === "rotate") {
    if (!values.yes) {
      const scan = describeScan();
      print(
        [
          "轮换会把当前密钥移入 retired/ 并生成新密钥。",
          "此后所有已有的验证证据、独立评审与门禁确认都会失效，进行中的分支需要重新 verify、review，涉及门禁的还要重新 confirm。",
          "适用场景: 密钥可能泄露、密钥文件损坏，或者需要统一作废旧记录。",
          scan ?? "",
          "确认后加 --yes 执行。",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return 0;
    }
    const result = rotateKey();
    print(`已轮换证据密钥，新指纹 ${result.fingerprint}${result.previous ? `，旧指纹 ${result.previous}` : ""}`);
    if (result.retired) print(`旧密钥已移到 ${result.retired}，仅供误操作时由人手工恢复`);
    print("已有记录全部失效：进行中的分支需要重新运行 harness verify 与 harness review。");
    return 0;
  }
  process.stderr.write("用法: harness key <status|rotate> [--yes]\n");
  return 2;
}

function cmdInit(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "take-over": { type: "boolean", default: false },
    },
  });
  const cwd = process.cwd();
  const takeOver = values["take-over"];
  const result = initProject({ cwd, force: values.force, dryRun: values["dry-run"], takeOver });
  const report = result.report;
  print(formatSurvey(report, { takeOver, planned: result.planned, stack: result.stack }));
  if (result.dryRun) {
    print("");
    print("以上为预览，没有写入任何文件。确认后去掉 --dry-run 执行。");
    return 0;
  }

  print("");
  print(`已写入（版本 ${result.version}，代码在 ${versionDir(result.version)}）`);
  if (result.install.gitignore.shimIgnored) {
    process.stderr.write("[harness] 入口仍被 .gitignore 忽略，请手工放行 .harness/bin/harness，否则 Linked Worktree 里没有入口\n");
    return 1;
  }

  const branch = report.branch;
  const onMain = report.onMain || !report.mainRef;
  // 交付方式决定最后一步用 merge 还是 submit：已接入时取主分支的配置，首次接入取刚写入的配置。
  let delivery;
  try {
    delivery = deliverySettings(loadCurrentProject(result.root).config);
  } catch {
    delivery = deliverySettings(undefined);
  }
  const deliver = delivery.mode === "remote" ? "submit" : "merge";
  print("");
  print(`交付方式: ${delivery.mode === "remote" ? describeDelivery(delivery) : "本地交付（默认）"}`);
  if (delivery.mode === "remote") {
    print("  门禁通过后由 harness submit 推送任务分支并创建或更新 PR/MR，在平台上合并，合入后用 harness sync 更新本地主分支。");
  } else if (report.harnessOnMain) {
    print("  门禁通过后由 harness merge 合入本地主分支。两种方式只能选一种；要改用 PR/MR，在任务分支修改 delivery 并经人确认，");
    print("  见参考手册的“交付方式：本地与远程”。");
  } else {
    print("  门禁通过后由 harness merge 合入本地主分支。两种方式只能选一种；主分支在 GitHub 或 GitLab 上、合并走 PR/MR 时，");
    print('  在提交接入改动前把 .harness/config.json 的 delivery 改为 { "mode": "remote", "provider": "github" }（GitLab 写 gitlab），');
    print("  接入分支就会以 PR/MR 提交：确认后运行 harness submit --branch <接入分支>，平台合入后运行 harness sync。");
  }
  print("");
  print("下一步");
  print("  接入流程由 Agent 按项目规则接续处理，用户只需在需要时做决定或亲自操作，不必重复提醒验证、评审和交付要求。");
  print("  Agent 按项目规则准备任务分支与需要的 Worktree；下面的命令由 Agent 执行，标明由人的除外。");
  print("  Agent 需核对项目真实检查命令，明确起始占位、未执行项和待处理项，初始化成功不等于全部接入完成。");
  if (report.harnessOnMain) {
    print(`  1. 在任务分支提交本次改动后按日常任务流程交付：harness verify / review / ${deliver} --branch ${onMain ? "<任务分支>" : branch}`);
    print("     涉及门禁配置、规则、入口或钩子时，Agent 展示 harness confirm 摘要，带 --yes 的确认由人在自己的终端执行。");
  } else if (onMain) {
    print("  Agent：当前在主分支上，先核对已有改动，按项目规则准备接入分支，例如 git switch -c chore/harness-onboard 后提交，");
    print(`  再走 harness verify / review / confirm / ${deliver}，${delivery.mode === "remote" ? "平台合入后 harness sync" : "合并时"}会把这份配置变成主分支的信任根。`);
    print("  项目规则允许、没有其他门禁且用户明确选择不走受控评审时，也可以直接在主分支提交，提交后即生效。");
  } else {
    print(`  1. 检查并提交本次接入改动（需要包含 .harness/bin/harness，保留用户原有改动）`);
    print(`  2. harness verify --branch ${branch}`);
    print(`  3. harness review --branch ${branch}`);
    print(`  4. Agent 展示摘要：harness confirm --branch ${branch}；看过后由人在自己的终端执行带 --yes 的确认，自然语言同意不能替代`);
    print(
      delivery.mode === "remote"
        ? `  5. harness submit --branch ${branch}，平台合入后在主 Worktree 运行 harness sync`
        : `  5. harness merge --branch ${branch}`,
    );
  }
  if (report.conflicts.length > 0 && !takeOver) {
    print("  原有的主分支保护或 Agent 钩子被保留；如果合并时被它们拒绝，加 --take-over 重新运行 init。");
  }
  if (report.legacyDirs.length > 0) {
    print(`  合入后可以另开任务退役原有工具: ${report.legacyDirs.join(", ")}`);
  }
  // Codex 按路径记录信任，提示里给主 Worktree 的路径：合入后各个钩子都调用那里的入口。
  const notes = followUps({ mainRoot: mainWorktreeRoot(result.root), changed: [".claude/settings.json"], bootstrap: true });
  if (notes.length > 0) {
    print("");
    print("客户端（合入主分支后，由用户按当前客户端完成；完成后让 Agent 运行 doctor 并说明已验证与待验证项）");
    for (const note of notes) print(`  - ${note}`);
  }
  return 0;
}

function formatDshPlugin(dsh) {
  return `DeepSeek Harness 插件（本机共用）: ${dsh.dir}${dsh.updated ? "，已更新，已注册的 DeepSeek Harness 重启后生效" : ""}`;
}

function currentBranchForStatus() {
  const result = git(repoRoot(process.cwd()), ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.status === 0 ? result.stdout.trim() : "";
}

export async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    print(USAGE);
    return command ? 0 : 2;
  }
  try {
    switch (command) {
      case "version":
        print(packageVersion());
        return 0;
      case "publish": {
        const { values } = parseArgs({ args: rest, options: { version: { type: "string" } } });
        if (values.version && values.version !== packageVersion()) {
          // 版本目录按版本号不可变，把当前代码装成别的版本号会让锁定该版本的项目跑错代码。
          process.stderr.write(
            `当前代码是 ${packageVersion()}，不能装成 ${values.version}。在项目目录运行 node <harness 仓库>/bin/harness.mjs install --local，会按标签 v${values.version} 安装\n`,
          );
          return 2;
        }
        const result = publishVersion({ version: packageVersion() });
        print(JSON.stringify(result, null, 2));
        return 0;
      }
      case "init":
        return cmdInit(rest);
      case "install": {
        const { values } = parseArgs({
          args: rest,
          options: {
            "take-over": { type: "boolean", default: false },
            local: { type: "boolean", default: false },
            version: { type: "string" },
          },
        });
        if (values.version) {
          if (values.local || values["take-over"]) {
            process.stderr.write("--version 只把指定版本装进本机版本目录，不改项目文件；不能与 --local 或 --take-over 一起用\n");
            return 2;
          }
          const outcome = installVersion({ version: values.version });
          print(`已安装版本 ${outcome.version} 到 ${outcome.dir}（项目文件未改动，本机共用钩子也未刷新）`);
          if (outcome.fromTag) print("  代码来自 harness 仓库的标签，本机已有版本目录未受影响");
          return 0;
        }
        if (values.local) {
          const local = installLocal({ cwd: process.cwd() });
          if (local.fromTag) print(`项目锁定版本 ${local.published.version}，已从 harness 仓库的标签 v${local.published.version} 安装`);
          if (local.output) process.stdout.write(local.output);
          else print(`已刷新本机: 版本 ${local.published.version}${local.hooksTracked ? "；钩子目录随分支入库，无需刷新" : `；git 钩子 ${local.hooks.dir}`}`);
          if (local.hooksPath) print(`  ${formatHooksPath(local.hooksPath)}`);
          if (local.dsh) print(`  ${formatDshPlugin(local.dsh)}`);
          return local.hooksPath?.state === "overridden" ? 1 : 0;
        }
        const result = installAll({ cwd: process.cwd(), takeOver: values["take-over"] });
        print(`已安装版本 ${result.published.version}，入口 ${result.shim}`);
        for (const hook of result.hooks.hooks) print(`  git 钩子 ${hook.file}${hook.updated ? "(已接入)" : "(已存在)"}`);
        if (result.hooksPath) print(`  ${formatHooksPath(result.hooksPath)}`);
        print(`  Claude PreToolUse: ${result.claude}`);
        print(`  Codex hooks: ${result.codex}`);
        print(`  ${formatDshPlugin(result.dsh)}`);
        if (result.gitignore.shimIgnored) {
          process.stderr.write(`[harness] 入口仍被 .gitignore 忽略，请手工放行 ${".harness/bin/harness"}，否则 Linked Worktree 里没有入口\n`);
          return 1;
        }
        if (result.shimTracked === false) print(`  下一步: 提交 .harness/bin/harness，否则 Linked Worktree 里没有入口`);
        return 0;
      }
      case "status": {
        const { values } = parseArgs({ args: rest, options: { branch: { type: "string", default: currentBranchForStatus() } } });
        if (!values.branch) {
          process.stderr.write("用法: harness status --branch <名称>\n");
          return 2;
        }
        const status = branchStatus({ cwd: process.cwd(), branch: values.branch });
        print(formatStatus(status));
        return status.ready ? 0 : 1;
      }
      case "uninstall": {
        const { values } = parseArgs({
          args: rest,
          options: { purge: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false } },
        });
        const outcome = uninstall({ cwd: process.cwd(), purge: values.purge, dryRun: values["dry-run"] });
        print(`${outcome.dryRun ? "将移除" : "已移除"}（${outcome.root}）:`);
        for (const item of outcome.removed) print(`  ${item}`);
        if (outcome.kept.length > 0) {
          print("保留:");
          for (const item of outcome.kept) print(`  ${item}`);
        }
        return 0;
      }
      case "versions": {
        const current = packageVersion();
        for (const version of listVersions()) print(`${version}${version === current ? "  (当前)" : ""}`);
        return 0;
      }
      case "prune": {
        const { values } = parseArgs({
          args: rest,
          options: { keep: { type: "string" }, "dry-run": { type: "boolean", default: false } },
        });
        const keep = values.keep ? values.keep.split(",").map((v) => v.trim()).filter(Boolean) : [packageVersion()];
        const outcome = pruneVersions({ keep, dryRun: values["dry-run"] });
        print(`${outcome.dryRun ? "将删除" : "已删除"} ${outcome.removed.length} 个旧版本: ${outcome.removed.join(", ") || "(无)"}`);
        print(`保留: ${outcome.kept.join(", ")}`);
        return 0;
      }
      case "upgrade": {
        const result = upgradeProject({});
        print(`已升级到 ${result.version}，入口 ${result.shim.shim}`);
        if (result.shim.hooksPath) print(`  ${formatHooksPath(result.shim.hooksPath)}`);
        return 0;
      }
      case "doctor": {
        const report = doctor({});
        print(formatDoctor(report));
        return report.ok ? 0 : 1;
      }
      case "conformance": {
        const report = conformance({});
        print(formatConformance(report));
        return report.ok ? 0 : 1;
      }
      case "rules": {
        const project = loadTrustedProject(process.cwd());
        const resolved = resolvePolicy(project.policy);
        const stats = ruleStats(resolved);
        print(`预设: ${stats.presets.join(", ") || "无"}  规则 ${stats.total} 条`);
        for (const [kind, count] of Object.entries(stats.byKind)) print(`  ${kind}: ${count}`);
        for (const rule of resolved.rules) print(`  ${rule.id}  [${rule.kind}]${rule.when ? ` when=${rule.when}` : ""}${rule.preset ? `  preset=${rule.preset}` : ""}`);
        return 0;
      }
      case "metrics": {
        const { values } = parseArgs({ args: rest, options: { days: { type: "string" } } });
        const root = repoRoot(process.cwd());
        print(formatMetrics(computeMetrics(readLedger(root), { sinceDays: values.days ? Number(values.days) : undefined })));
        return 0;
      }
      case "golden": {
        const { values } = parseArgs({ args: rest, options: { worktree: { type: "boolean", default: false } } });
        const { summary, results } = runGolden({ cwd: process.cwd(), source: values.worktree ? "worktree" : "main" });
        const skipped = summary.skipped > 0 ? `，跳过 ${summary.skipped} 项` : "";
        print(`黄金任务 ${summary.passed}/${summary.total} 通过 (${(summary.passRate * 100).toFixed(0)}%)${skipped}`);
        for (const item of results) {
          if (item.skipped) {
            print(`  SKIP ${item.id} ${item.title ?? ""}（${item.skipped}）`);
            continue;
          }
          print(`  ${item.passed ? "PASS" : "FAIL"} ${item.id} ${item.title ?? ""}`);
          for (const failure of item.failures) print(`       - ${failure}`);
        }
        return summary.failed === 0 ? 0 : 1;
      }
      case "verify":
        return cmdVerify(rest);
      case "review":
        return cmdReview(rest);
      case "merge":
        return cmdMerge(rest);
      case "submit":
        return cmdSubmit(rest);
      case "sync":
        return cmdSync(rest);
      case "confirm":
        return cmdConfirm(rest);
      case "approve":
        return cmdApprove(rest);
      case "worktree":
        return cmdWorktree(rest);
      case "githook":
        return cmdGithook(rest);
      case "hook":
        return cmdHook(rest);
      case "check":
        return cmdCheck(rest);
      case "escalate":
        return cmdEscalate(rest);
      case "key":
        return cmdKey(rest);
      default:
        process.stderr.write(`未知命令: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}
