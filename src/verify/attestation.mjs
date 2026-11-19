import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { loadGateProject, loadProject, mainBranch } from "../lib/config.mjs";
import { isAncestor, resolveCommit, treeOf } from "../lib/git.mjs";
import { redact } from "../lib/redact.mjs";
import { appendLedger, readRecord, sha256, writeRecord } from "../lib/store.mjs";
import { checkFingerprint, checkPhase, checkScopeDigest, POST_MERGE } from "./checks.mjs";
import { branchObligations, closeObligations, obligationEvidence, obligationTip } from "./obligation.mjs";
import { landedIn } from "../lib/landed.mjs";

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

/**
 * 登记要用的检查定义。分两条路：
 * - 这条分支为这项检查写过义务：说明当初按合并后验收登记过，之后主分支删掉这项检查或把它挪到合并前，
 *   都要按义务当时的定义登记并关闭义务，否则报告会变成同名的合并前证据，旧义务永远待办。
 * - 没有义务：用门禁配置里的定义。已接入项目取主分支，首次接入取接入分支；
 *   任务分支自己改的配置不参与，所以分支创建于接入之前也不影响登记。
 */
function resolveCheck({ gate, root, branch, checkId, branchTip, mainCommit }) {
  const obligations = branchObligations({ root, mainCommit, branch, checkId });
  if (obligations.length > 0) return obligationCheck({ root, checkId, obligations });
  const check = (gate.verify?.checks ?? []).find((item) => item.id === checkId && item.tier === "extended") ?? null;
  return { check, phase: check ? checkPhase(check) : null, source: "门禁配置" };
}

/** 按义务当时的定义登记：先取合入前证据里签名过的完整定义，再退回义务分支顶端提交的定义并与快照核对。 */
function obligationCheck({ root, checkId, obligations }) {
  const tips = [...new Set(obligations.map((item) => item.branchTip).filter((tip) => typeof tip === "string"))];
  const reasons = [];
  for (const tip of tips) {
    const evidence = obligationEvidence(root, tip);
    const recorded = (evidence?.postMerge ?? []).find((item) => item.id === checkId)?.check;
    if (recorded) return { check: recorded, phase: POST_MERGE, source: `合入前证据里的定义（分支顶端 ${tip.slice(0, 12)}）` };
    let fromCommit = null;
    try {
      fromCommit = (loadProject(root, { fromRef: tip, root }).verify?.checks ?? []).find((item) => item.id === checkId && item.tier === "extended") ?? null;
    } catch (error) {
      reasons.push(`分支顶端 ${tip.slice(0, 12)} 读不出配置（${error.message}）`);
      continue;
    }
    if (!fromCommit) {
      reasons.push(`分支顶端 ${tip.slice(0, 12)} 的配置里没有 ${checkId}`);
      continue;
    }
    const snapshot = obligations.find((item) => item.branchTip === tip)?.check ?? null;
    const mismatch = snapshotMismatch(snapshot, fromCommit);
    if (mismatch) {
      reasons.push(`分支顶端 ${tip.slice(0, 12)} 的定义与义务快照不一致（${mismatch}）`);
      continue;
    }
    return { check: fromCommit, phase: POST_MERGE, source: `分支顶端 ${tip.slice(0, 12)} 的定义` };
  }
  throw new Error(
    `无法确认检查 ${checkId} 当时的定义，不能把这份报告登记成同名的合并前证据。已尝试：${reasons.join("；") || "没有可用的义务分支顶端"}。` +
      `确认这项验收是否仍然需要：需要就用 harness attest --branch <分支> --check <新检查ID> 登记到一个已有的合并后检查，不需要就直接说明它作废`,
  );
}

/** 义务快照与提交里的定义是否一致；只比对能说明“是不是同一次验收”的字段。 */
function snapshotMismatch(snapshot, check) {
  if (!snapshot) return null;
  for (const field of ["howToVerify", "reason"]) {
    const recorded = snapshot[field];
    if (typeof recorded === "string" && recorded !== "" && recorded !== check[field]) return `${field} 不同`;
  }
  return null;
}

/** 登记一次已经成功的外部检查。记录由本机密钥签名，后续 verify 会重新核对检查定义与覆盖文件。 */
export function attestCheck({ cwd, branch, checkId, command, report, note = "", at = null }) {
  if (!branch) throw new Error("用法: harness attest --branch <分支> --check <检查ID> --command <实际命令> --report <报告>");
  if (!checkId) throw new Error("必须用 --check 指定 verify.json 里的 extended 检查");
  if (!String(command ?? "").trim()) throw new Error("必须用 --command 记录实际执行成功的命令");
  const gate = loadGateProject(cwd, { branch });
  const root = gate.root;
  const branchHead = branchTipOf(root, branch, checkId);
  const mainRef = mainBranch(gate);
  const mainCommit = resolveCommit(root, mainRef);
  const resolved = resolveCheck({ gate, root, branch, checkId, branchTip: branchHead, mainCommit });
  const check = resolved.check;
  if (!check) {
    const configured = (gate.verify?.checks ?? []).find((item) => item.id === checkId);
    const where = gate.bootstrap ? `接入分支 ${gate.sourceRef} ` : "主分支";
    if (configured) {
      throw new Error(
        `${where}的配置里不存在 ID 为 ${checkId} 的 extended 检查（它的 tier 是 ${configured.tier}），不能用 attest 登记；` +
          `需要人工验收时把 tier 改为 extended 并写上 reason 与 howToVerify`,
      );
    }
    throw new Error(
      `${where}的门禁配置里不存在 ID 为 ${checkId} 的 extended 检查${gate.bootstrap ? "" : "；门禁配置只从主分支读取，任务分支上自己加的检查不参与判定"}，` +
        `需要这项验收时先在${where}按 extended 配置好${gate.bootstrap ? "" : "（门禁改动要人确认后合入）"}`,
    );
  }
  const phase = resolved.phase;
  if (at && phase !== POST_MERGE) throw new Error("--at 只用于合并后验收检查");
  let head = branchHead;
  if (phase === POST_MERGE) {
    head = mainCommit;
    if (at) {
      try {
        head = resolveCommit(root, at);
      } catch {
        throw new Error(`--at 无法解析为提交: ${at}`);
      }
      if (!isAncestor(root, head, mainCommit)) throw new Error(`--at ${at} 不是 ${mainRef} 的祖先：被测提交必须已经合入 ${mainRef}`);
    }
    if (!landedIn(root, branchHead, head)) {
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
