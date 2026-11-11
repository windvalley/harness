import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PITFALL_FILE = ".harness/pitfalls.md";
export const FLAG_HITS = 3;
export const MAX_HITS = 5;
export const MAX_ENTRIES = 40;
export const MAX_BYTES = 8192;
const MAX_LEN = { signature: 60, symptom: 100, fix: 160 };
const LABEL = { signature: "signature", symptom: "现象", fix: "做法" };
// 只认冲突块的起止行：单独的 ======= 也是 Markdown 标题下划线，不能当冲突。
const CONFLICT = /^(<{7}|>{7})( |$)/m;

const HEADER = `# 项目坑位记录

踩到本项目的环境类问题（构建、路径、工具版本、平台行为）并解决后，运行 \`harness pitfall add\` 记录。
通用工程知识不记。
同一个坑再次遇到会累加命中次数，满 ${FLAG_HITS} 次的条目由人决定是否固化为检查或规则。
Agent 不自行改门禁文件。
本文件由命令维护，并行分支合并出现冲突时保留双方的条目与命中记录。
`;

const keyOf = (signature) => signature.replace(/\s+/g, " ").trim().toLowerCase();
const today = () => new Date().toLocaleDateString("sv-SE");
const bytes = (text) => Buffer.byteLength(text);

export function parsePitfalls(text) {
  const lines = String(text).split("\n");
  const first = lines.findIndex((line) => line.startsWith("## "));
  const preamble = (first < 0 ? lines : lines.slice(0, first)).join("\n").replace(/\s+$/, "");
  const raw = [];
  let current = null;
  for (const line of first < 0 ? [] : lines.slice(first)) {
    if (line.startsWith("## ")) {
      current = { signature: line.slice(3).trim(), symptom: "", fix: "", hits: [], extra: [] };
      raw.push(current);
      continue;
    }
    const field = line.match(/^- (现象|做法):\s*(.*)$/);
    const hit = line.match(/^- 命中:\s*(\S+)(?:\s+(.*))?$/);
    if (field) current[field[1] === "现象" ? "symptom" : "fix"] = field[2].trim();
    else if (hit) current.hits.push({ date: hit[1], branch: (hit[2] ?? "").trim() });
    else if (line.trim()) current.extra.push(line);
  }
  // 并行分支各自新增同一个坑，合并后会出现同名条目：合成一条，命中记录取并集。
  const merged = new Map();
  for (const entry of raw) {
    const key = keyOf(entry.signature);
    const known = merged.get(key);
    if (!known) merged.set(key, entry);
    else {
      known.symptom ||= entry.symptom;
      known.fix ||= entry.fix;
      known.hits.push(...entry.hits);
      known.extra.push(...entry.extra.filter((line) => !known.extra.includes(line)));
    }
  }
  const entries = [...merged.values()];
  for (const entry of entries) {
    entry.hits.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    entry.hits = entry.hits.slice(-MAX_HITS);
  }
  return { preamble, entries };
}

function render({ preamble, entries }) {
  const blocks = entries.map((entry) =>
    [
      `## ${entry.signature}`,
      `- 现象: ${entry.symptom}`,
      `- 做法: ${entry.fix}`,
      ...entry.hits.map((hit) => `- 命中: ${hit.date}${hit.branch ? ` ${hit.branch}` : ""}`),
      ...entry.extra,
    ].join("\n"),
  );
  return `${[preamble, ...blocks].join("\n\n")}\n`;
}

function load(root) {
  const file = join(root, PITFALL_FILE);
  const text = existsSync(file) ? readFileSync(file, "utf8") : HEADER;
  if (CONFLICT.test(text)) throw new Error(`${PITFALL_FILE} 里还有未解决的合并冲突，先解决冲突（保留双方的条目与命中记录）再记录`);
  return parsePitfalls(text);
}

function field(name, value, { required }) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`缺少${name === "signature" ? " --signature" : `${LABEL[name]}（--${name}）`}`);
    return undefined;
  }
  const text = String(value).trim();
  if (!text) throw new Error(`${LABEL[name]}不能为空`);
  if (/[\r\n]/.test(text)) throw new Error(`${LABEL[name]}必须是单行文本`);
  if ([...text].length > MAX_LEN[name]) throw new Error(`${LABEL[name]}过长（${[...text].length} 字符，上限 ${MAX_LEN[name]}）`);
  return text;
}

const lastHit = (entry) => entry.hits.at(-1)?.date ?? "";
const flagged = (entry) => entry.hits.length >= FLAG_HITS;

/**
 * 记一次命中：同名条目累加命中，否则新增。超过条目数或字节上限时淘汰最久未命中、命中最少的条目，已建议固化的不淘汰。
 * 内容全部算好之后才写文件，失败时文件保持原样。
 */
export function addPitfall(root, { signature, symptom, fix, branch = "", date = today() }) {
  const sig = field("signature", signature, { required: true });
  const doc = load(root);
  const key = keyOf(sig);
  let target = doc.entries.find((entry) => keyOf(entry.signature) === key);
  const created = !target;
  const newSymptom = field("symptom", symptom, { required: created });
  const newFix = field("fix", fix, { required: created });
  if (created) {
    target = { signature: sig, symptom: newSymptom, fix: newFix, hits: [], extra: [] };
    doc.entries.push(target);
  } else {
    if (newSymptom) target.symptom = newSymptom;
    if (newFix) target.fix = newFix;
  }
  target.hits.push({ date, branch: branch.replace(/\s+/g, "") });
  target.hits = target.hits.slice(-MAX_HITS);

  const evicted = [];
  while (doc.entries.length > MAX_ENTRIES || bytes(render(doc)) > MAX_BYTES) {
    const candidates = doc.entries.filter((entry) => entry !== target && !flagged(entry));
    if (candidates.length === 0) {
      throw new Error(`坑位记录已满（上限 ${MAX_ENTRIES} 条或 ${MAX_BYTES} 字节），其余条目都已建议固化：先由人固化或清理，再记录新的坑`);
    }
    const order = (entry) => [lastHit(entry), entry.hits.length, doc.entries.indexOf(entry)];
    const oldest = candidates.reduce((best, entry) => {
      const [a, b] = [order(entry), order(best)];
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? entry : best;
      return best;
    });
    doc.entries.splice(doc.entries.indexOf(oldest), 1);
    evicted.push(oldest.signature);
  }

  const file = join(root, PITFALL_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, render(doc));
  return { created, signature: target.signature, hits: target.hits.length, flagged: flagged(target), evicted };
}

export function listPitfalls(root) {
  const file = join(root, PITFALL_FILE);
  if (!existsSync(file)) return [];
  return parsePitfalls(readFileSync(file, "utf8")).entries.map((entry) => ({ ...entry, flagged: flagged(entry) }));
}

export function formatPitfalls(entries) {
  if (entries.length === 0) return "没有坑位记录";
  return entries
    .map((entry) => `${entry.flagged ? "[建议固化] " : ""}${entry.signature}（命中 ${entry.hits.length} 次，最近 ${lastHit(entry) || "-"}）\n  现象: ${entry.symptom}\n  做法: ${entry.fix}`)
    .join("\n");
}

/** 首次接入或升级时补一个只有说明的空文件；已有的文件不动。 */
export function ensurePitfallsFile(root) {
  const file = join(root, PITFALL_FILE);
  if (existsSync(file)) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, HEADER);
  return true;
}

/** 供 status 使用：文件内容读不到时返回 null。 */
export function pitfallSummary(text) {
  if (text === null || text === undefined || CONFLICT.test(text)) return null;
  const { entries } = parsePitfalls(text);
  return { total: entries.length, flagged: entries.filter(flagged).map((entry) => entry.signature) };
}

/** 供 conformance 使用：只报会让命令无法工作或条目残缺的问题。 */
export function pitfallProblems(text) {
  if (CONFLICT.test(text)) return [`坑位记录 ${PITFALL_FILE} 有未解决的合并冲突`];
  return parsePitfalls(text).entries.flatMap((entry) => [
    ...(entry.symptom ? [] : [`坑位记录的条目 ${entry.signature} 缺少现象`]),
    ...(entry.fix ? [] : [`坑位记录的条目 ${entry.signature} 缺少做法`]),
  ]);
}
