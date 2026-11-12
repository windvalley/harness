import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendLedger, dataDir } from "../lib/store.mjs";
import { currentBranch, git, gitOk } from "../lib/git.mjs";
import { loadGateProject, mainBranch } from "../lib/config.mjs";
import { collectObligations } from "../verify/obligation.mjs";

const REQUIRED = ["situation", "attempted", "blocker", "options", "defaultAction"];
const ID_RE = /^esc-[0-9a-f]{8}$/;

function dir(root) {
  const target = join(dataDir(root), "escalations");
  mkdirSync(target, { recursive: true });
  return target;
}

function file(root, id) {
  if (!ID_RE.test(id)) throw new Error(`非法上报编号: ${id}`);
  return join(dir(root), `${id}.json`);
}

export function validateEscalation(input) {
  const missing = REQUIRED.filter(
    (key) => input?.[key] === undefined || input[key] === null || input[key] === "" || (Array.isArray(input[key]) && input[key].length === 0),
  );
  if (missing.length > 0) throw new Error(`上报缺少必填项: ${missing.join(", ")}`);
  if (!Array.isArray(input.options) || input.options.length < 2) {
    throw new Error("options 至少给出两个可选方案，让人只需选择而不是重新分析");
  }
  for (const option of input.options) {
    if (!option.id || !option.summary) throw new Error("每个 option 必须有 id 和 summary");
  }
  if (!input.options.some((option) => option.id === input.defaultAction)) {
    throw new Error("defaultAction 必须是 options 中的某个 id");
  }
  return input;
}

/** 上报只绑定本地实际版本，不采信调用方提供的 head 或义务快照。 */
function boundContext(root, input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("context 必须是对象");
  const { branch: requestedBranch, head: ignoredHead, obligations: ignoredObligations, ...rest } = input;
  const branch = requestedBranch ?? currentBranch(root);
  if (typeof branch !== "string") throw new Error("context.branch 必须是本地分支名");
  if (!branch) return { ...rest, head: gitOk(root, ["rev-parse", "--verify", "HEAD^{commit}"]) };
  let pending = [];
  let mainCommit = null;
  try {
    const project = loadGateProject(root, {});
    mainCommit = gitOk(root, ["rev-parse", "--verify", `${mainBranch(project)}^{commit}`]);
    // 验签失败的义务仍需留在待办快照里，但其 branchTip 不可信，不能拿来绑定上报版本。
    pending = collectObligations({ root, mainCommit, branch }).filter((item) => item.due && !item.closed);
  } catch {
    // 尚未接入门禁的仓库没有合并后义务，仍可为本地分支上报普通阻塞。
  }
  const local = git(root, ["show-ref", "--verify", "--hash", `refs/heads/${branch}`]);
  const newest = [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key)).at(-1);
  const unsafePending = pending.some((item) => item.problem);
  const head = local.status === 0
    ? local.stdout.trim()
    : unsafePending && mainCommit
      ? mainCommit
      : newest?.branchTip;
  if (!head) throw new Error(`找不到可绑定的本地分支或待验收义务: ${branch}`);
  return { ...rest, branch, head, ...(pending.length ? { obligations: pending.map((item) => item.key).sort() } : {}) };
}

export function openEscalation(root, input) {
  validateEscalation(input);
  const id = `esc-${randomBytes(4).toString("hex")}`;
  const record = {
    id,
    status: "open",
    openedAt: new Date().toISOString(),
    trigger: input.trigger ?? null,
    situation: input.situation,
    attempted: input.attempted,
    blocker: input.blocker,
    options: input.options,
    defaultAction: input.defaultAction,
    resumeHint: input.resumeHint ?? null,
    context: boundContext(root, input.context ?? {}),
  };
  writeFileSync(file(root, id), `${JSON.stringify(record, null, 2)}\n`);
  appendLedger(root, { event: "escalate.open", id, trigger: record.trigger });
  return record;
}

export function readEscalation(root, id) {
  const path = file(root, id);
  if (!existsSync(path)) throw new Error(`找不到上报 ${id}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function answerEscalation(root, id, { choice, note }) {
  const record = readEscalation(root, id);
  if (record.status !== "open") throw new Error(`上报 ${id} 已是 ${record.status} 状态`);
  if (!record.options.some((option) => option.id === choice)) {
    throw new Error(`choice 必须是 ${record.options.map((option) => option.id).join("/")} 之一`);
  }
  const updated = { ...record, status: "answered", answeredAt: new Date().toISOString(), answer: { choice, note: note ?? "" } };
  writeFileSync(file(root, id), `${JSON.stringify(updated, null, 2)}\n`);
  appendLedger(root, { event: "escalate.answer", id, choice });
  return updated;
}

/** 技术消除只记录实现方说明与证据引用，不产生人的答复，也不生成门禁证据。 */
export function resolveEscalation(root, id, { reason, evidence } = {}) {
  const record = readEscalation(root, id);
  if (record.status !== "open") throw new Error(`上报 ${id} 已是 ${record.status} 状态`);
  if (typeof reason !== "string" || !reason.trim()) throw new Error("技术消除必须提供非空 reason（原因）");
  if (typeof evidence !== "string" || !evidence.trim()) throw new Error("技术消除必须提供非空 evidence（证据引用）");
  const resolution = { reason: reason.trim(), evidence: evidence.trim() };
  const updated = { ...record, status: "resolved", resolvedAt: new Date().toISOString(), resolution };
  writeFileSync(file(root, id), `${JSON.stringify(updated, null, 2)}\n`);
  appendLedger(root, { event: "escalate.resolve", id, ...resolution });
  return updated;
}

export function listEscalations(root, status) {
  return readdirSync(dir(root))
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir(root), name), "utf8")))
    .filter((record) => !status || record.status === status)
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
}

export function resumePlan(root, id) {
  const record = readEscalation(root, id);
  if (record.status === "resolved") return {
    ready: true,
    id,
    status: "resolved",
    resolution: record.resolution,
    resumeHint: record.resumeHint,
    context: record.context,
  };
  if (record.status !== "answered") return { ready: false, reason: `上报 ${id} 还没有答复(状态 ${record.status})` };
  return {
    ready: true,
    id,
    decision: record.answer,
    chosen: record.options.find((option) => option.id === record.answer.choice),
    resumeHint: record.resumeHint,
    context: record.context,
  };
}
