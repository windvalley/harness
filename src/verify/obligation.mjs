import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitOk, isAncestor, refExists, resolveCommit } from "../lib/git.mjs";
import { appendLedger, checkRecord, dataDir, readRecord, sha256, writeRecord } from "../lib/store.mjs";

export const OBLIGATION_KIND = "obligation";
// 证据类别名在这里写死而不从 verify.mjs 导入：verify.mjs 经由 attestation.mjs 依赖本文件，反向导入会成环。
const EVIDENCE_KIND = "evidence";

export function obligationKey(checkId, branchTip) {
  return `ob-${sha256(`${checkId}\0${branchTip}`).slice(0, 24)}`;
}

function recordsDir(root) {
  return join(dataDir(root), OBLIGATION_KIND);
}

function readRaw(root, key) {
  const file = join(recordsDir(root), `${key}.json`);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return { key, raw, verified: checkRecord(raw, OBLIGATION_KIND, key) };
  } catch {
    return null;
  }
}

function allRaw(root) {
  const dir = recordsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readRaw(root, name.slice(0, -".json".length)))
    .filter(Boolean);
}

const snapshot = (item) => ({ reason: item.reason ?? "", howToVerify: item.howToVerify ?? "", when: item.when ?? [] });

/** 合入前为每项待验收检查写一条义务；同一检查与分支顶端已有记录时保持原状，已关闭的不会重新打开。 */
export function writeObligations({ root, branch, tip, items }) {
  for (const item of items ?? []) {
    const key = obligationKey(item.id, tip);
    if (readRaw(root, key)) continue;
    writeRecord(root, OBLIGATION_KIND, key, {
      branch,
      branchTip: tip,
      checkId: item.id,
      check: snapshot(item),
      closedBy: null,
      createdAt: new Date().toISOString(),
    });
  }
}

export function hasObligation({ root, branch }) {
  return allRaw(root).some(({ raw }) => raw.branch === branch);
}

/** 分支已被删除时，登记要用的分支顶端取自这条分支最近一次写下的义务。 */
export function obligationTip({ root, branch, checkId }) {
  const found = allRaw(root)
    .filter(({ raw }) => raw.branch === branch && raw.checkId === checkId && typeof raw.branchTip === "string")
    .sort((a, b) => String(b.raw.createdAt).localeCompare(String(a.raw.createdAt)))[0];
  return found?.raw.branchTip ?? null;
}

function localBranches(root) {
  return gitOk(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean);
}

/**
 * 汇总义务：已写下的记录，加上读取时从分支顶端证据里推导出的旧任务（只有证据、没有义务记录）。
 * 到期是指分支顶端已经包含在主分支里；记录验签失败时按到期、未关闭处理，不能因为读不出来就当作没有义务。
 * legacyClosed 由调用方提供，用来判断推导出的旧任务有没有按旧方式登记过。
 */
export function collectObligations({ root, mainCommit, branch = null, legacyClosed = null }) {
  const out = [];
  const seen = new Set();
  const dueOf = (tip) => isAncestor(root, tip, mainCommit);

  for (const { key, raw, verified } of allRaw(root)) {
    if (branch && raw.branch !== branch) continue;
    seen.add(key);
    out.push({
      key,
      branch: raw.branch,
      branchTip: raw.branchTip,
      checkId: raw.checkId,
      howToVerify: raw.check?.howToVerify ?? "",
      createdAt: raw.createdAt ?? "",
      closed: verified.ok && Boolean(raw.closedBy),
      problem: verified.ok ? null : verified.reason,
      derived: false,
      due: verified.ok ? dueOf(raw.branchTip) : true,
    });
  }

  for (const name of branch ? [branch] : localBranches(root)) {
    if (!refExists(root, name)) continue;
    const tip = resolveCommit(root, name);
    const evidence = readRecord(root, EVIDENCE_KIND, tip);
    if (!evidence.ok) continue;
    for (const item of evidence.record.postMerge ?? []) {
      const key = obligationKey(item.id, tip);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        branch: name,
        branchTip: tip,
        checkId: item.id,
        howToVerify: item.howToVerify ?? "",
        createdAt: evidence.record.createdAt ?? "",
        closed: legacyClosed ? Boolean(legacyClosed({ item, branch: name, tip })) : false,
        problem: null,
        derived: true,
        due: dueOf(tip),
      });
    }
  }
  return out;
}

/**
 * 一次合并后登记成功：同一检查、分支顶端已包含在被测提交 at 里的全部义务一并关闭。
 * 先把这条分支只有证据、没有记录的旧义务补成记录，再统一关闭。
 */
export function closeObligations({ root, branch, branchTip, checkId, at, reportSha256 }) {
  const evidence = readRecord(root, EVIDENCE_KIND, branchTip);
  if (evidence.ok) {
    writeObligations({ root, branch, tip: branchTip, items: (evidence.record.postMerge ?? []).filter((item) => item.id === checkId) });
  }
  const closed = [];
  for (const { key, raw, verified } of allRaw(root)) {
    if (raw.checkId !== checkId || typeof raw.branchTip !== "string" || typeof raw.branch !== "string") continue;
    if (verified.ok && raw.closedBy) continue;
    if (!isAncestor(root, raw.branchTip, at)) continue;
    writeRecord(root, OBLIGATION_KIND, key, {
      branch: raw.branch,
      branchTip: raw.branchTip,
      checkId,
      check: raw.check ?? {},
      closedBy: { at, branch, report: reportSha256, closedAt: new Date().toISOString() },
      createdAt: raw.createdAt ?? new Date().toISOString(),
    });
    closed.push(raw.branch);
  }
  if (closed.length > 0) appendLedger(root, { event: "obligation.close", checkId, at, branches: closed });
  return closed;
}
