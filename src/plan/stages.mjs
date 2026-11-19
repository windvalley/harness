import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { acceptancePath } from "../lib/config.mjs";
import { acceptanceDigest, describeAcceptanceChange } from "../lib/acceptance.mjs";
import { matchAny } from "../lib/glob.mjs";
import { refExists, resolveCommit, showBlob } from "../lib/git.mjs";
import { landedIn } from "../lib/landed.mjs";
import { dataDir, readLedger, readRecord, sha256, writeRecord } from "../lib/store.mjs";
import { resolveBranchRule, branchNameProblems } from "../policy/branch-name.mjs";
import { resolvePolicy } from "../policy/resolve.mjs";

// 多阶段方案：一份方案要多个任务分支依次交付时，用阶段文件按顺序列出阶段，用户一次授权覆盖全部阶段。
// 方案级授权按阶段文件路径做键，每份方案只有一条当前记录；各阶段分支的普通授权记录里写明属于哪个阶段。
// 有效性只由内容哈希决定：携带方案级授权的分支核对全部方案材料，派生出来的阶段分支只核对本阶段的清单。

export const STAGES_KIND = "plan-stages";
export const STAGES_DEFAULT = ["docs/changes/*/stages.json"];
const PLAN_KIND = "plan";
const MATERIAL_CHANGED = "方案材料在授权后改过，需要向用户说明并重新授权";

export function stagePatterns(config) {
  return config?.intent?.plan?.stages ?? STAGES_DEFAULT;
}

function grantKey(file) {
  return `st-${sha256(file).slice(0, 24)}`;
}

/** 解析阶段文件：{"stages": [{id, title, branch, acceptance}]}，按顺序排列，id 不能重复。 */
export function parseStages(text, file) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`阶段文件 ${file} 不是有效的 JSON: ${error.message}`);
  }
  const list = data?.stages;
  if (!Array.isArray(list) || list.length === 0) throw new Error(`阶段文件 ${file} 必须写成 {"stages": [...]}，且至少有一个阶段`);
  const seen = new Set();
  return list.map((item, index) => {
    for (const field of ["id", "title", "branch", "acceptance"]) {
      if (typeof item?.[field] !== "string" || item[field].trim() === "") throw new Error(`阶段文件 ${file} 第 ${index + 1} 个阶段缺少非空字符串字段 ${field}`);
    }
    if (seen.has(item.id)) throw new Error(`阶段文件 ${file} 的阶段 id 重复: ${item.id}`);
    seen.add(item.id);
    return { id: item.id, title: item.title, branch: item.branch, acceptance: item.acceptance };
  });
}

/**
 * 记录方案级授权前的核对：阶段文件符合约定路径、已提交、格式正确，全部阶段清单已提交。
 * 返回要写入的记录内容与携带分支对应的阶段；建议分支名不合规只作提示。
 */
export function prepareGrant({ project, root, branch, at, file, stage }) {
  const patterns = stagePatterns(project.config);
  if (!matchAny(file, patterns)) throw new Error(`阶段文件 ${file} 不符合 intent.plan.stages 的约定（${patterns.join("、")}）`);
  const text = showBlob(root, at, file);
  if (text === null) throw new Error(`阶段文件 ${file} 还没有提交到分支 ${branch}，先把方案提交到任务分支再记录授权`);
  const stages = parseStages(text, file);
  const current = stage ?? stages[0].id;
  if (!stages.some((item) => item.id === current)) throw new Error(`阶段文件 ${file} 里没有阶段 ${current}`);
  const hashed = stages.map((item) => {
    const content = showBlob(root, at, item.acceptance);
    if (content === null) throw new Error(`阶段 ${item.id} 的验收清单 ${item.acceptance} 还没有提交到分支 ${branch}`);
    return { ...item, acceptanceHash: sha256(content), acceptanceLines: acceptanceDigest(content) };
  });
  return { grant: { file, stagesHash: sha256(text), stages: hashed }, stage: current, hints: nameHints(project, stages) };
}

/**
 * 阶段文件在授权后的变化：按阶段 id 比对字段，说清是哪个阶段的 title、branch 或验收清单路径改过。
 * 解析失败只说明文件内容变了，不再抛错，失效原因本身要能被读到。
 */
function describeStagesChange(grant, text) {
  if (typeof text !== "string") return "阶段文件已删除";
  let stages;
  try {
    stages = parseStages(text, grant.file);
  } catch {
    return "阶段文件内容已变化（无法按阶段解析）";
  }
  const before = new Map(grant.stages.map((item) => [item.id, item]));
  const after = new Map(stages.map((item) => [item.id, item]));
  const parts = [];
  for (const [id, item] of after) {
    const previous = before.get(id);
    if (!previous) {
      parts.push(`新增阶段 ${id}`);
      continue;
    }
    for (const field of ["title", "branch", "acceptance"]) {
      if (previous[field] !== item[field]) parts.push(`阶段 ${id} 的 ${field} 有变化`);
    }
  }
  for (const id of before.keys()) if (!after.has(id)) parts.push(`删除阶段 ${id}`);
  // 顺序本身决定交付条件：阶段派生按数组顺序检查前序是否已合入，换序不能算作无关改动。
  // 只比共有阶段的相对顺序：在开头插入新阶段时，已有阶段的先后没变，由“新增阶段”覆盖。
  const order = orderChange(grant.stages, stages);
  if (order) parts.push(order);
  if (parts.length === 0) parts.push("只有排版或无关字段变化");
  return parts.join("；");
}

/** 共有阶段 id 的相对顺序是否变了；变了就给出改动前后的顺序。 */
function orderChange(before, after) {
  const shared = new Set(after.map((item) => item.id).filter((id) => before.some((item) => item.id === id)));
  const beforeIds = before.map((item) => item.id).filter((id) => shared.has(id));
  const afterIds = after.map((item) => item.id).filter((id) => shared.has(id));
  if (beforeIds.join("\0") === afterIds.join("\0")) return null;
  return `阶段顺序由 ${beforeIds.join(" -> ")} 改为 ${afterIds.join(" -> ")}`;
}

function nameHints(project, stages) {
  let spec;
  try {
    spec = resolveBranchRule(resolvePolicy(project.policy));
  } catch {
    return [];
  }
  return stages
    .filter((item) => branchNameProblems({ spec, name: item.branch, mainRef: null }).length > 0)
    .map((item) => `阶段 ${item.id} 的建议分支名 ${item.branch} 不符合当前分支命名规则，建分支时改用合规名称，再用 --from-stages 记录授权`);
}

export function writeGrant(root, payload) {
  return writeRecord(root, STAGES_KIND, grantKey(payload.file), payload);
}

export function readGrant(root, file) {
  const found = readRecord(root, STAGES_KIND, grantKey(file));
  if (found.ok && found.record.file !== file) return { ok: false, reason: `记录属于阶段文件 ${found.record.file}` };
  return found;
}

/**
 * 普通授权记录带有阶段信息时的额外校验，供 approvalState 调用；返回失效原因，有效时返回 null。
 * at 是读取携带分支方案材料的提交，缺省用分支名。
 */
export function stageApprovalProblem({ root, branch, link, acceptanceText, at }) {
  const found = readGrant(root, link.file);
  if (!found.ok) return `方案 ${link.file} 的阶段授权记录无效（${found.reason}），需要向用户说明并重新授权`;
  const grant = found.record;
  if (link.role === "carrier") {
    if (grant.carrier?.branch !== branch) return `方案 ${link.file} 已在分支 ${grant.carrier?.branch} 重新授权，本分支的授权失效，需要向用户说明并重新授权`;
    const ref = at ?? branch;
    const text = showBlob(root, ref, link.file);
    if (text === null || sha256(text) !== grant.stagesHash) return `${MATERIAL_CHANGED}（${describeStagesChange(grant, text)}）`;
    for (const item of grant.stages) {
      const content = showBlob(root, ref, item.acceptance);
      if (content === null) return `${MATERIAL_CHANGED}（阶段 ${item.id} 的验收清单 ${item.acceptance} 已删除）`;
      if (sha256(content) !== item.acceptanceHash) {
        const change = item.acceptanceLines ? describeAcceptanceChange(item.acceptanceLines, acceptanceDigest(content)) : null;
        return `${MATERIAL_CHANGED}（阶段 ${item.id} 的验收清单${change ? `：${change}` : "内容已变化"}）`;
      }
    }
    return null;
  }
  const stage = grant.stages.find((item) => item.id === link.stage);
  if (!stage) return `方案 ${link.file} 的授权里没有阶段 ${link.stage}，需要向用户说明并重新授权`;
  if (acceptanceText === null || acceptanceText === undefined || sha256(acceptanceText) !== stage.acceptanceHash) {
    const change = acceptanceText !== null && acceptanceText !== undefined && stage.acceptanceLines
      ? describeAcceptanceChange(stage.acceptanceLines, acceptanceDigest(acceptanceText))
      : null;
    return `阶段 ${link.stage} 的验收清单与方案授权不一致${change ? `（${change}）` : ""}，需要向用户说明并重新授权`;
  }
  return null;
}

/** 本仓库里能通过校验、属于某份方案的普通授权记录。 */
function stageRecords(root, file) {
  const dir = join(dataDir(root), PLAN_KIND);
  if (!existsSync(dir)) return [];
  const records = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const found = readRecord(root, PLAN_KIND, name.slice(0, -".json".length));
    if (found.ok && found.record.stages?.file === file) records.push(found.record);
  }
  return records;
}

/** 分支是否已合入：分支还在时看提交，分支删掉后看账本里本地合并或远程推送时记下的提交。 */
function branchLanded(root, branch, mainCommit, ledger) {
  if (refExists(root, branch)) return landedIn(root, resolveCommit(root, branch), mainCommit);
  return ledger.some(
    (event) => ["merge", "submit.push"].includes(event.event) && event.branch === branch && typeof event.head === "string" && landedIn(root, event.head, mainCommit),
  );
}

/** 各阶段的合入情况与还没交付的分支，按阶段文件里的顺序排列。 */
export function stageLanding({ root, file, stages, mainCommit }) {
  const ledger = readLedger(root);
  const records = stageRecords(root, file);
  return stages.map((stage) => {
    const branches = records.filter((record) => record.stages.stage === stage.id).map((record) => record.branch);
    const landed = branches.filter((branch) => branchLanded(root, branch, mainCommit, ledger));
    const open = branches.filter((branch) => !landed.includes(branch) && refExists(root, branch));
    return { ...stage, landed: landed.length > 0, open };
  });
}

/**
 * 某个阶段分支所属方案的进度：已合入几个阶段、下一个没合入的阶段。
 * 方案级授权失效，或还有后续阶段时主分支上的阶段文件与授权时不一致，返回 invalid，由调用方提示用户重新授权；
 * 全部阶段已合入后再改阶段文件不影响任何授权，不再提示。
 */
export function stageProgress({ root, link, mainCommit }) {
  const found = readGrant(root, link.file);
  if (!found.ok) return { file: link.file, stage: link.stage, invalid: `的阶段授权记录无效（${found.reason}）` };
  const grant = found.record;
  const stages = stageLanding({ root, file: link.file, stages: grant.stages, mainCommit });
  const index = stages.findIndex((item) => item.id === link.stage);
  const next = stages.slice(index + 1).find((item) => !item.landed) ?? null;
  const onMain = showBlob(root, mainCommit, link.file);
  if (next && onMain !== null && sha256(onMain) !== grant.stagesHash) return { file: link.file, stage: link.stage, invalid: "在主分支上的阶段文件与授权时不一致" };
  return { file: link.file, stage: link.stage, stages, landed: stages.filter((item) => item.landed).length, total: stages.length, next, grant };
}

export function formatProgress(progress) {
  if (progress.invalid) return `方案 ${progress.file} ${progress.invalid}，后续阶段需要用户重新授权`;
  const next = progress.next ? `下一阶段 ${progress.next.id}（${progress.next.title}）` : "全部阶段已合入";
  return `方案 ${progress.file}：本分支是阶段 ${progress.stage}，已合入 ${progress.landed}/${progress.total} 个阶段，${next}`;
}

/** 为下一阶段建分支时要做的事，写给 Agent 看。 */
export function nextStageStep({ project, progress, mainRef }) {
  const next = progress.next;
  return (
    `从 ${mainRef} 创建分支 ${next.branch}（不符合当前分支命名规则时改用合规名称），` +
    `把 ${next.acceptance} 复制为该分支的验收清单 ${acceptancePath(project, next.branch)} 并提交，` +
    `再运行 harness approve --branch ${next.branch} --yes --from-stages ${progress.file} --stage ${next.id}`
  );
}
