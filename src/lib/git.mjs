import { spawnSync } from "node:child_process";

export const ZERO_OID = "0000000000000000000000000000000000000000";

export function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  return {
    status: result.status ?? (result.error ? 127 : 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

export function git(cwd, args, options = {}) {
  return run("git", args, { cwd, ...options });
}

export function gitOk(cwd, args, options = {}) {
  const result = git(cwd, args, options);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败(${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export function repoRoot(cwd) {
  return gitOk(cwd, ["rev-parse", "--show-toplevel"]);
}

export function commonDir(cwd) {
  return gitOk(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

export function gitDir(cwd) {
  return gitOk(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
}

export function isLinkedWorktree(cwd) {
  return gitDir(cwd) !== commonDir(cwd);
}

export function worktreeRoots(cwd) {
  return gitOk(cwd, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

export function mainWorktreeRoot(cwd) {
  const roots = worktreeRoots(cwd);
  if (roots.length === 0) throw new Error("无法定位主 Worktree");
  return roots[0];
}

export function resolveCommit(cwd, ref) {
  return gitOk(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

export function treeOf(cwd, ref) {
  return gitOk(cwd, ["rev-parse", "--verify", `${ref}^{tree}`]);
}

export function refExists(cwd, ref) {
  return git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status === 0;
}

export function isAncestor(cwd, ancestor, descendant) {
  return git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
}

export function mergeBase(cwd, a, b) {
  return gitOk(cwd, ["merge-base", a, b]);
}

export function changedPaths(cwd, base, head) {
  const result = git(cwd, ["diff", "--name-only", "--no-renames", "-z", base, head]);
  if (result.status !== 0) throw new Error(`git diff 失败: ${result.stderr.trim()}`);
  return result.stdout.split("\0").filter(Boolean);
}

export function isClean(cwd) {
  return gitOk(cwd, ["status", "--porcelain", "--untracked-files=normal"]) === "";
}

export function currentBranch(cwd) {
  const result = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.status === 0 ? result.stdout.trim() : "";
}

export function showBlob(cwd, ref, path) {
  const result = git(cwd, ["cat-file", "blob", `${ref}:${path}`]);
  return result.status === 0 ? result.stdout : null;
}

export function blobOids(cwd, ref, paths) {
  if (paths.length === 0) return {};
  const out = gitOk(cwd, ["ls-tree", "-z", ref, "--", ...paths]);
  const map = {};
  for (const entry of out.split("\0").filter(Boolean)) {
    const [meta, path] = entry.split("\t");
    map[path] = meta.split(" ")[2];
  }
  return map;
}
