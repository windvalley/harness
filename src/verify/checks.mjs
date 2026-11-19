import { createHash } from "node:crypto";
import { gitOk } from "../lib/git.mjs";
import { matchAny } from "../lib/glob.mjs";
import { canonical, sha256 } from "../lib/store.mjs";

export const PRE_MERGE = "pre-merge";
export const POST_MERGE = "post-merge";

export function checkPhase(check) {
  const phase = check?.phase ?? PRE_MERGE;
  if (![PRE_MERGE, POST_MERGE].includes(phase)) throw new Error(`检查 ${check?.id ?? "(无 id)"} 的 phase 只能是 ${PRE_MERGE} 或 ${POST_MERGE}`);
  return phase;
}

export function checkFingerprint(check, env = {}) {
  return createHash("sha256").update(canonical({ check, env })).digest("hex").slice(0, 16);
}

/** 配置里的合并后检查；phase 写错的跳过，交给 checkConfigProblem 在验证时报出。 */
export function postMergeChecks(verify) {
  return (verify?.checks ?? []).filter((check) => {
    try {
      return check?.tier === "extended" && checkPhase(check) === POST_MERGE;
    } catch {
      return false;
    }
  });
}

/**
 * 合并后检查与本次改动的命中情况。approve 摘要与 verify 的报错共用这一份计算，
 * 免得 when 的匹配语义在两处漂移。
 */
export function postMergeHits({ verify, changed }) {
  return postMergeChecks(verify).map((check) => {
    const when = Array.isArray(check.when) ? check.when : [];
    return { id: check.id, when, hits: changed.filter((path) => matchAny(path, when)) };
  });
}

/** 外部证据跟随检查覆盖文件的内容，而不是跟随无关文档产生的新提交号。 */
export function checkScopeDigest(root, head, check) {
  const entries = gitOk(root, ["ls-tree", "-r", "-z", head]).split("\0").filter(Boolean);
  const hash = [];
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    const path = entry.slice(tab + 1);
    if (!matchAny(path, check.when ?? [])) continue;
    const oid = entry.slice(0, tab).split(" ")[2];
    hash.push(`${path}\0${oid}`);
  }
  return sha256(hash.join("\n"));
}
