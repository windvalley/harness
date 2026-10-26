import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

/**
 * 判断一个路径落在本仓库的哪个 Worktree：会话可能停在主 Worktree，却改 Linked Worktree 里的文件
 * （Linked Worktree 也可能就建在主 Worktree 的目录下）。路径可能还不存在，从最近的已存在目录起算。
 * 不属于本仓库任何 Worktree（用户目录、/tmp、.git 内部、别的仓库）时 outsideRepo 为真。
 */
export function locatePath(root, target, { checkIgnore = false } = {}) {
  const abs = isAbsolute(target) ? target : resolve(root, target);
  let dir = abs;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  if (existsSync(dir) && !statSync(dir).isDirectory()) dir = dirname(dir);
  const probe = git(dir, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]);
  if (probe.status !== 0) return { outsideRepo: true };
  const [top, ownGitDir, common] = probe.stdout.trim().split("\n");
  if (common !== commonDir(root)) return { outsideRepo: true };
  const branch = currentBranch(top);
  // git 给出的是真实路径（macOS 上 /var 实为 /private/var），目标也换成真实路径，才能算出正确的相对路径。
  const real = join(realpathSync(dir), relative(dir, abs));
  const place = {
    outsideRepo: false,
    root: top,
    path: real,
    linkedWorktree: ownGitDir !== common,
    branch,
    onMainBranch: ["main", "master"].includes(branch),
  };
  // 被 .gitignore 忽略的文件不影响主 Worktree 是否洁净；已跟踪的文件 check-ignore 不会报忽略。
  if (checkIgnore) place.ignored = git(top, ["check-ignore", "-q", "--", relative(top, real) || "."]).status === 0;
  return place;
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

// harness 在本机生成、不入库的目录。首次接入时主分支还没有忽略它们，不能因此把主 Worktree 判成不洁净。
export const LOCAL_ONLY_PATHS = [".harness/dsh-plugin"];

export function statusShort(cwd, { exclude = LOCAL_ONLY_PATHS } = {}) {
  const spec = exclude.length > 0 ? ["--", ".", ...exclude.map((path) => `:(exclude)${path}`)] : [];
  return gitOk(cwd, ["status", "--porcelain", "--untracked-files=normal", ...spec]);
}

export function isClean(cwd, options) {
  return statusShort(cwd, options) === "";
}

export function currentBranch(cwd) {
  const result = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.status === 0 ? result.stdout.trim() : "";
}

export function showBlob(cwd, ref, path) {
  const result = git(cwd, ["cat-file", "blob", `${ref}:${path}`]);
  return result.status === 0 ? result.stdout : null;
}

/**
 * git 钩子目录在哪、是否随分支入库。
 * 入库的钩子目录（husky、.githooks 等）随分支分发，改动要等合入主分支才生效；
 * 不入库的目录（默认的 .git/hooks）所有 Worktree 共用，写入立即对全部 Worktree 生效。
 * hooksDir 给定时由项目配置接管钩子目录，写入当前 Worktree 里的这个目录，与 core.hooksPath 的现值无关。
 */
export function hooksPlacement(root, { hooksDir } = {}) {
  if (hooksDir) return { dir: join(root, hooksDir), rel: hooksDir, tracked: true, managed: true };
  const configured = git(root, ["config", "--get", "core.hooksPath"]).stdout.trim();
  if (configured && isAbsolute(configured)) {
    // 绝对路径可能指向某个 Worktree 里的入库目录（例如主 Worktree 的 .githooks）。
    // 按那个 Worktree 算出相对路径，写当前 Worktree 里对应的目录，不能去改别的 Worktree 的入库文件。
    const place = locatePath(root, configured);
    if (!place.outsideRepo) {
      const rel = relative(place.root, place.path).split(sep).join("/");
      if (rel && rel !== ".git" && !rel.startsWith(".git/")) {
        const tracked = git(root, ["ls-files", "--", rel]).stdout.trim() !== "";
        return { dir: join(root, rel), rel, tracked };
      }
    }
  }
  const dir = configured ? (isAbsolute(configured) ? configured : join(root, configured)) : join(commonDir(root), "hooks");
  const rel = relative(root, dir).split(sep).join("/");
  const inside = Boolean(configured) && rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && rel !== ".git" && !rel.startsWith(".git/");
  const tracked = inside && git(root, ["ls-files", "--", rel]).stdout.trim() !== "";
  return { dir, rel: inside ? rel : null, tracked };
}

/** 两个路径是否指向同一个位置；存在的部分按真实路径比较（macOS 上 /var 与 /private/var 是同一目录）。 */
export function samePath(a, b) {
  const real = (path) => {
    let dir = resolve(path);
    const rest = [];
    while (!existsSync(dir) && dirname(dir) !== dir) {
      rest.unshift(basename(dir));
      dir = dirname(dir);
    }
    return join(realpathSync(dir), ...rest);
  };
  return real(a) === real(b);
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
