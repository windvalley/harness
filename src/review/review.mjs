import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acceptancePath, loadTrustedProject, mainBranch } from "../lib/config.mjs";
import { changedPaths, gitOk, run, showBlob } from "../lib/git.mjs";
import { appendLedger, readRecord, writeRecord } from "../lib/store.mjs";

export const REVIEW_KIND = "review";
const MAX_DIFF_CHARS = 180_000;

export const REVIEW_SCHEMA = {
  type: "object",
  required: ["verdict", "requirementFit", "engineeringQuality", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "reject"] },
    requirementFit: {
      type: "object",
      required: ["rating", "evidence"],
      properties: {
        rating: { type: "string", enum: ["met", "partial", "unmet", "unknown"] },
        evidence: { type: "string" },
      },
    },
    engineeringQuality: {
      type: "object",
      required: ["rating", "evidence"],
      properties: { rating: { type: "string", enum: ["good", "acceptable", "poor"] }, evidence: { type: "string" } },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "file", "summary", "scenario"],
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          dimension: { type: "string", enum: ["requirement", "engineering"] },
          file: { type: "string" },
          line: { type: "integer" },
          summary: { type: "string" },
          scenario: { type: "string" },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `你是独立代码评审者，没有参与实现，也不能修改任何文件。
只依据给出的材料评审: 验收清单、变更 diff、验证证据摘要。评审分两个独立维度:
1. 需求符合度: 变更是否满足验收清单中的每一条，缺哪一条就指出哪一条，不要因为代码“看起来合理”而放过。
2. 工程质量: 正确性、边界与失败路径、安全(注入、越权、敏感信息)、与既有约定的一致性、测试是否真实覆盖行为。
规则:
- 每条发现必须给出文件、位置和能让别人复现的具体场景，没有场景的猜测不要报。
- 没有验收清单时，需求符合度评级写 unknown 并在 evidence 里说明缺什么，不得凭空编造需求。
- 提供了验收清单时，必须逐条核对，并在 requirementFit.evidence 里点名哪些条目已满足、哪些未满足。
- 只有存在 critical 或 high 级别且有具体场景的发现时 verdict 才能是 reject。
- 风格偏好、命名偏好不构成发现。`;

export function userSettingsFile(home = homedir()) {
  const file = join(home, ".claude", "settings.json");
  return existsSync(file) ? file : "";
}

export function reviewerArgs({ model, maxBudgetUsd }, settingsFile = "") {
  return [
    "-p",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--setting-sources",
    "",
    ...(settingsFile ? ["--settings", settingsFile] : []),
    "--tools",
    "",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(REVIEW_SCHEMA),
    "--system-prompt",
    SYSTEM_PROMPT,
    "--model",
    model,
    "--max-budget-usd",
    String(maxBudgetUsd),
  ];
}

export function runReviewer({ cwd, prompt, model, maxBudgetUsd, reviewerBin }) {
  const result = run(reviewerBin || process.env.HARNESS_REVIEWER_BIN || "claude", reviewerArgs({ model, maxBudgetUsd }, userSettingsFile()), {
    cwd,
    input: prompt,
    timeout: 20 * 60 * 1000,
  });
  if (result.status !== 0) throw new Error(`评审进程失败(${result.status}): ${result.stderr.trim().slice(-400)}`);
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`评审进程输出不是 JSON: ${result.stdout.slice(0, 200)}`);
  }
  if (payload.is_error) throw new Error(`评审进程报错: ${payload.result ?? payload.subtype}`);
  return { structured: parseVerdict(payload.structured_output), costUsd: payload.total_cost_usd ?? null };
}

export function parseVerdict(structured) {
  if (!structured || typeof structured !== "object") throw new Error("评审输出缺少 structured_output");
  if (structured.verdict !== "approve" && structured.verdict !== "reject") throw new Error("评审输出 verdict 非法");
  if (!Array.isArray(structured.findings)) throw new Error("评审输出 findings 非法");
  return structured;
}

export function blockingFindings(findings, blockSeverities) {
  return findings.filter((item) => blockSeverities.includes(item.severity));
}

/** 验收清单优先取分支自带，其次取主分支；两种来源都记录，供评审与汇报区分。 */
export function readAcceptance({ project, root, branch, mainRef }) {
  const rel = acceptancePath(project, branch);
  const fromBranch = showBlob(root, branch, rel);
  if (fromBranch !== null) return { path: rel, text: fromBranch, source: "branch" };
  const fromMain = showBlob(root, mainRef, rel);
  if (fromMain !== null) return { path: rel, text: fromMain, source: "main" };
  return null;
}

export function buildPrompt({ acceptance, evidence, diff, branch }) {
  return [
    `# 评审对象: ${branch}`,
    "## 验收清单",
    acceptance
      ? `来源: ${acceptance.source === "main" ? "主分支已确认的清单" : "任务分支自带的清单，尚未经人工确认"}\n${acceptance.text}`
      : "(未提供验收清单，需求符合度只能记为 unknown)",
    "## 验证证据摘要",
    evidence,
    "## 变更 diff",
    diff,
  ].join("\n\n");
}

export async function reviewBranch({ cwd, branch, log = console.error, reviewer = runReviewer }) {
  const project = loadTrustedProject(cwd);
  const root = project.root;
  const mainRef = mainBranch(project);
  const config = project.config.review ?? {};

  const branchCommit = gitOk(root, ["rev-parse", "--verify", `${branch}^{commit}`]);
  const baseCommit = gitOk(root, ["merge-base", mainRef, branchCommit]);
  const diffText = gitOk(root, ["diff", "--no-color", "-U8", baseCommit, branchCommit]);
  if (diffText.length > MAX_DIFF_CHARS) {
    throw new Error(
      `变更 diff 有 ${diffText.length} 字符，超过独立评审上限 ${MAX_DIFF_CHARS}，不能只评审一部分就放行。请把任务拆成更小的分支`,
    );
  }

  const evidence = readRecord(root, "evidence", branchCommit);
  if (!evidence.ok || evidence.record.status !== "passed") {
    throw new Error(`评审前必须先有通过的验证证据(${evidence.reason ?? evidence.record.status})，先运行 harness verify`);
  }

  const acceptance = readAcceptance({ project, root, branch, mainRef });
  const evidenceText = [
    `状态: ${evidence.record.status}`,
    `变更文件数: ${evidence.record.changedCount}`,
    ...(evidence.record.checks ?? []).map((check) => `- ${check.id}: exit=${check.exit}${check.reused ? " (复用)" : ""} ${check.cmd}`),
    ...(evidence.record.notExecuted ?? []).map((item) => `- 未执行 ${item.id}: ${item.reason}`),
    ...(evidence.record.advisory ?? []).map((item) => `- 咨询项 ${item.id}: ${item.hint}`),
  ].join("\n");

  log(
    `[review] 评审 ${branch}，diff ${diffText.length} 字符，` +
      (acceptance ? `验收清单来自${acceptance.source === "main" ? "主分支" : "任务分支(未确认)"}` : "无验收清单"),
  );
  const prompt = buildPrompt({ acceptance, evidence: evidenceText, diff: diffText, branch });
  const { structured, costUsd } = reviewer({
    cwd: root,
    prompt,
    model: config.model ?? "sonnet",
    maxBudgetUsd: config.maxBudgetUsd ?? 2,
  });

  const blockSeverities = config.blockSeverities ?? ["high", "critical"];
  const blocking = blockingFindings(structured.findings, blockSeverities);
  let verdict = structured.verdict;
  if (blocking.length > 0) verdict = "reject";
  if (blocking.length === 0 && verdict === "reject") verdict = "approve";
  // 有清单却评 unknown，说明评审没真正核对，不能放行；没有清单时 unknown 是如实记录，不阻断。
  if (acceptance && structured.requirementFit?.rating === "unknown") verdict = "reject";
  if (structured.requirementFit?.rating === "unmet") verdict = "reject";

  const record = writeRecord(root, REVIEW_KIND, branchCommit, {
    verdict,
    reviewedBranch: branch,
    reviewedCommit: branchCommit,
    baseCommit,
    requirementFit: structured.requirementFit,
    engineeringQuality: structured.engineeringQuality,
    findings: structured.findings,
    blocking,
    acceptanceSource: acceptance?.source ?? null,
    hadAcceptance: Boolean(acceptance),
    costUsd,
    reviewedAt: new Date().toISOString(),
  });
  appendLedger(root, { event: "review", branch, tree: record.reviewedCommit, verdict, blocking: blocking.length, costUsd });
  return record;
}

export { changedPaths };
