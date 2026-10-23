import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git, hooksPlacement, isLinkedWorktree, worktreeRoots } from "../lib/git.mjs";
import { harnessOnMain, trustedMainRef } from "../lib/config.mjs";
import { foreignDataDir } from "../lib/store.mjs";
import { isHarnessClientHook, stripHookBlock } from "./install.mjs";

const HOOK_NAMES = ["pre-commit", "commit-msg", "reference-transaction"];
const CLIENT_FILES = [".claude/settings.json", ".codex/hooks.json"];
const PATH_EXT = /\.(mjs|cjs|js|ts|sh|py|json|md|ya?ml)$/;

/** 去掉 harness 自己的块、shebang、注释和空行后剩下的内容，就是其他工具写进去的。 */
function foreignLines(text) {
  return stripHookBlock(text)
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("#"));
}

/**
 * 从脚本或命令里找出它引用的仓库内文件。
 * 只做通用推断：把形如 a/b/c.mjs 的片段逐级去掉前缀，直到在仓库里找到对应文件为止，
 * 这样 $CLAUDE_PROJECT_DIR/x/y.mjs、${repo_root}/x/y.mjs 这类写法都能认出 x/y.mjs。
 */
export function referencedPaths(root, text) {
  const found = new Set();
  for (const token of String(text).split(/[^A-Za-z0-9_./-]+/)) {
    if (!token.includes("/") || !PATH_EXT.test(token)) continue;
    const parts = token.split("/").filter((part) => part && part !== ".");
    for (let index = 0; index < parts.length - 1; index++) {
      const rel = parts.slice(index).join("/");
      if (!rel.startsWith(".harness/") && existsSync(join(root, rel))) {
        found.add(rel);
        break;
      }
    }
  }
  return [...found];
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function foreignAgentHooks(root) {
  const result = [];
  for (const rel of CLIENT_FILES) {
    const config = readJson(join(root, rel));
    for (const entry of config?.hooks?.PreToolUse ?? []) {
      for (const item of entry.hooks ?? []) {
        if (!item.command || isHarnessClientHook(item.command)) continue;
        result.push({ file: rel, command: item.command, refs: referencedPaths(root, item.command) });
      }
    }
  }
  return result;
}

function foreignAgentsBlocks(root) {
  const file = join(root, "AGENTS.md");
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const blocks = [];
  for (const match of text.matchAll(/<!--\s*([\w.-]+):start\s*-->([\s\S]*?)<!--\s*\1:end\s*-->/g)) {
    if (match[1] === "harness") continue;
    blocks.push({ name: match[1], refs: referencedPaths(root, match[2]) });
  }
  return blocks;
}

function topDir(rel) {
  return rel.includes("/") ? `${rel.split("/")[0]}/` : rel;
}

/**
 * 接入前的现状调查，只读不写。
 * 结果分三类：自动处理的（例如被忽略的入口）、默认保留但会冲突的（需要人决定是否接管）、只提示的（可退役的目录）。
 */
export function survey({ root }) {
  const mainRef = trustedMainRefOrNull(root);
  const branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim() || "(分离头指针)";
  const placement = hooksPlacement(root);
  const hooksDir = placement.dir;

  const hooks = HOOK_NAMES.map((name) => {
    const file = join(hooksDir, name);
    if (!existsSync(file)) return { name, exists: false, ours: false, foreign: [] };
    const text = readFileSync(file, "utf8");
    const foreign = foreignLines(text);
    return { name, exists: true, ours: text.includes("# harness:hook"), foreign, refs: referencedPaths(root, foreign.join("\n")) };
  });
  const mainGuard = hooks.find((hook) => hook.name === "reference-transaction");
  const agentHooks = foreignAgentHooks(root);
  const agentsBlocks = foreignAgentsBlocks(root);

  const shimIgnored = git(root, ["check-ignore", "--quiet", "--no-index", ".harness/bin/harness"]).status === 0;
  const refs = [...(mainGuard.refs ?? []), ...agentHooks.flatMap((hook) => hook.refs), ...agentsBlocks.flatMap((block) => block.refs)];
  const legacyDirs = [...new Set(refs.map(topDir))].filter((dir) => dir !== ".harness/" && git(root, ["ls-files", "--", dir]).stdout.trim() !== "");

  const conflicts = [];
  if (mainGuard.foreign.length > 0) {
    conflicts.push({
      id: "main-guard",
      summary: `git 钩子 reference-transaction 里已有其他工具的主分支保护（${mainGuard.foreign.length} 行${mainGuard.refs?.length ? `，引用 ${mainGuard.refs.join(", ")}` : ""}）`,
      impact: "保留时它会和 harness 同时检查主分支更新，harness merge 拿不到它要的凭据，会被它拒绝",
    });
  }
  if (agentHooks.length > 0) {
    conflicts.push({
      id: "agent-hooks",
      summary: `Agent 拦截钩子里已有其他工具：${agentHooks.map((hook) => `${hook.file}: ${hook.command}`).join("；")}`,
      impact: "保留时两套拦截同时生效，旧规则可能挡住 harness 允许的操作，也可能在旧代码删除后报错",
    });
  }

  return {
    root,
    mainRef,
    branch,
    onMain: branch === mainRef,
    linked: isLinkedWorktree(root),
    worktrees: worktreeRoots(root).length,
    harnessOnMain: mainRef ? harnessOnMain(root) : false,
    hooksDir: { path: hooksDir, rel: placement.rel, tracked: placement.tracked },
    hooks,
    agentHooks,
    agentsBlocks,
    shimIgnored,
    foreignData: foreignDataDir(root),
    legacyDirs,
    conflicts,
  };
}

function trustedMainRefOrNull(root) {
  try {
    return trustedMainRef(root);
  } catch {
    return null;
  }
}

/** 把调查结果写成给人看的报告。takeOver 表示本次是否接管冲突项。 */
export function formatSurvey(report, { takeOver = false, planned = [], stack = [] } = {}) {
  const lines = [];
  lines.push("现状");
  lines.push(`  主分支: ${report.mainRef ?? "(还没有提交)"}；当前分支: ${report.branch}${report.linked ? "（Linked Worktree）" : ""}`);
  lines.push(`  harness: ${report.harnessOnMain ? "主分支已接入，本次按升级处理" : "主分支尚未接入，本次为首次接入"}`);
  if (report.worktrees > 1) {
    lines.push(`  Worktree: ${report.worktrees} 个；其他 Worktree 在合入 main 之前保持原样，合入后自动用上新门禁`);
  }
  if (stack.length > 0) lines.push(`  技术栈检查: ${stack.join(", ")}`);
  const where = report.hooksDir.rel ?? report.hooksDir.path;
  lines.push(`  git 钩子目录: ${where}${report.hooksDir.tracked ? "（入库，随分支生效）" : "（所有 Worktree 共用，立即生效）"}`);
  for (const hook of report.hooks) {
    if (!hook.exists) continue;
    if (hook.foreign.length === 0) continue;
    const note = hook.name === "reference-transaction" ? "其他工具的主分支保护" : "原有脚本，保留，harness 检查插在最前面";
    lines.push(`    ${hook.name}: ${note}`);
  }
  for (const block of report.agentsBlocks) {
    lines.push(`  AGENTS.md 里其他工具的托管块: ${block.name}${block.refs.length ? `（引用 ${block.refs.slice(0, 3).join(", ")}）` : ""}`);
  }
  if (report.shimIgnored) lines.push("  .gitignore 会忽略入口 .harness/bin/harness：自动放行");
  if (report.foreignData) lines.push(`  ${report.foreignData} 已被其他工具占用：harness 的证据与账本改放同级的 harness.d，两边互不混淆`);

  if (report.conflicts.length > 0) {
    lines.push("");
    lines.push(takeOver ? "接管（--take-over）" : "需要决定（默认保留，加 --take-over 由 harness 接管）");
    for (const conflict of report.conflicts) {
      lines.push(`  - ${conflict.summary}`);
      lines.push(`    ${takeOver ? "将移除原有内容" : conflict.impact}`);
    }
  }

  if (planned.length > 0) {
    lines.push("");
    lines.push("将写入");
    for (const item of planned) lines.push(`  ${item.action === "create" ? "新建" : "修改"} ${item.rel}`);
  }

  if (report.legacyDirs.length > 0) {
    lines.push("");
    lines.push(`可在接入合并后退役的目录（被上面的钩子或托管块引用，harness 不会自动删除）: ${report.legacyDirs.join(", ")}`);
  }
  if (report.legacyDirs.length > 0 || report.conflicts.length > 0) {
    lines.push("");
    lines.push("转换建议");
    lines.push("  原有工具的项目规则不会自动转换。仍需要的禁令写进 .harness/policy.json，检查映射写进 .harness/verify.json，");
    lines.push("  对应的回归用例写进 .harness/golden/tasks.json；这些文件 Agent 可以直接改。");
    lines.push("  与接入放在同一个分支提交，人工确认时一起过目；否则接管之后、补上规则之前，这些规则不再生效。");
  }
  return lines.join("\n");
}
