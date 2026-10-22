import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendLedger, dataDir } from "../lib/store.mjs";

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
    context: input.context ?? {},
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

export function listEscalations(root, status) {
  return readdirSync(dir(root))
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir(root), name), "utf8")))
    .filter((record) => !status || record.status === status)
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
}

export function resumePlan(root, id) {
  const record = readEscalation(root, id);
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
