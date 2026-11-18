import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir, readRecord, sha256, writeRecord } from "../lib/store.mjs";

const KIND = "submit";

function targetFields({ provider, remote, repo, baseRef }) {
  return [provider, remote, repo, baseRef];
}

function submitKey(progress) {
  return `${progress.head}.${sha256(JSON.stringify([progress.branch, ...targetFields(progress)]))}`;
}

export function sameSubmitTarget(record, target) {
  const expected = targetFields(target);
  return targetFields(record).every((part, index) => part === expected[index]);
}

function submitKeys(root) {
  const dir = join(dataDir(root), KIND);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?:\.[0-9a-f]{64})?\.json$/.test(name))
    .map((name) => name.slice(0, -".json".length));
}

/** 找不到新键时按分支、提交和目标核对旧的单提交记录。 */
export function readSubmit(root, target) {
  if (!existsSync(join(dataDir(root), KIND))) return null;
  let result = readRecord(root, KIND, submitKey(target));
  if (result.code === "missing") result = readRecord(root, KIND, target.head);
  if (!result.ok) return null;
  const record = result.record;
  return record.head === target.head && record.branch === target.branch && sameSubmitTarget(record, target) ? record : null;
}

/** 当前目标的记录优先。没有时返回同一分支的旧记录，供 status 说明变更。 */
export function latestSubmit(root, target) {
  const current = readSubmit(root, target);
  if (current) return current;
  let sameHead = null;
  let older = null;
  for (const key of submitKeys(root)) {
    const result = readRecord(root, KIND, key);
    if (!result.ok || result.record.branch !== target.branch) continue;
    const record = result.record;
    if (record.head === target.head) {
      if (sameSubmitTarget(record, target)) continue;
      if (!sameHead || record.createdAt > sameHead.createdAt) sameHead = record;
    } else if (!older || record.createdAt > older.createdAt) older = record;
  }
  return sameHead ?? older;
}

export function saveSubmit(root, progress, stage, fields, previous) {
  const record = { ...progress, stage, ...fields, createdAt: new Date().toISOString() };
  if (stage !== "ready") {
    const lastReadyAt = previous?.stage === "ready" ? previous.createdAt : previous?.lastReadyAt;
    if (lastReadyAt) record.lastReadyAt = lastReadyAt;
  }
  return writeRecord(root, KIND, submitKey(progress), record);
}

/** 基线变更要求重新回读，同时保留先前就绪的证据供 squash/rebase 识别。 */
export function hasReadySubmit(root, head, matches = () => true) {
  return submitKeys(root).some((key) => {
    if (key !== head && !key.startsWith(`${head}.`)) return false;
    const result = readRecord(root, KIND, key);
    return result.ok && result.record.head === head &&
      (result.record.stage === "ready" || typeof result.record.lastReadyAt === "string") && matches(result.record);
  });
}
