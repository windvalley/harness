import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { matchAny } from "./lib/glob.mjs";
import { commonDir, currentBranch, git, gitOk, isLinkedWorktree, ZERO_OID } from "./lib/git.mjs";
import { describeProblems, messageProblems, normalizeMessage, resolveCommitRule } from "./policy/commit-message.mjs";
import { assertBranchPolicy } from "./policy/branch-name.mjs";
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
export function checkStaged({ root, resolved, config = {} }) {
  // 先判提交本身能不能发生（例如主 Worktree 只用来合并），再判暂存了什么。
  const branch = currentBranch(root);
  const commit = evaluateCommit({
    policy: resolved,
    context: { linkedWorktree: isLinkedWorktree(root), branch, onMainBranch: ["main", "master"].includes(branch) },
  });
  if (commit.decision === "deny") return commit;

  try {
    assertBranchPolicy({ project: { root, policy: { rules: resolved.rules }, config }, requireBranch: true, checkRule: false });
  } catch (error) {
    return deny({ id: "branch-name", reason: "分支命名检查未通过", fix: "按 .harness/policy.json 的 branch-name 规则修正后重试" }, `${error.code}: ${error.message}`);
  }

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

/**
 * 用编辑器写提交信息时，git 交给 commit-msg 的文件还带着注释行，--verbose 时还有剪刀线和 diff，
 * 写入提交前才清理。这里按 git 默认的 strip 规则先清理再判定：去掉剪刀线及以下、注释行、行尾空白，
 * 合并连续空行，去掉首尾空行。
 * 用 -m 提交时 git 只清理空白、保留以注释符开头的行，这种少见写法交给合并时按真实提交信息再判一次。
 */
export function cleanCommitMessage(raw, commentChar = "#") {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const scissors = lines.findIndex((line) => line.startsWith(commentChar) && / -+ >8 -+$/.test(line));
  const kept = (scissors >= 0 ? lines.slice(0, scissors) : lines)
    .filter((line) => !line.startsWith(commentChar))
    .map((line) => line.replace(/\s+$/, ""));
  const out = [];
  for (const line of kept) {
    if (line === "" && (out.length === 0 || out.at(-1) === "")) continue;
    out.push(line);
  }
  while (out.length > 0 && out.at(-1) === "") out.pop();
  return out.join("\n");
}

// core.commentChar 为 auto 时 git 会临时挑一个未被占用的字符，这里无法得知，按默认的 # 处理。
function commentCharOf(root) {
  const value = git(root, ["config", "--get", "core.commentChar"]).stdout.replace(/\n$/, "");
  return value && value !== "auto" ? value : "#";
}

/**
 * 正在写的这个提交是不是合并提交。
 * git merge 时 MERGE_HEAD 还在；对合并提交执行 --amend 时 MERGE_HEAD 已经不在，
 * 只能看 HEAD 本身是不是合并提交，并且新信息要么沿用原说明、要么仍是 Merge 主题，才算在重写那个合并提交。
 */
function rewritesMergeCommit(root, message) {
  if (git(root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).status === 0) return true;
  if (git(root, ["rev-parse", "--verify", "--quiet", "HEAD^2"]).status !== 0) return false;
  if (/^Merge\b/.test(message.split("\n")[0] ?? "")) return true;
  const headMessage = normalizeMessage(cleanCommitMessage(git(root, ["log", "-1", "--format=%B", "HEAD"]).stdout, commentCharOf(root)));
  return headMessage !== "" && message === headMessage;
}

export function checkCommitMessage({ root, resolved, config = {}, messageFile }) {
  const spec = resolveCommitRule({ resolved, config });
  if (!spec) return { decision: "allow" };
  const raw = readFileSync(resolve(root, messageFile), "utf8");
  const message = normalizeMessage(cleanCommitMessage(raw, commentCharOf(root)));
  // 合并提交只是同步分支，与合并时 --no-merges 的口径一致。
  // 手写一个 Merge 标题的普通提交能过钩子，但它不是合并提交，交付前仍会被 status 与 merge 拦下。
  if (rewritesMergeCommit(root, message)) return { decision: "allow" };
  const author = git(root, ["var", "GIT_AUTHOR_IDENT"]).stdout.replace(/>.*$/s, ">").trim();

  const problems = messageProblems({ spec, message, author });
  if (problems.length === 0) return { decision: "allow" };
  const header = message.split("\n")[0];
  return deny(spec.rule, [`提交信息不符合规范: ${header}`, ...describeProblems(spec, problems)].join("\n"));
}

/**
 * 引用存储里这条引用的状态：packed-refs 里记录的提交、是否还有松散引用文件、packed-refs 是否正被锁住。
 * 只认 files 后端；读不到时返回 null，调用方按不能证明是维护操作处理。
 */
export function refStorage(cwd, ref) {
  try {
    const dir = commonDir(cwd);
    const packedFile = join(dir, "packed-refs");
    let packed = null;
    if (existsSync(packedFile)) {
      for (const line of readFileSync(packedFile, "utf8").split("\n")) {
        const match = line.match(/^([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/);
        if (match && match[2] === ref) packed = match[1];
      }
    }
    return { packed, loose: existsSync(join(dir, ref)), packedLocked: existsSync(`${packedFile}.lock`) };
  } catch {
    return null;
  }
}

/**
 * 要删除的是不是 pack-refs 留下的冗余松散副本：删除后引用仍由 packed-refs 指向同一提交。
 * 真正删除主分支时 git 先锁住 packed-refs 去掉打包条目，钩子运行时锁已存在；
 * pack-refs 清理松散副本时不碰 packed-refs，没有这把锁。锁存在、打包值不同或没有松散副本时都不算。
 */
function redundantLooseRef({ ref, oid, current, storage }) {
  if (current !== oid) return false;
  const state = storage(ref);
  return Boolean(state && state.loose && !state.packedLocked && state.packed === oid);
}

/**
 * 引用保护：只有 harness merge 能更新主分支。
 * update-ref 不带旧值时钩子收到全零，必须以引用当前实际值为准，否则零值会变成绕过。
 * 目标提交不变的维护操作放行。pack-refs 分两个事务：先以全零旧值把当前提交写进 packed-refs，
 * 再删除已冗余的松散副本；两步都不改变主分支指向的提交。
 */
export function guardReference({ input, token, cwd, getRef, storage = (ref) => refStorage(cwd, ref) }) {
  if (process.env.HARNESS_MAIN_BYPASS === "1") return { decision: "allow" };
  const touched = input
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "))
    .filter(([, , ref]) => MAIN_REFS.has(ref));

  for (const [hookOld, newOid, ref] of touched) {
    // 旧值与新值都是具体提交且相同：确实没有变化。
    // 全零到全零不能这样跳过：不带旧值删除（update-ref -d、branch -D）收到的就是这一行，要按当前值判断。
    if (hookOld !== ZERO_OID && hookOld === newOid) continue;
    const current = getRef(ref);
    // 新建引用（例如首次创建 main）不需要令牌，此时没有旧历史可保护。
    if (hookOld === ZERO_OID && newOid !== ZERO_OID && current === null) continue;
    const oldOid = hookOld === ZERO_OID ? current : hookOld;
    // 引用不存在时删除它没有可保护的内容。
    if (oldOid === null) continue;
    if (oldOid === newOid) continue;
    if (newOid === ZERO_OID && hookOld !== ZERO_OID && redundantLooseRef({ ref, oid: oldOid, current, storage })) continue;
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
