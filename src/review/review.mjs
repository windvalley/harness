import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { acceptancePath, loadGateProject, mainBranch } from "../lib/config.mjs";
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

export const REVIEW_BACKENDS = ["auto", "claude", "codex", "command"];
const REVIEW_TIMEOUT_MS = 20 * 60 * 1000;

export function commandExists(bin) {
  return run("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", bin]).status === 0;
}

/**
 * 选择评审后端。auto 按 claude、codex 的顺序取本机第一个可用的；
 * 其他编码工具通过 command 后端接入，只要求“stdin 读提示、输出符合结构的 JSON”。
 */
export function resolveBackend(config = {}, { has = commandExists, overrideBin = process.env.HARNESS_REVIEWER_BIN } = {}) {
  const backend = config.backend ?? "auto";
  if (!REVIEW_BACKENDS.includes(backend)) {
    throw new Error(`未知的评审后端 ${backend}，可选 ${REVIEW_BACKENDS.join("、")}`);
  }
  if (backend === "command") {
    if (!Array.isArray(config.command) || config.command.length === 0) {
      throw new Error("review.backend 为 command 时必须在 review.command 里给出命令数组");
    }
    return { name: "command", argv: config.command };
  }
  // 自测用假评审进程替换 claude，只作用于 claude 后端。
  if (overrideBin && backend !== "codex") return { name: "claude", bin: overrideBin };
  if (backend === "claude" || backend === "codex") return { name: backend, bin: backend };
  for (const name of ["claude", "codex"]) {
    if (has(name)) return { name, bin: name };
  }
  throw new Error(
    "找不到评审后端：本机既没有 claude 也没有 codex。" +
      "在 .harness/config.json 里把 review.backend 设为 command，并在 review.command 里给出评审命令，约定见 README",
  );
}

/**
 * OpenAI 的结构化输出要求严格模式：每个对象都关闭额外字段，所有字段都列为必填。
 * 原本可选的字段改成可空，输出后再去掉空值，与 Claude 的结果对齐。
 */
export function strictSchema(schema) {
  if (schema.type === "object") {
    const required = new Set(schema.required ?? []);
    const properties = {};
    for (const [name, value] of Object.entries(schema.properties ?? {})) {
      const inner = strictSchema(value);
      properties[name] = required.has(name) ? inner : nullable(inner);
    }
    return { ...schema, properties, required: Object.keys(properties), additionalProperties: false };
  }
  if (schema.type === "array") return { ...schema, items: strictSchema(schema.items) };
  return { ...schema };
}

function nullable(schema) {
  const next = { ...schema, type: [schema.type, "null"] };
  if (Array.isArray(schema.enum)) next.enum = [...schema.enum, null];
  return next;
}

function dropNulls(value) {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)]));
  }
  return value;
}

/** 从命令输出里取出 JSON：整段是 JSON 最好，其次取代码块，最后取首尾花括号之间的内容。 */
export function extractJson(text) {
  const trimmed = text.trim();
  const attempts = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) attempts.push(fenced[1].trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) attempts.push(trimmed.slice(start, end + 1));
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 换下一种取法
    }
  }
  throw new Error(`评审输出里找不到 JSON: ${trimmed.slice(0, 200)}`);
}

function ensureOk(result, label) {
  if (result.error?.code === "ENOENT") throw new Error(`找不到评审命令 ${label}`);
  if (result.status !== 0) throw new Error(`评审进程失败(${result.status}): ${(result.stderr || result.stdout).trim().slice(-400)}`);
}

function runClaude({ cwd, prompt, config, bin }) {
  const result = run(bin, reviewerArgs({ model: config.model ?? "sonnet", maxBudgetUsd: config.maxBudgetUsd ?? 2 }, userSettingsFile()), {
    cwd,
    input: prompt,
    timeout: REVIEW_TIMEOUT_MS,
  });
  ensureOk(result, bin);
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`评审进程输出不是 JSON: ${result.stdout.slice(0, 200)}`);
  }
  if (payload.is_error) throw new Error(`评审进程报错: ${payload.result ?? payload.subtype}`);
  return { structured: payload.structured_output, costUsd: payload.total_cost_usd ?? null };
}

// codex 与通用命令都在空的临时目录里运行：评审只依据给出的材料，不读项目文件，也不加载项目里的钩子与规则。
function withScratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), "harness-review-"));
  try {
    writeFileSync(join(dir, "schema.json"), JSON.stringify(strictSchema(REVIEW_SCHEMA), null, 2));
    writeFileSync(join(dir, "system.md"), SYSTEM_PROMPT);
    return fn({ dir, schema: join(dir, "schema.json"), system: join(dir, "system.md"), output: join(dir, "output.json") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCodex({ prompt, config, bin }) {
  return withScratch(({ dir, schema, output }) => {
    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--cd",
      dir,
      "--color",
      "never",
      "--output-schema",
      schema,
      "--output-last-message",
      output,
      ...(config.codexModel ? ["--model", config.codexModel] : []),
      "-",
    ];
    const result = run(bin, args, { cwd: dir, input: `${SYSTEM_PROMPT}\n\n${prompt}`, timeout: REVIEW_TIMEOUT_MS });
    ensureOk(result, bin);
    if (!existsSync(output)) throw new Error("codex 没有写出评审结果");
    return { structured: dropNulls(extractJson(readFileSync(output, "utf8"))), costUsd: null };
  });
}

function runCommand({ prompt, argv }) {
  return withScratch((files) => {
    const usesOutput = argv.some((arg) => arg.includes("{output}"));
    const expanded = argv.map((arg) =>
      arg.replaceAll("{schema}", files.schema).replaceAll("{system}", files.system).replaceAll("{output}", files.output),
    );
    const [cmd, ...args] = expanded;
    const result = run(cmd, args, { cwd: files.dir, input: `${SYSTEM_PROMPT}\n\n${prompt}`, timeout: REVIEW_TIMEOUT_MS });
    ensureOk(result, cmd);
    const text = usesOutput && existsSync(files.output) ? readFileSync(files.output, "utf8") : result.stdout;
    const payload = extractJson(text);
    return { structured: dropNulls(payload.structured_output ?? payload), costUsd: payload.total_cost_usd ?? null };
  });
}

export function runReviewer({ cwd, prompt, config = {} }) {
  const backend = resolveBackend(config);
  const outcome =
    backend.name === "claude"
      ? runClaude({ cwd, prompt, config, bin: backend.bin })
      : backend.name === "codex"
        ? runCodex({ prompt, config, bin: backend.bin })
        : runCommand({ prompt, argv: backend.argv });
  return { ...outcome, structured: parseVerdict(outcome.structured), backend: backend.name };
}

export function parseVerdict(structured) {
  if (!structured || typeof structured !== "object") throw new Error("评审输出缺少结构化结果");
  if (structured.verdict !== "approve" && structured.verdict !== "reject") throw new Error("评审输出 verdict 非法");
  if (!Array.isArray(structured.findings)) throw new Error("评审输出 findings 非法");
  return structured;
}

/** 按顶层目录把改动分组，给出每组的大小，便于把一次大改拆成几次可评审的提交。 */
export function splitSuggestion(root, baseCommit, branchCommit, totalChars, maxChars = MAX_DIFF_CHARS) {
  const paths = gitOk(root, ["diff", "--name-only", "--no-renames", baseCommit, branchCommit]).split("\n").filter(Boolean);
  const groups = new Map();
  for (const path of paths) {
    const top = path.includes("/") ? path.split("/")[0] : "(根目录)";
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top).push(path);
  }
  const rows = [...groups.entries()]
    .map(([top, files]) => {
      const size = files.reduce(
        (sum, file) => sum + gitOk(root, ["diff", "--no-color", "-U8", baseCommit, branchCommit, "--", file]).length,
        0,
      );
      return { top, files: files.length, size };
    })
    .sort((a, b) => b.size - a.size);
  const lines = rows.map((row) => `  ${row.top}: ${row.files} 个文件，约 ${row.size} 字符`);
  const need = Math.ceil(totalChars / maxChars);
  lines.push(`  当前共 ${totalChars} 字符，至少拆成 ${need} 次提交，优先按上面的顺序分组`);
  return lines.join("\n");
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

/**
 * 取评审用的 diff。
 * 纯删除的改动（例如退役一整套旧门禁代码）不该被整段旧内容挤爆上限：
 * 删除的文件只给出路径与行数，评审照样能判断“删对了哪些、还剩下哪些引用”。
 */
export function reviewDiff(root, baseCommit, branchCommit, maxChars = MAX_DIFF_CHARS) {
  const full = gitOk(root, ["diff", "--no-color", "-U8", baseCommit, branchCommit]);
  if (full.length <= maxChars) return { text: full, collapsed: [] };

  const deleted = gitOk(root, ["diff", "--name-status", "--diff-filter=D", "--no-renames", baseCommit, branchCommit])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t").at(-1));
  if (deleted.length === 0) return { text: full, collapsed: [] };

  const stats = new Map(
    gitOk(root, ["diff", "--numstat", "--no-renames", baseCommit, branchCommit])
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [added, removed, path] = line.split("\t");
        return [path, { added: Number(added) || 0, removed: Number(removed) || 0 }];
      }),
  );
  const withoutDeletes = gitOk(root, ["diff", "--no-color", "-U8", baseCommit, branchCommit, "--", ...deleted.map((path) => `:(exclude)${path}`)]);
  const summary = deleted.map((path) => {
    const stat = stats.get(path) ?? { added: 0, removed: 0 };
    return `- 删除 ${path}（原 ${stat.removed} 行）`;
  });
  return {
    text: [`## 已删除的文件（只列路径，不展开原内容）`, ...summary, "", withoutDeletes].join("\n"),
    collapsed: deleted,
  };
}

export async function reviewBranch({ cwd, branch, log = console.error, reviewer = runReviewer }) {
  const project = loadGateProject(cwd, { branch });
  const root = project.root;
  const mainRef = mainBranch(project);
  const config = project.config.review ?? {};

  const branchCommit = gitOk(root, ["rev-parse", "--verify", `${branch}^{commit}`]);
  const baseCommit = gitOk(root, ["merge-base", mainRef, branchCommit]);
  const { text: diffText, collapsed } = reviewDiff(root, baseCommit, branchCommit);
  if (diffText.length > MAX_DIFF_CHARS) {
    // 不静默截断，也不只说“请拆小”：直接按目录给出可执行的分组建议。
    throw new Error(
      `变更 diff 有 ${diffText.length} 字符，超过独立评审上限 ${MAX_DIFF_CHARS}，不能只评审一部分就放行。\n` +
        `按目录拆分建议（每组单独一个分支验收）：\n${splitSuggestion(root, baseCommit, branchCommit, diffText.length)}`,
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
    `[review] 评审 ${branch}，diff ${diffText.length} 字符` +
      (collapsed.length ? `（${collapsed.length} 个删除的文件只列路径）` : "") +
      `，${acceptance ? `验收清单来自${acceptance.source === "main" ? "主分支" : "任务分支(未确认)"}` : "无验收清单"}`,
  );
  const prompt = buildPrompt({ acceptance, evidence: evidenceText, diff: diffText, branch });
  const { structured, costUsd, backend } = reviewer({ cwd: root, prompt, config });

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
    backend: backend ?? null,
    // 记录哪些删除的文件只给了路径，事后能看出这次评审没有读到这些文件的原内容。
    collapsedDeletions: collapsed.length ? collapsed : undefined,
    costUsd,
    reviewedAt: new Date().toISOString(),
  });
  appendLedger(root, { event: "review", branch, tree: record.reviewedCommit, verdict, blocking: blocking.length, backend, costUsd });
  return record;
}

export { changedPaths };
