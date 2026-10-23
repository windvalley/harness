import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadGuardProject, loadTrustedProject, mainBranch } from "./lib/config.mjs";
import { changedPaths, git, gitOk, mergeBase, repoRoot, resolveCommit } from "./lib/git.mjs";
import { keyStatus, readLedger, rotateKey, scanRecords } from "./lib/store.mjs";
import { resolvePolicy, ruleStats } from "./policy/resolve.mjs";
import { evaluateCall } from "./policy/engine.mjs";
import { guard, renderDenial } from "./adapters/index.mjs";
import { claude } from "./adapters/claude.mjs";
import { codex } from "./adapters/codex.mjs";
import { dsh } from "./adapters/dsh.mjs";
import { planChecks, verify } from "./verify/verify.mjs";
import { MergeError, mergeTask } from "./merge/merge.mjs";
import { reviewBranch } from "./review/review.mjs";
import { approveConfirm, confirmSummary, formatSummary } from "./confirm/confirm.mjs";
import { checkCommitMessage, checkStaged, guardReference } from "./githook.mjs";
import { answerEscalation, listEscalations, openEscalation, readEscalation, resumePlan } from "./escalate/escalate.mjs";
import { runGolden } from "./golden/golden.mjs";
import { computeMetrics, formatMetrics } from "./golden/metrics.mjs";
import { initProject, upgradeProject } from "./install/init.mjs";
import { uninstall } from "./install/uninstall.mjs";
import { branchStatus, formatStatus } from "./status.mjs";
import { installAll, listVersions, pruneVersions, publishVersion, verifyVersion, versionDir } from "./install/install.mjs";
import { doctor, formatDoctor } from "./install/doctor.mjs";
import { conformance, formatConformance } from "./conformance.mjs";
import { packageVersion } from "./install/managed.mjs";

const ADAPTERS = { claude, codex, dsh };

const USAGE = `harness <命令> [参数]

工程流程
  verify   [--head <ref>] [--base <ref>] [--branch <名称>] [--no-reuse] [--plan]   对分支验证并写签名证据；--plan 只列出会执行的检查
  review   --branch <名称>                          独立评审
  status   --branch <名称>                           只读汇总：还差哪几步才能合并
  confirm  --branch <名称> [--yes]                   查看门禁改动；--yes 记录人工确认
  merge    --branch <名称> [--dry-run]               受控合并到主分支

体检与度量
  doctor                                             安装与接入自检
  conformance                                        检查 L3 判据
  metrics  [--days <n>]                              按周度量
  golden   [--worktree]                              重放黄金任务；--worktree 按工作区配置而不是主分支
  rules                                              列出解析后的拦截规则

接入与维护
  init     [--force]                                 在当前项目初始化
  install                                            重新生成项目的入口与钩子
  upgrade                                            升级项目到当前版本
  uninstall [--purge] [--dry-run]                    解除接入；--purge 连 .harness/ 一起删
  versions                                           列出已安装的版本
  prune    [--keep <v,...>] [--dry-run]              清理旧版本，默认只保留当前版本
  publish  [--version <v>]                           把当前代码装进版本目录
  version                                            打印版本
  key      <status|rotate> [--yes]                   证据密钥现状；rotate 由人执行，会作废全部已有记录

客户端与钩子入口
  githook  <pre-commit|commit-msg|reference-transaction>   由 git 钩子调用
  hook     --client <claude|codex|dsh>               由客户端钩子调用，读 stdin
  check    --kind <shell|write|read|search> ...      手工判定一次调用

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
  const outcome = await verify({ cwd, head, base: values.base, reuse: !values["no-reuse"], recordKey });
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
  const project = loadTrustedProject(cwd);
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
    return 0;
  } catch (error) {
    if (error instanceof MergeError) {
      process.stderr.write(`合并被拒绝(${error.code}): ${error.message}\n`);
      return error.code === "post_merge_failed" ? 3 : 1;
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
      process.stderr.write(
        `${result.reason}\n本地主分支只允许由 harness merge 更新，它会先核对证据与评审。\n` +
          `正确做法: 在任务分支提交后运行 harness merge --branch <任务分支>。\n`,
      );
      return 1;
    }
    return 0;
  }
  process.stderr.write(`未知的 git 钩子: ${name}\n`);
  return 2;
}

function formatDenialText(result) {
  return [`[harness] 已拦截: ${result.reason}`, result.detail ? `对象: ${result.detail}` : "", result.fix ? `正确做法: ${result.fix}` : "", `规则: ${result.rule}`]
    .filter(Boolean)
    .join("\n");
}

function cmdHook(argv) {
  const { values } = parseArgs({ args: argv, options: { client: { type: "string" } } });
  const adapter = ADAPTERS[values.client];
  if (!adapter) {
    process.stderr.write(`未知客户端: ${values.client ?? "(缺失)"}\n`);
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

function cmdCheck(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      kind: { type: "string" },
      command: { type: "string" },
      path: { type: "string" },
      content: { type: "string" },
      glob: { type: "string" },
    },
  });
  const project = loadTrustedProject(process.cwd());
  const resolved = resolvePolicy(project.policy);
  const call =
    values.kind === "shell"
      ? { kind: "shell", command: values.command ?? "" }
      : { kind: values.kind, path: values.path, content: values.content, glob: values.glob };
  const result = evaluateCall({ policy: resolved, root: project.root, call, context: {} });
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
        const result = publishVersion({ version: values.version ?? packageVersion() });
        print(JSON.stringify(result, null, 2));
        return 0;
      }
      case "init": {
        const { values } = parseArgs({ args: rest, options: { force: { type: "boolean", default: false } } });
        const result = initProject({ force: values.force });
        print(`已初始化 ${result.root}`);
        for (const item of result.written) print(`  新建 ${item}`);
        print(`  版本 ${result.version} 已安装到 ${versionDir(result.version)}`);
        print("下一步: 检查 .harness/policy.json 与 .harness/verify.json，连同 .harness/bin/harness 一起提交，然后运行 harness doctor");
        if (result.install.gitignore.shimIgnored) {
          process.stderr.write("[harness] 入口仍被 .gitignore 忽略，请手工放行 .harness/bin/harness，否则 Linked Worktree 里没有入口\n");
          return 1;
        }
        return 0;
      }
      case "install": {
        const result = installAll({ cwd: process.cwd() });
        print(`已安装版本 ${result.published.version}，入口 ${result.shim}`);
        for (const hook of result.hooks.hooks) print(`  git 钩子 ${hook.file}${hook.updated ? "(已接入)" : "(已存在)"}`);
        print(`  Claude PreToolUse: ${result.claude}`);
        print(`  Codex hooks: ${result.codex}`);
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
        print(`黄金任务 ${summary.passed}/${summary.total} 通过 (${(summary.passRate * 100).toFixed(0)}%)`);
        for (const item of results) {
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
      case "confirm":
        return cmdConfirm(rest);
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
