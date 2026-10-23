import { homedir } from "node:os";
import { resolve } from "node:path";
import { currentBranch, isLinkedWorktree, locatePath, repoRoot } from "../lib/git.mjs";
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

// Agent 常用 cd <目录> && ... 或 git -C <目录> 在别的 Worktree 里执行命令，判定要以那个目录为准。
const LEADING_CD = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)/;
const GIT_DIR_OPTION = /\bgit\s+-C\s+("[^"]+"|'[^']+'|[^\s;&|]+)/;

function unquote(text) {
  return text.replace(/^(["'])(.*)\1$/, "$2").replace(/^~(?=\/|$)/, homedir());
}

/**
 * 一次调用真正落在哪个 Worktree：会话停在主 Worktree 时，也可能改 Linked Worktree 里的文件，
 * 或在那里执行命令。按落点重算上下文，路径改为相对落点所在 Worktree 判定。
 */
function locateCall(call, { root, cwd }, base, kinds) {
  if (!kinds.has(call.kind)) return { root, call, context: base };
  let target = null;
  if (call.kind === "write" || call.kind === "read") target = call.path ? resolve(root, call.path) : null;
  if (call.kind === "shell") {
    const command = String(call.command ?? "");
    const cd = command.match(LEADING_CD);
    const from = cd ? resolve(cwd, unquote(cd[1])) : cwd;
    const dashC = command.match(GIT_DIR_OPTION);
    if (cd || dashC) target = dashC ? resolve(from, unquote(dashC[1])) : from;
  }
  if (!target) return { root, call, context: base };
  const place = locatePath(root, target, { checkIgnore: call.kind !== "shell" });
  if (place.outsideRepo) return { root, call, context: { ...base, outsideRepo: true } };
  return {
    root: place.root,
    call: call.kind === "shell" ? call : { ...call, path: place.path },
    context: {
      ...base,
      linkedWorktree: place.linkedWorktree,
      onMainBranch: place.onMainBranch,
      branch: place.branch,
      ignored: place.ignored,
    },
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

  let result = { decision: "allow" };
  for (const call of calls) {
    const located = locateCall(call, { root: project.root, cwd }, context, kinds);
    result = evaluateCall({ policy: resolved, root: located.root, call: located.call, context: located.context });
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
