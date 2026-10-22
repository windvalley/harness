import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadTrustedProject } from "./lib/config.mjs";
import { git, repoRoot } from "./lib/git.mjs";
import { readLedger } from "./lib/store.mjs";
import { resolvePolicy, ruleStats } from "./policy/resolve.mjs";
import { evaluateCall } from "./policy/engine.mjs";
import { guard, renderDenial } from "./adapters/index.mjs";
import { claude } from "./adapters/claude.mjs";
import { codex } from "./adapters/codex.mjs";
import { dsh } from "./adapters/dsh.mjs";
import { verify } from "./verify/verify.mjs";
import { MergeError, mergeTask } from "./merge/merge.mjs";
import { reviewBranch } from "./review/review.mjs";
import { approveConfirm, confirmSummary, formatSummary } from "./confirm/confirm.mjs";
import { checkCommitMessage, checkStaged, guardReference } from "./githook.mjs";
import { answerEscalation, listEscalations, openEscalation, readEscalation, resumePlan } from "./escalate/escalate.mjs";
import { runGolden } from "./golden/golden.mjs";
import { computeMetrics, formatMetrics } from "./golden/metrics.mjs";
import { initProject, upgradeProject } from "./install/init.mjs";
import { installAll, publishVersion, verifyVersion, versionDir } from "./install/install.mjs";
import { doctor, formatDoctor } from "./install/doctor.mjs";
import { conformance, formatConformance } from "./conformance.mjs";
import { packageVersion } from "./install/managed.mjs";

const ADAPTERS = { claude, codex, dsh };

const USAGE = `harness <命令> [参数]

工程流程
  verify   [--head <ref>] [--base <ref>] [--branch <名称>] [--no-reuse]   对分支验证并写签名证据
  review   --branch <名称>                          独立评审
  confirm  --branch <名称> [--yes]                   查看门禁改动；--yes 记录人工确认
  merge    --branch <名称> [--dry-run]               受控合并到主分支

体检与度量
  doctor                                             安装与接入自检
  conformance                                        检查 L3 判据
  metrics  [--days <n>]                              按周度量
  golden                                             重放黄金任务
  rules                                              列出解析后的拦截规则

接入与维护
  init     [--force]                                 在当前项目初始化
  install                                            重新生成项目的入口与钩子
  upgrade                                            升级项目到当前版本
  publish  [--version <v>]                           把当前代码装进版本目录
  version                                            打印版本

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
      "no-reuse": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const cwd = process.cwd();
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
  const project = loadTrustedProject(cwd);
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
        print("下一步: 检查 .harness/policy.json 与 .harness/verify.json，提交后运行 harness doctor");
        return 0;
      }
      case "install": {
        const result = installAll({ cwd: process.cwd() });
        print(`已安装版本 ${result.published.version}，入口 ${result.shim}`);
        for (const hook of result.hooks.hooks) print(`  git 钩子 ${hook.file}${hook.updated ? "(已接入)" : "(已存在)"}`);
        print(`  Claude PreToolUse: ${result.claude}`);
        print(`  Codex hooks: ${result.codex}`);
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
        const { summary, results } = runGolden({ cwd: process.cwd() });
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
      default:
        process.stderr.write(`未知命令: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}
