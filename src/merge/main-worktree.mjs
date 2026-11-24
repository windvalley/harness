import { existsSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { mainBranch } from "../lib/config.mjs";
import { git, gitOk, LOCAL_ONLY_PATHS, worktreeEntries } from "../lib/git.mjs";

export function mainTrackedChanges(root) {
  return gitOk(root, ["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=none"]);
}

export function mainWorktreeProblems(project, root) {
  const branch = mainBranch(project);
  const problems = [];
  const current = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
  if (current !== branch) problems.push(`主 Worktree 当前不在 ${branch} 分支(实际 ${current || "detached"})`);
  const tracked = mainTrackedChanges(root);
  if (tracked) problems.push(`主 Worktree 的已跟踪文件有未提交改动，先处理后重试:\n${tracked}`);
  for (const marker of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply", "sequencer"]) {
    const path = gitOk(root, ["rev-parse", "--path-format=absolute", "--git-path", marker]);
    if (existsSync(path)) problems.push(`主 Worktree 存在进行中的 ${marker.replace("_HEAD", "").toLowerCase()} 操作`);
  }
  return problems;
}

function gitPaths(root, args) {
  const result = git(root, args);
  if (result.status !== 0) throw new Error(`检查主 Worktree 路径失败（git ${args[0]}）: ${result.stderr.trim()}`);
  return result.stdout.split("\0").filter(Boolean);
}

/** 同名、祖先文件和下面的路径分别查询，避免逐一比较两组文件。 */
function pathRelations(paths, key) {
  const exact = new Map();
  const parents = new Map();
  for (const path of paths) {
    const name = key(path);
    exact.set(name, path);
    for (let end = name.lastIndexOf("/"); end > 0; end = name.lastIndexOf("/", end - 1)) {
      parents.set(name.slice(0, end), path);
    }
  }
  return {
    atOrAbove(path) {
      let name = key(path);
      while (name) {
        if (exact.has(name)) return exact.get(name);
        name = name.slice(0, Math.max(0, name.lastIndexOf("/")));
      }
      return undefined;
    },
    below: (path) => parents.get(key(path)),
  };
}

const displayPath = (path) => /[\x00-\x1f\x7f]/.test(path) ? JSON.stringify(path) : path;
function pathList(paths) {
  const limit = 12;
  return `\n  ${paths.slice(0, limit).join("\n  ")}${paths.length > limit ? `\n  另有 ${paths.length - limit} 项` : ""}`;
}

/**
 * 比较主 Worktree 中不在索引里的路径与本次 checkout 的写入路径。
 * 不启用 Git 的忽略规则：忽略的文件也可能被检出覆盖。
 * 普通未跟踪目录先折叠起来，只有需要区分同目录文件时才展开，避免枚举本机依赖目录。
 */
export function mainCheckoutFiles(root, { mainCommit, resultTree } = {}) {
  const ignoreCase = git(root, ["config", "--bool", "--get", "core.ignorecase"]).stdout.trim() === "true";
  const key = (path) => ignoreCase ? path.toLowerCase().normalize("NFC") : path;
  const written = pathRelations(resultTree ? gitPaths(root, ["diff", "--name-only", "--no-renames", "--ignore-submodules=none", "--diff-filter=AMT", "-z", mainCommit, resultTree, "--"]) : [], key);
  const nested = worktreeEntries(root)
    .map(({ path }) => relative(root, path))
    .filter((path) => path && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path) && existsSync(join(root, path, ".git")))
    .map((path) => path.split(sep).join("/"));
  const excluded = pathRelations([...LOCAL_ONLY_PATHS, ...nested], key);
  const loose = gitPaths(root, ["ls-files", "--others", "--directory", "--no-empty-directory", "-z"]);
  const expand = new Set(loose.filter((entry) => {
    const path = entry.slice(0, -1);
    return entry.endsWith("/") && !written.atOrAbove(path) && (written.below(path) || excluded.below(path));
  }));
  const detailed = expand.size === 0 ? [] : gitPaths(root, ["ls-files", "--others", "-z", "--",
    // 无法从 UTF-8 字符串还原非 UTF-8 的路径名时，不传入失真的路径过滤。
    ...([...expand].some((path) => path.includes("\uFFFD")) ? [] : [...expand].map((path) => `:(literal)${path.slice(0, -1)}`)),
  ]);
  const conflicts = new Map();
  const local = [];
  for (const entry of new Set([...loose.filter((path) => !expand.has(path)), ...detailed])) {
    const directory = entry.endsWith("/");
    const path = directory ? entry.slice(0, -1) : entry;
    // 展开后仍以 / 结尾的是嵌套仓库，不能当成可共用的普通目录。
    const target = written.atOrAbove(path) ?? written.below(path);
    if (target) conflicts.set(path, target);
    else if (!excluded.atOrAbove(path)) local.push(displayPath(entry));
  }
  // 即使 Git 的未跟踪列表没有枚举到，登记的嵌套 Worktree 也不能被交付改动触及。
  for (const path of nested) {
    const target = written.atOrAbove(path) ?? written.below(path);
    if (target) conflicts.set(path, target);
  }
  return {
    conflict: conflicts.size > 0 ? `主 Worktree 本机文件与目标 tree 路径冲突，处理后重试:${pathList([...conflicts].map(([path, target]) => `${displayPath(path)}（目标 ${displayPath(target)}）`))}` : null,
    notice: local.length > 0 ? `主 Worktree 有未跟踪或忽略文件，${resultTree ? "本次更新会原样保留" : "待核对目标 tree"}:${pathList(local)}` : null,
  };
}

export function mainWorktreeReadiness(project, root, target) {
  const problems = mainWorktreeProblems(project, root);
  if (problems.length > 0) return { problems, notice: null };
  const { conflict, notice } = mainCheckoutFiles(root, target);
  return { problems: conflict ? [conflict] : [], notice };
}
