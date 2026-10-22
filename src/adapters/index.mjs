import { currentBranch, isLinkedWorktree, repoRoot } from "../lib/git.mjs";
import { loadGuardProject } from "../lib/config.mjs";
import { appendLedger } from "../lib/store.mjs";
import { evaluateCall, formatDenial } from "../policy/engine.mjs";
import { resolvePolicy } from "../policy/resolve.mjs";

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

/**
 * 适配器契约：
 *   name                 客户端标识
 *   normalize(payload)   返回 { call, tool } 或 null（无法识别的工具放行）
 *   formatDeny(text)     返回 { exitCode, stderr }
 * call.kind 取 shell / write / read / search，所有客户端都归一到这四类。
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
  // 一次调用可能涉及多个文件（例如 Codex 的 apply_patch），逐个判定，任一被拒即拒。
  const calls = normalized.call.paths
    ? normalized.call.paths.map((path) => ({ ...normalized.call, path, paths: undefined }))
    : [normalized.call];

  let result = { decision: "allow" };
  for (const call of calls) {
    result = evaluateCall({ policy: resolved, root: project.root, call, context });
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
