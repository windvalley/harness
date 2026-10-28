import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git, refExists, repoRoot, showBlob } from "./git.mjs";

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
 * 两边都没有配置时返回 null，表示这个仓库没有接入 harness，钩子应当放行；非 Git 目录同样放行。
 */
export function loadGuardProject(cwd) {
  const args = ["rev-parse", "--show-toplevel"];
  const probe = git(cwd, args, { env: { ...process.env, LC_ALL: "C" } });
  if (probe.status !== 0) {
    if (probe.status === 128 && probe.stderr.startsWith("fatal: not a git repository ")) return null;
    throw new Error(`git ${args.join(" ")} 失败(${probe.status}): ${probe.stderr.trim()}`);
  }
  const root = probe.stdout.trim();
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

/** at 给定时从主分支的那个提交读配置，调用方据此把“配置”与“基线”固定在同一个提交上。 */
export function loadTrustedProject(cwd, { at } = {}) {
  const root = repoRoot(cwd);
  const project = loadProject(root, { fromRef: at ?? trustedMainRef(root), root });
  checkMainBranchName(root, project);
  return project;
}

// 配置里的主分支名写错（典型情况：git init 用了 main，配置写了 master）时直接说清楚，
// 否则后续每一步都会报 rev-parse 失败，看不出是配置问题。
function checkMainBranchName(root, project) {
  const configured = project.config.mainBranch;
  if (configured && !refExists(root, `refs/heads/${configured}`)) {
    const actual = trustedMainRef(root);
    throw new Error(`配置里的 mainBranch 是 ${configured}，但仓库里只有 ${actual}。把 .harness/config.json 的 mainBranch 改成 ${actual} 并提交`);
  }
}

export function harnessOnMain(root) {
  return showBlob(root, trustedMainRef(root), `${PROJECT_DIR}/config.json`) !== null;
}

/**
 * 门禁流程（verify、review、confirm、merge）使用的配置。
 * 主分支已接入时一律取主分支，这是信任根；
 * 主分支还没有配置时处于首次接入阶段，没有信任根可用，只能按接入分支提议的配置执行，
 * 由合并前的人工确认来认可这份配置，因此返回结果带 bootstrap 标记，合并时强制要求确认。
 */
export function loadGateProject(cwd, { branch, at } = {}) {
  const root = repoRoot(cwd);
  if (harnessOnMain(root)) return loadTrustedProject(root, { at });
  const mainRef = trustedMainRef(root);
  if (!branch) {
    throw new Error(`${mainRef} 上还没有 .harness/config.json：首次接入阶段请用 --branch <接入分支> 指定配置来源`);
  }
  const project = loadProject(root, { fromRef: branch, root });
  checkMainBranchName(root, project);
  return { ...project, bootstrap: true, bootstrapRef: branch };
}

/**
 * 只读命令（doctor、rules、golden、check）使用的配置。
 * 主分支已接入时取主分支；首次接入阶段主分支还没有配置，退回当前工作区，并带 bootstrap 标记。
 */
export function loadCurrentProject(cwd) {
  const root = repoRoot(cwd);
  let onMain = false;
  try {
    onMain = harnessOnMain(root);
  } catch {
    onMain = false;
  }
  if (onMain) return loadTrustedProject(root);
  return { ...loadProject(root, { root }), bootstrap: true };
}

export function mainBranch(project) {
  return project.config.mainBranch || "main";
}

// 会改变门禁判定结果的文件：配置、规则、用例，以及执行器入口（入口版本号决定跑哪份门禁代码）。
export const GATE_FILES = [
  ".harness/config.json",
  ".harness/policy.json",
  ".harness/verify.json",
  // 版本锁决定本机跑哪份门禁代码，远程改它和改门禁本身是一回事。
  ".harness/VERSION",
  ".harness/golden/**",
  ".harness/rules/**",
  ".harness/bin/**",
  ".claude/settings.json",
  ".codex/hooks.json",
  ".githooks/**",
  ".husky/**",
  "**/.husky/**",
];

/**
 * 项目自己管理 git 钩子目录时的设置（config.git）。没有配置 hooksDir 时返回 null，沿用 core.hooksPath 或 .git/hooks。
 * hooksDir：harness 整个接管的入库目录，core.hooksPath 指向主 Worktree 里的这个目录，所有 Worktree 执行同一份钩子。
 * projectHooks：项目自己的钩子脚本目录，harness 检查通过后按同名脚本调用，在当前 Worktree 的检出里执行。
 */
export function gitHooksConfig(config) {
  const settings = config?.git ?? {};
  if (!settings.hooksDir) return null;
  return {
    hooksDir: repoRelativeDir(settings.hooksDir, "git.hooksDir"),
    projectHooks: settings.projectHooks ? repoRelativeDir(settings.projectHooks, "git.projectHooks") : null,
  };
}

function repoRelativeDir(value, label) {
  const text = String(value).trim().replace(/\/+$/, "");
  const parts = text.split("/").filter((part) => part !== ".");
  if (!text || text.startsWith("/") || parts.length === 0 || parts.some((part) => part === ".." || part === "") || parts[0] === ".git") {
    throw new Error(`.harness/config.json 的 ${label} 必须是仓库内的相对目录，例如 .githooks，不能是绝对路径、.. 或 .git 下的目录: ${value}`);
  }
  return parts.join("/");
}

export function gatePaths(project) {
  const extra = project.config.governance?.gatePaths ?? [];
  const hooks = gitHooksConfig(project.config);
  return [...GATE_FILES, ...(hooks ? [`${hooks.hooksDir}/**`] : []), ...extra];
}

// 执行器入口：入口版本、客户端钩子配置与钩子目录。改动合入后需要在主 Worktree 刷新本机钩子并提示客户端重新加载。
export const ENTRY_FILES = [".harness/bin/**", ".claude/settings.json", ".codex/hooks.json", ".githooks/**", ".husky/**", "**/.husky/**"];

/** 合入后要在主 Worktree 刷新本机钩子的文件：执行器入口、项目配置的钩子目录，以及决定钩子目录的配置本身。 */
export function entryPaths(project) {
  const hooks = project ? gitHooksConfig(project.config) : null;
  return [...ENTRY_FILES, ".harness/config.json", ".harness/VERSION", ...(hooks ? [`${hooks.hooksDir}/**`] : [])];
}

const DELIVERY_PROVIDERS = { github: "gh", gitlab: "glab" };

/**
 * 交付设置（config.delivery），缺省按本地交付。
 * local：harness merge 合入本地主分支；remote：harness submit 推送任务分支并创建或更新 PR/MR，由团队在平台上合并。
 * 两种模式都可以用 harness sync 把本地主分支快进到 remote 指向的远程主分支。
 * 只保留影响行为的字段，本地交付下的 provider 不起作用，比较时不计入，只写出缺省值也不算改动。
 */
export function deliverySettings(config) {
  const raw = config?.delivery ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(".harness/config.json 的 delivery 必须是对象");
  const mode = raw.mode ?? "local";
  if (mode !== "local" && mode !== "remote") throw new Error(`.harness/config.json 的 delivery.mode 只能是 local 或 remote，当前是 ${JSON.stringify(mode)}`);
  const remote = raw.remote ?? "origin";
  if (typeof remote !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) {
    throw new Error(`.harness/config.json 的 delivery.remote 必须是远程名，例如 origin，当前是 ${JSON.stringify(remote)}`);
  }
  const provider = raw.provider ?? null;
  if (provider !== null && !(provider in DELIVERY_PROVIDERS)) {
    throw new Error(`.harness/config.json 的 delivery.provider 只能是 ${Object.keys(DELIVERY_PROVIDERS).join(" 或 ")}，当前是 ${JSON.stringify(provider)}`);
  }
  if (mode === "remote" && provider === null) throw new Error(".harness/config.json 的 delivery.mode 为 remote 时必须指定 delivery.provider：github 或 gitlab");
  return { mode, remote, provider: mode === "remote" ? provider : null };
}

export function sameDelivery(a, b) {
  return a.mode === b.mode && a.remote === b.remote && a.provider === b.provider;
}

export function describeDelivery(settings) {
  return settings.mode === "remote" ? `远程交付（${settings.provider}，远程 ${settings.remote}）` : `本地交付（同步远程 ${settings.remote}）`;
}

/** 开启远程交付时授予的权限，写进确认摘要，由人看过再确认。 */
export function deliveryGrant(settings) {
  return settings.mode === "remote"
    ? `harness submit 可以把任务分支普通推送到 ${settings.remote} 并创建或更新 PR/MR；不包括在平台上合并、推送主分支和强推`
    : "harness merge 合入本地主分支，harness submit 不再推送任务分支";
}

/** 某个提交上的交付设置；那里没有 .harness/config.json 时返回 null。 */
export function deliveryAt(root, ref) {
  const blob = showBlob(root, ref, `${PROJECT_DIR}/config.json`);
  return blob === null ? null : deliverySettings(parse(blob, `${ref}:${PROJECT_DIR}/config.json`));
}

/**
 * 两份配置之间交付设置是否变化。改交付方式等于改变 Agent 的远程权限，不受 confirmOnGateChange 影响，一律要人确认。
 * before 为 null 表示首次接入（主分支还没有配置），这时首次接入本身已经要求确认。
 */
export function deliveryChange(before, after) {
  if (!before) return { before: null, after, changed: false };
  return { before, after, changed: !sameDelivery(before, after) };
}

export function acceptanceDir(project) {
  return `${PROJECT_DIR}/${project.config.intent?.dir ?? "acceptance"}`;
}

export function acceptancePath(project, branch) {
  return `${acceptanceDir(project)}/${branch.replace(/[^0-9A-Za-z._-]+/g, "-")}.md`;
}
