import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { loadGateProject, loadProject, mainBranch } from "../lib/config.mjs";
import { isAncestor, resolveCommit, treeOf } from "../lib/git.mjs";
import { redact } from "../lib/redact.mjs";
import { appendLedger, readRecord, sha256, writeRecord } from "../lib/store.mjs";
import { checkFingerprint, checkPhase, checkScopeDigest, POST_MERGE } from "./checks.mjs";
import { closeObligations, obligationTip } from "./obligation.mjs";

export const ATTESTATION_KIND = "attestation";
const MAX_REPORT_BYTES = 10 * 1024 * 1024;

function key(branch, checkId) {
  return `att-${sha256(`${branch}\0${checkId}`).slice(0, 24)}`;
}

export function readAttestation({ root, branch, check, head }) {
  const found = readRecord(root, ATTESTATION_KIND, key(branch, check.id));
  if (!found.ok) return found;
  const record = found.record;
  if (record.branch !== branch || record.checkId !== check.id || record.status !== "passed") {
    return { ok: false, code: "mismatch", reason: "外部证据与检查不一致" };
  }
  if (record.phase === POST_MERGE && (record.branchHead ?? record.head) !== head) {
    return { ok: false, code: "stale", reason: "外部证据已过期：任务分支已变化" };
  }
  const definition = checkFingerprint(check);
  const scope = checkScopeDigest(root, record.phase === POST_MERGE ? record.head : head, check);
  if (record.definition !== definition || record.scope !== scope) {
    return { ok: false, code: "stale", reason: "外部证据已过期：检查定义或覆盖文件已变化" };
  }
  return { ok: true, record };
}

function reportFile(cwd, value) {
  if (!value) throw new Error("必须用 --report 指定实际验证报告");
  const path = resolve(cwd, value);
  const name = basename(path).toLowerCase();
  if (/^\.env(?:\.|$)/.test(name) || /(?:\.pem|\.key|\.p12|\.pfx)$/.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)/.test(name)) {
    throw new Error("报告路径指向密钥或凭据文件，拒绝读取");
  }
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`报告不存在: ${path}`);
  }
  if (!stat.isFile()) throw new Error(`报告不是普通文件: ${path}`);
  if (stat.size > MAX_REPORT_BYTES) throw new Error(`报告超过 ${MAX_REPORT_BYTES} 字节，请提供精简后的验证报告`);
  const content = readFileSync(path);
  const text = content.toString("utf8");
  return {
    path,
    bytes: stat.size,
    sha256: sha256(content),
    excerpt: redact(text.split("\n").slice(-80).join("\n")).slice(-6000),
  };
}

/** 分支还在时取它的顶端；分支已被删除时取这条分支为该检查写下的义务里的顶端。 */
function branchTipOf(root, branch, checkId) {
  try {
    return resolveCommit(root, branch);
  } catch (error) {
    const tip = obligationTip({ root, branch, checkId });
    if (!tip) throw error;
    return tip;
  }
}

/** 登记一次已经成功的外部检查。记录由本机密钥签名，后续 verify 会重新核对检查定义与覆盖文件。 */
export function attestCheck({ cwd, branch, checkId, command, report, note = "", at = null }) {
  if (!branch) throw new Error("用法: harness attest --branch <分支> --check <检查ID> --command <实际命令> --report <报告>");
  if (!checkId) throw new Error("必须用 --check 指定 verify.json 里的 extended 检查");
  if (!String(command ?? "").trim()) throw new Error("必须用 --command 记录实际执行成功的命令");
  const gate = loadGateProject(cwd, { branch });
  const root = gate.root;
  const branchHead = branchTipOf(root, branch, checkId);
  const proposed = loadProject(root, { fromRef: branchHead, root });
  const check = (proposed.verify?.checks ?? []).find((item) => item.id === checkId && item.tier === "extended");
  if (!check) throw new Error(`分支 ${branch} 上不存在 ID 为 ${checkId} 的 extended 检查`);
  const phase = checkPhase(check);
  if (at && phase !== POST_MERGE) throw new Error("--at 只用于合并后验收检查");
  let head = branchHead;
  if (phase === POST_MERGE) {
    const mainRef = mainBranch(gate);
    const mainHead = resolveCommit(root, mainRef);
    head = mainHead;
    if (at) {
      try {
        head = resolveCommit(root, at);
      } catch {
        throw new Error(`--at 无法解析为提交: ${at}`);
      }
      if (!isAncestor(root, head, mainHead)) throw new Error(`--at ${at} 不是 ${mainRef} 的祖先：被测提交必须已经合入 ${mainRef}`);
    }
    if (!isAncestor(root, branchHead, head)) {
      throw new Error(`检查 ${checkId} 属于合并后验收，必须在分支合入 ${mainRef} 后执行并登记；远程交付请先等平台合入并运行 harness sync`);
    }
  }
  const record = writeRecord(root, ATTESTATION_KIND, key(branch, checkId), {
    status: "passed",
    branch,
    branchHead,
    checkId,
    phase,
    head,
    tree: treeOf(root, head),
    definition: checkFingerprint(check),
    scope: checkScopeDigest(root, head, check),
    command: redact(String(command).trim()),
    report: reportFile(cwd, report),
    note: redact(String(note ?? "").trim()),
    createdAt: new Date().toISOString(),
  });
  const closed = phase === POST_MERGE ? closeObligations({ root, branch, branchTip: branchHead, checkId, at: head, reportSha256: record.report.sha256 }) : [];
  appendLedger(root, { event: "attest", branch, checkId, phase, head, closed: closed.length });
  return { ...record, closedObligations: closed.length };
}
