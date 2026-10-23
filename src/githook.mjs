import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { matchAny } from "./lib/glob.mjs";
import { currentBranch, git, gitOk, isLinkedWorktree, ZERO_OID } from "./lib/git.mjs";
import { evaluateCommit, formatDenial } from "./policy/engine.mjs";
import { resolvePolicy } from "./policy/resolve.mjs";
import { signPayload, loadKey } from "./lib/store.mjs";

export const MERGE_TOKEN_ENV = "HARNESS_MERGE_TOKEN";
export const MAIN_REFS = new Set(["refs/heads/main", "refs/heads/master"]);

export function mainUpdateToken(oldOid, newOid) {
  return signPayload({ purpose: "main-update", old: oldOid, new: newOid });
}

function deny(rule, detail) {
  return {
    decision: "deny",
    rule: rule.id,
    reason: rule.reason,
    fix: rule.fix,
    detail,
  };
}

/**
 * 暂存区检查：git 层是唯一所有客户端都会经过的入口。
 * 只判路径与新增内容，不判生成文件头（无法区分人工修改与生成器产出）。
 */
export function checkStaged({ root, resolved }) {
  // 先判提交本身能不能发生（例如主 Worktree 只用来合并），再判暂存了什么。
  const branch = currentBranch(root);
  const commit = evaluateCommit({
    policy: resolved,
    context: { linkedWorktree: isLinkedWorktree(root), branch, onMainBranch: ["main", "master"].includes(branch) },
  });
  if (commit.decision === "deny") return commit;

  const paths = gitOk(root, ["diff", "--cached", "--name-only", "--no-renames"])
    .split("\n")
    .filter(Boolean);
  if (paths.length === 0) return { decision: "allow" };

  // layer=agent 的规则只约束 Agent 的实时工具调用；git 层看不出写入者，跳过它们。
  const writeRules = resolved.rules.filter(
    (rule) => (rule.kind === "write-protect" || rule.kind === "content-forbid") && rule.layer !== "agent",
  );
  for (const rule of writeRules) {
    for (const path of paths) {
      if (!matchAny(path, rule.paths ?? [])) continue;
      if (rule.kind === "write-protect") {
        if (!matchAny(path, rule.allow ?? [])) return deny(rule, path);
        continue;
      }
      const added = git(root, ["diff", "--cached", "-U0", "--no-color", "--", path]).stdout;
      for (const pattern of rule.patterns ?? []) {
        const lines = added.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
        if (lines.some((line) => new RegExp(pattern, "i").test(line.slice(1)))) {
          return deny(rule, `${path}: ${pattern}`);
        }
      }
    }
  }
  return { decision: "allow" };
}

export function checkCommitMessage({ root, resolved, messageFile }) {
  const rule = resolved.rules.find((item) => item.kind === "commit-message");
  if (!rule) return { decision: "allow" };
  const raw = readFileSync(resolve(root, messageFile), "utf8");
  const message = raw.replace(/\r\n/g, "\n").replace(/\n+$/, "");

  // 合并提交由 harness merge 生成，标题固定为 Merge 主题，不套用普通提交格式。
  const isMerge = /^Merge[: ]/.test(message) || git(root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).status === 0;
  if (isMerge) return { decision: "allow" };

  if (rule.pattern && !new RegExp(rule.pattern).test(message)) {
    return deny(
      { ...rule, detail: message.split("\n")[0] },
      `提交信息不符合规范: ${message.split("\n")[0]}`,
    );
  }
  for (const pattern of rule.forbidPatterns ?? []) {
    if (new RegExp(pattern, "im").test(message)) {
      return deny(rule, `提交信息命中禁用内容: ${pattern}`);
    }
  }
  return { decision: "allow" };
}

/**
 * 引用保护：只有 harness merge 能更新主分支。
 * update-ref 不带旧值时钩子收到全零，必须以引用当前实际值为准，否则零值会变成绕过。
 */
export function guardReference({ input, token, cwd, getRef }) {
  if (process.env.HARNESS_MAIN_BYPASS === "1") return { decision: "allow" };
  const touched = input
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "))
    .filter(([oldOid, newOid, ref]) => MAIN_REFS.has(ref) && oldOid !== newOid);

  for (const [hookOld, newOid, ref] of touched) {
    // 新建引用（例如首次创建 main）不需要令牌，此时没有旧历史可保护。
    if (hookOld === ZERO_OID && newOid !== ZERO_OID && getRef(ref) === null) continue;
    const oldOid = hookOld === ZERO_OID ? getRef(ref) : hookOld;
    if (oldOid === null) continue;
    const expected = mainUpdateToken(oldOid, newOid);
    if (token !== expected) {
      return {
        decision: "deny",
        reason: `拒绝直接更新 ${ref}(${oldOid.slice(0, 10)} -> ${newOid.slice(0, 10)})`,
      };
    }
  }
  return { decision: "allow" };
}
