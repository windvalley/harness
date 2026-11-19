import { createHash } from "node:crypto";

const HEADING = /^##\s+(.+?)\s*$/;
const POST_MERGE = /^(?:合并后验收|post-merge(?:\s+acceptance)?)$/i;
// 只对能说明“改了什么”的内容行取摘要：空行与标题不计，避免排版变化被说成条目变化。
const CONTENT_HEADING = /^#{1,6}\s/;

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

function contentDigests(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !CONTENT_HEADING.test(line))
    .map((line) => createHash("sha256").update(line).digest("hex").slice(0, 12));
}

/**
 * 授权时保存的清单摘要：按合并前与合并后验收两段记下每条内容行的哈希。
 * 只存哈希不存原文，既能说清“哪个章节增删了几条”，又不会把验收内容复制到别处。
 */
export function acceptanceDigest(text) {
  const { preMergeText, postMergeText } = splitAcceptance(text);
  return { preMerge: contentDigests(preMergeText), postMerge: contentDigests(postMergeText) };
}

function diffCounts(before, after) {
  const remaining = new Map();
  for (const hash of before) remaining.set(hash, (remaining.get(hash) ?? 0) + 1);
  let added = 0;
  for (const hash of after) {
    const count = remaining.get(hash) ?? 0;
    if (count > 0) remaining.set(hash, count - 1);
    else added += 1;
  }
  let removed = 0;
  for (const count of remaining.values()) removed += count;
  return { added, removed };
}

/**
 * 授权失效时说清清单改了什么。摘要相同但全文哈希不同（空行、排版、标题措辞）时如实说明，
 * 避免只报“清单改过”又给不出任何可核对的差异。
 */
export function describeAcceptanceChange(before, after) {
  if (!before || !after) return null;
  const parts = [];
  for (const [key, label] of [["preMerge", "合并前"], ["postMerge", "合并后验收"]]) {
    const { added, removed } = diffCounts(before[key] ?? [], after[key] ?? []);
    if (added > 0 || removed > 0) parts.push(`${label} 新增 ${added} 条、删除 ${removed} 条`);
  }
  if (parts.length === 0) return "只有空行、标题或排版变化";
  return parts.join("；");
}
