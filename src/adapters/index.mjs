import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { currentBranch, isLinkedWorktree, locatePath, repoRoot } from "../lib/git.mjs";
import { loadGuardProject } from "../lib/config.mjs";
import { appendLedger } from "../lib/store.mjs";
import { evaluateCall, formatDenial } from "../policy/engine.mjs";
import { resolvePolicy } from "../policy/resolve.mjs";
import { worktreePlanPending } from "../plan/plan.mjs";

export function contextFor(root) {
  let linkedWorktree = false;
  let branch = "";
  try {
    linkedWorktree = isLinkedWorktree(root);
    branch = currentBranch(root);
  } catch {
    linkedWorktree = false;
  }
  return {
    linkedWorktree,
    onMainBranch: ["main", "master"].includes(branch),
    branch,
  };
}

// 哪类调用需要先确定落点。写入一律要：路径规则（例如入口保护 .harness/bin/**）按落点所在 Worktree 的相对路径判定，
// 会话停在主 Worktree 时改嵌套在其目录下的 Linked Worktree，不能按主 Worktree 算相对路径。
// 读与命令只有带 when 条件或按忽略放行的规则才关心，其余情况不多花 git 调用。
function locatedKinds(resolved) {
  const kinds = new Set(["write"]);
  for (const rule of resolved.rules) {
    if (!rule.when && !rule.allowIgnored) continue;
    if (rule.kind === "read-protect") kinds.add("read");
    if (rule.kind === "shell-forbid" || rule.kind === "shell-secret-access") kinds.add("shell");
  }
  return kinds;
}

function placeContext(base, place) {
  if (place.outsideRepo) return { ...base, outsideRepo: true };
  return { ...base, linkedWorktree: place.linkedWorktree, onMainBranch: place.onMainBranch, branch: place.branch };
}

/**
 * 一次读写真正落在哪个 Worktree：会话停在主 Worktree 时，也可能改 Linked Worktree 里的文件。
 * 按落点重算上下文，路径改为相对落点所在 Worktree 判定。
 */
function locatePathCall(call, root, base, kinds) {
  if (!kinds.has(call.kind) || !call.path || (call.kind !== "write" && call.kind !== "read")) {
    return { root, call, context: base };
  }
  const place = locatePath(root, resolve(root, call.path), { checkIgnore: true });
  if (place.outsideRepo) return { root, call, context: placeContext(base, place) };
  return { root: place.root, call: { ...call, path: place.path }, context: { ...placeContext(base, place), ignored: place.ignored } };
}

/**
 * 命令里 cd、git -C 去到的目录换成那里的上下文。目录不存在时 cd 会失败，
 * 之后的命令在哪执行取决于分隔符，返回 null 按无法确定处理。
 */
function shellLocator(root, base) {
  const cache = new Map();
  return (dir) => {
    if (!cache.has(dir)) {
      const exists = existsSync(dir) && statSync(dir).isDirectory();
      cache.set(dir, exists ? placeContext(base, locatePath(root, dir)) : null);
    }
    return cache.get(dir);
  };
}

/**
 * 适配器契约：
 *   name                 客户端标识
 *   normalize(payload)   返回 { call, tool } 或 null（无法识别的工具放行）
 *   formatDeny(text)     返回 { exitCode, stderr }
 * call.kind 取 shell / write / read / search，所有客户端都归一到这四类；commit 只由 git 的 pre-commit 产生。
 */
export function guard({ adapter, payload, log = () => {} }) {
  const cwd = payload?.cwd || process.cwd();
  let project;
  try {
    project = loadGuardProject(cwd);
  } catch (error) {
    return { decision: "error", message: error.message };
  }
  if (!project) return { decision: "allow" };

  const normalized = adapter.normalize(payload, { root: project.root });
  if (!normalized) return { decision: "allow" };

  const resolved = resolvePolicy(project.policy);
  const context = contextFor(project.root);
  const kinds = locatedKinds(resolved);
  // 一次调用可能涉及多个文件（例如 Codex 的 apply_patch），逐个判定，任一被拒即拒。
  const calls = normalized.call.paths
    ? normalized.call.paths.map((path) => ({ ...normalized.call, path, paths: undefined }))
    : [normalized.call];

  // Agent 常用 cd <目录> && ... 或 git -C <目录> 在别的 Worktree 里执行命令，带条件的规则按每段实际所在的目录判定。
  const locate = kinds.has("shell") ? shellLocator(project.root, context) : undefined;
  // 方案待批准只约束写入：按落点所在 Worktree 的分支与工作区判断，只有启用了相应规则才多花这几次 git 调用。
  const planRule = resolved.rules.some((rule) => rule.when === "plan-pending");
  let result = { decision: "allow" };
  for (const call of calls) {
    const located = locatePathCall(call, project.root, context, kinds);
    if (planRule && located.call.kind === "write" && !located.context.outsideRepo) {
      located.context = { ...located.context, planPending: worktreePlanPending({ root: located.root, branch: located.context.branch, project }) };
    }
    result = evaluateCall({ policy: resolved, root: located.root, call: located.call, context: located.context, cwd: resolve(cwd), locate });
    if (result.decision === "deny") break;
  }

  if (result.decision === "deny") {
    appendLedger(project.root, {
      event: "policy.deny",
      rule: result.rule,
      tool: normalized.tool,
      client: adapter.name,
    });
    log(`[harness] ${adapter.name} 拦截 ${result.rule}`);
    return { decision: "deny", result, adapter, normalized };
  }
  return { decision: "allow" };
}

export function renderDenial({ result, adapter }) {
  return adapter.formatDeny(formatDenial(result, { client: adapter.name }));
}

export { repoRoot };
