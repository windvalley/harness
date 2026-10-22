import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { refExists, repoRoot, showBlob } from "./git.mjs";

export const PROJECT_DIR = ".harness";
export const FILES = ["config.json", "policy.json", "verify.json"];

function parse(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`无法解析 ${label}: ${error.message}`);
  }
}

// 主分支只认仓库里真实存在的 main 或 master，不读项目配置，避免被改。
export function trustedMainRef(root) {
  for (const name of ["main", "master"]) {
    if (refExists(root, `refs/heads/${name}`)) return name;
  }
  throw new Error("找不到 main 或 master 分支，无法确定门禁配置的信任来源");
}

function readFromRef(root, ref, rel, { optional = false } = {}) {
  const blob = showBlob(root, ref, rel);
  if (blob === null) {
    if (optional) return null;
    throw new Error(`${ref} 上缺少 ${rel}，请先提交项目配置`);
  }
  return parse(blob, `${ref}:${rel}`);
}

function readFromWorktree(root, rel, { optional = false } = {}) {
  const file = join(root, rel);
  if (!existsSync(file)) {
    if (optional) return null;
    throw new Error(`缺少项目配置 ${rel}，先运行 harness init`);
  }
  return parse(readFileSync(file, "utf8"), rel);
}

/**
 * 读取项目配置。
 * fromRef 给定（一般是 main）时从 git 对象读取，任务分支里改过的配置不能决定自己是否放行。
 */
export function loadProject(cwd, { fromRef, root = repoRoot(cwd) } = {}) {
  const read = (name, options) => {
    const rel = `${PROJECT_DIR}/${name}`;
    return fromRef ? readFromRef(root, fromRef, rel, options) : readFromWorktree(root, rel, options);
  };
  const [config, policy, verify] = FILES.map((name) => read(name));
  return {
    root,
    source: fromRef ?? "worktree",
    config,
    policy,
    verify,
    golden: read("golden/tasks.json", { optional: true }) ?? { tasks: [] },
  };
}

/**
 * 拦截层使用的配置来源。
 * 主分支已有配置就读主分支，保持信任根不变；
 * 主分支还没有（例如 init 之后的第一次提交）时退回工作区，让配置本身能被提交进去；
 * 两边都没有配置时返回 null，表示这个仓库没有接入 harness，钩子应当放行。
 */
export function loadGuardProject(cwd) {
  const root = repoRoot(cwd);
  let ref;
  try {
    ref = trustedMainRef(root);
  } catch {
    ref = null;
  }
  if (ref && showBlob(root, ref, `${PROJECT_DIR}/config.json`) !== null) {
    return loadProject(root, { fromRef: ref, root });
  }
  if (existsSync(join(root, PROJECT_DIR, "config.json"))) {
    return { ...loadProject(root, { root }), bootstrap: true };
  }
  return null;
}

export function loadTrustedProject(cwd) {
  const root = repoRoot(cwd);
  return loadProject(root, { fromRef: trustedMainRef(root), root });
}

export function mainBranch(project) {
  return project.config.mainBranch || "main";
}

export const GATE_FILES = [
  ".harness/config.json",
  ".harness/policy.json",
  ".harness/verify.json",
  ".harness/golden/**",
  ".harness/rules/**",
];

export function gatePaths(project) {
  const extra = project.config.governance?.gatePaths ?? [];
  return [...GATE_FILES, ...extra];
}

export function acceptanceDir(project) {
  return `${PROJECT_DIR}/${project.config.intent?.dir ?? "acceptance"}`;
}

export function acceptancePath(project, branch) {
  return `${acceptanceDir(project)}/${branch.replace(/[^0-9A-Za-z._-]+/g, "-")}.md`;
}
