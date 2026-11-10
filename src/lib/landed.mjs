import { git, gitOk, isAncestor, refExists, resolveCommit } from "./git.mjs";
import { readRecord } from "./store.mjs";

// 提交记录的类别名与键规则在这里写死，不从 delivery/submit.mjs 导入：那边经 obligation.mjs 反向依赖本文件，会成环。
const SUBMIT_KIND = "submit";

/**
 * 任务分支顶端 tip 是否已经落进 ref。
 * 先看祖先关系：merge commit 与快进合并保留原提交，认得出。
 * 平台用 squash 或 rebase 合入时原提交不在主分支历史里，再看内容：把 tip 合入 ref 是否为空操作。
 * 内容判断只对 submit 成功过、记录的提交正好等于 tip 的分支启用；submit 只在远程交付下成功，
 * 没提交过的分支即使内容与主分支巧合一致也不算已合入，本地交付与普通合并的判断不受影响。
 * 合入之后主分支又改了同一处时合并会冲突，这里认不出，保持"待合入"。
 */
export function landedIn(root, tip, ref) {
  if (isAncestor(root, tip, ref)) return true;
  if (!submittedAt(root, tip)) return false;
  return mergeIsNoop(root, tip, ref);
}

function submittedAt(root, tip) {
  const found = readRecord(root, SUBMIT_KIND, tip);
  return found.ok && found.record.stage === "ready" && found.record.head === tip;
}

function mergeIsNoop(root, tip, ref) {
  const merged = git(root, ["merge-tree", "--write-tree", ref, tip]);
  if (merged.status !== 0) return false;
  const tree = merged.stdout.split("\n")[0].trim();
  return tree !== "" && tree === gitOk(root, ["rev-parse", "--verify", `${ref}^{tree}`]);
}

/** 被平台以改写方式合入（原提交不在主分支历史里，内容已在主分支）的本地分支，供 sync 提示。 */
export function rewrittenLandings(root, ref) {
  const names = gitOk(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean);
  return names.filter((name) => {
    if (!refExists(root, name) || name === ref) return false;
    const tip = resolveCommit(root, name);
    return !isAncestor(root, tip, ref) && landedIn(root, tip, ref);
  });
}
