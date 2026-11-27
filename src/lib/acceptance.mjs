import { createHash } from "node:crypto";

const HEADING = /^##\s+(.+?)\s*$/;
const POST_MERGE = /^(?:合并后验收|post-merge(?:\s+acceptance)?)$/i;
// 内容行不含标题：标题措辞变化说明不了需求变没变，单独用“标题变化”一句带过。
const CONTENT_HEADING = /^#{1,6}\s/;
const UNCATEGORIZED = "(未分类)";

/** 旧清单默认全部属于合并前；只有显式命名同级章节的内容才后置。 */
export function splitAcceptance(text) {
  const preMerge = [];
  const postMerge = [];
  let target = preMerge;
  const source = String(text ?? "").replace(/<!--[\s\S]*?-->/g, "");
  for (const line of source.split("\n")) {
    const heading = line.match(HEADING);
    if (heading) {
      target = POST_MERGE.test(heading[1].trim()) ? postMerge : preMerge;
      if (target === postMerge) continue;
    }
    target.push(line);
  }
  return {
    preMergeText: preMerge.join("\n").trim(),
    postMergeText: postMerge.join("\n").trim(),
  };
}

/** 按二级标题把清单分段：段名就是章节，没有章节的内容归到“未分类”。 */
function sections(text) {
  const out = new Map();
  let current = UNCATEGORIZED;
  const push = (line) => {
    if (!out.has(current)) out.set(current, []);
    out.get(current).push(line);
  };
  for (const line of String(text ?? "").replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const heading = line.match(HEADING);
    if (heading) {
      current = heading[1].trim();
      continue;
    }
    push(line);
  }
  return out;
}

const hash = (line) => createHash("sha256").update(line).digest("hex").slice(0, 12);

function contentDigests(lines) {
  return (lines ?? [])
    .map((line) => line.trim())
    .filter((line) => line !== "" && !CONTENT_HEADING.test(line))
    .map(hash);
}

function sectionDigest(text) {
  const out = {};
  for (const [name, lines] of sections(text)) {
    const hashes = contentDigests(lines);
    if (hashes.length > 0) out[name] = hashes;
  }
  return out;
}

/**
 * 授权时保存的清单摘要：按合并前与合并后验收两段，各自再按章节记下每条内容行的哈希。
 * 只存哈希不存原文；带章节是因为同一条从「应该发生」移到「绝对不能发生」时，需求已经反转，
 * 不分章节会把这种改写报告成“排版变化”。
 */
export function acceptanceDigest(text) {
  const { preMergeText, postMergeText } = splitAcceptance(text);
  // 合并后验收章节本身就按后置判断，它下面的内容不再细分章节，统一记在这个名字下。
  const postMerge = sectionDigest(postMergeText);
  const named = postMerge[UNCATEGORIZED] ? { 合并后验收: postMerge[UNCATEGORIZED] } : postMerge;
  return { preMerge: sectionDigest(preMergeText), postMerge: named };
}

function diffCounts(before, after) {
  const remaining = new Map();
  for (const hashValue of before) remaining.set(hashValue, (remaining.get(hashValue) ?? 0) + 1);
  let added = 0;
  for (const hashValue of after) {
    const count = remaining.get(hashValue) ?? 0;
    if (count > 0) remaining.set(hashValue, count - 1);
    else added += 1;
  }
  let removed = 0;
  for (const count of remaining.values()) removed += count;
  return { added, removed };
}

function unionKeys(...maps) {
  return [...new Set(maps.flatMap((map) => Object.keys(map ?? {})))];
}

/** 一段（合并前或合并后）里各章节的增删。 */
function describePart(before, after) {
  const parts = [];
  for (const name of unionKeys(before, after)) {
    const { added, removed } = diffCounts(before?.[name] ?? [], after?.[name] ?? []);
    if (added === 0 && removed === 0) continue;
    parts.push({ name, changes: [added > 0 ? `新增 ${added} 条` : null, removed > 0 ? `删除 ${removed} 条` : null].filter(Boolean).join("、") });
  }
  return parts;
}

/** 摘要是不是带章节的新格式；旧记录是纯哈希数组，没有章节信息。 */
export function hasSectionedDigest(digest) {
  const isMap = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return isMap(digest?.preMerge) || isMap(digest?.postMerge);
}

/**
 * 授权失效时说清清单改了什么：哪个章节增删几条。
 * 摘要相同但全文哈希不同（空行、标题措辞）时如实说明没有内容行变化，避免只报“清单改过”又给不出可核对的差异。
 * 旧记录的摘要没有章节，调用方应先用原文还原；这里返回 null 表示分不出章节级差异。
 * 只报章节与条数，不报条目原文：摘要里只有哈希。
 */
export function describeAcceptanceChange(before, after) {
  if (!before || !after) return null;
  if (!hasSectionedDigest(before) || !hasSectionedDigest(after)) return null;
  const parts = [];
  for (const [key, label] of [["preMerge", "合并前"], ["postMerge", "合并后验收"]]) {
    for (const { name, changes } of describePart(before[key], after[key])) {
      // 合并后验收整段就是一项义务：不再重复章节名，避免“合并后验收「合并后验收 …」”。
      parts.push(key === "postMerge" ? `${label} ${changes}` : `${label}「${name} ${changes}」`);
    }
  }
  if (parts.length === 0) return "没有内容行变化（只有空行、标题或排版变化）";
  return parts.join("；");
}


export function evidenceDeclarations(text) {
  const declarations = new Map();
  for (const match of String(text ?? "").matchAll(/<!--\s*harness:evidence\s+([^>]+)-->/g)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((item) => [item[1], item[2]]));
    if (attrs.id) declarations.set(attrs.id, attrs.phase ?? "pre-merge");
  }
  return declarations;
}

export function describeEvidenceChange(beforeText, afterText) {
  const before = evidenceDeclarations(beforeText);
  const after = evidenceDeclarations(afterText);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, phase] of after) {
    if (!before.has(id)) added.push(`${id}(${phase})`);
    else if (before.get(id) !== phase) changed.push(`${id} 从 ${before.get(id)} 改为 ${phase}`);
  }
  for (const [id, phase] of before) if (!after.has(id)) removed.push(`${id}(${phase})`);
  const parts = [];
  if (added.length) parts.push(`新增必需证据 ${added.join("、")}`);
  if (removed.length) parts.push(`删除必需证据 ${removed.join("、")}`);
  if (changed.length) parts.push(`调整必需证据阶段 ${changed.join("、")}`);
  return parts.join("；") || null;
}

/** 一段文字里每个二级章节的内容行原文（去掉注释、空行与标题），供修订摘要逐条列出。 */
function sectionLines(text) {
  const out = new Map();
  for (const [name, lines] of sections(text)) {
    const content = lines.map((line) => line.trim()).filter((line) => line !== "" && !CONTENT_HEADING.test(line));
    if (content.length > 0) out.set(name, content);
  }
  return out;
}

/**
 * 授权版到当前版按章节列出删除与新增的条目原文；同一行在章节内移动位置不算变化。
 * skip 里的章节不参与比较（例如实施方案里 Agent 自己写的修订记录）。
 */
export function sectionLineChanges(beforeText, afterText, { skip = [] } = {}) {
  const before = sectionLines(beforeText);
  const after = sectionLines(afterText);
  const names = [...new Set([...before.keys(), ...after.keys()])].filter((name) => !skip.includes(name));
  const changes = [];
  for (const name of names) {
    const remaining = new Map();
    for (const line of before.get(name) ?? []) remaining.set(line, (remaining.get(line) ?? 0) + 1);
    const added = [];
    for (const line of after.get(name) ?? []) {
      const count = remaining.get(line) ?? 0;
      if (count > 0) remaining.set(line, count - 1);
      else added.push(line);
    }
    const removed = (before.get(name) ?? []).filter((line) => {
      const count = remaining.get(line) ?? 0;
      if (count === 0) return false;
      remaining.set(line, count - 1);
      return true;
    });
    if (added.length > 0 || removed.length > 0) changes.push({ section: name, removed, added });
  }
  return changes;
}

/** 某个二级章节的正文（去掉注释），没有该章节时返回 null。 */
export function sectionText(text, name) {
  const lines = sections(text).get(name);
  if (!lines) return null;
  return lines.join("\n").trim();
}
