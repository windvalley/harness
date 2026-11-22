// Antigravity 的钩子载荷：toolCall.name + toolCall.args，公共会话字段是 conversationId 与 workspacePaths。
// PreToolUse 用 decision 为 allow / deny 的 JSON 判定；Stop 用 continue 让 Agent 接着做，stop 放行结束。
import { isAbsolute, resolve, sep } from "node:path";

function replacementContent(args) {
  if (typeof args.ReplacementContent === "string") return args.ReplacementContent;
  if (!Array.isArray(args.ReplacementChunks)) return undefined;
  return args.ReplacementChunks.map((chunk) => chunk?.ReplacementContent ?? "").join("\n");
}

function targetPath(tool, args) {
  if (tool === "run_command") return undefined;
  return args.TargetFile ?? args.AbsolutePath ?? args.SearchPath ?? args.SearchDirectory ?? args.DirectoryPath;
}

function workspaceFor(payload, args, tool) {
  const workspaces = Array.isArray(payload?.workspacePaths) ? payload.workspacePaths.filter((path) => typeof path === "string" && path) : [];
  const target = targetPath(tool, args);
  if (typeof target === "string" && isAbsolute(target)) {
    return workspaces
      .filter((workspace) => target === workspace || target.startsWith(`${workspace}${sep}`))
      .sort((a, b) => b.length - a.length)[0];
  }
  return workspaces[0];
}

function callOf(tool, args) {
  if (tool === "run_command") return { kind: "shell", command: String(args.CommandLine ?? "") };
  if (["write_to_file", "replace_file_content", "multi_replace_file_content"].includes(tool)) {
    const content = args.CodeContent ?? replacementContent(args);
    return { kind: "write", path: args.TargetFile, content: typeof content === "string" ? content : undefined };
  }
  if (tool === "view_file") return { kind: "read", path: args.AbsolutePath };
  if (tool === "grep_search") return { kind: "search", path: args.SearchPath, glob: args.Includes };
  if (tool === "find_by_name") return { kind: "search", path: args.SearchDirectory, glob: args.Pattern };
  if (tool === "list_dir") return { kind: "search", path: args.DirectoryPath };
  return null;
}

export const antigravity = {
  name: "antigravity",
  supportsStop: true,
  validate(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "载荷必须是 JSON 对象";
    const tool = payload.toolCall?.name;
    if (typeof tool !== "string" || !tool) return "PreToolUse 载荷必须给出 toolCall.name";
    const args = payload.toolCall.args ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) return "toolCall.args 必须是 JSON 对象";
    if (!Array.isArray(payload.workspacePaths) || !payload.workspacePaths.some((path) => typeof path === "string" && path)) {
      return "PreToolUse 载荷必须给出 workspacePaths";
    }
    if (tool === "run_command" && typeof args.CommandLine !== "string") return "run_command 必须给出字符串 CommandLine";
    if (["write_to_file", "replace_file_content", "multi_replace_file_content"].includes(tool) && (typeof args.TargetFile !== "string" || !args.TargetFile)) {
      return `${tool} 必须给出 TargetFile`;
    }
    if (tool === "view_file" && (typeof args.AbsolutePath !== "string" || !args.AbsolutePath)) return "view_file 必须给出 AbsolutePath";
    return null;
  },
  context(payload) {
    const tool = payload?.toolCall?.name;
    const args = payload?.toolCall?.args ?? {};
    const workspace = workspaceFor(payload, args, tool);
    const base = workspace ?? process.cwd();
    const cwd = typeof args.Cwd === "string" && args.Cwd ? resolve(base, args.Cwd) : base;
    return { cwd, session_id: typeof payload?.conversationId === "string" ? payload.conversationId : undefined };
  },
  normalize(payload) {
    const tool = payload?.toolCall?.name;
    if (typeof tool !== "string") return null;
    const call = callOf(tool, payload.toolCall.args ?? {});
    return call ? { call, tool } : null;
  },
  formatAllow() {
    return { exitCode: 0, stdout: `${JSON.stringify({ decision: "allow" })}\n` };
  },
  formatDeny(text) {
    return { exitCode: 0, stdout: `${JSON.stringify({ decision: "deny", reason: text })}\n`, stderr: `${text}\n` };
  },
  formatError(text) {
    return this.formatDeny(`[harness] ${text}`);
  },
  skipStop(payload) {
    return payload?.fullyIdle === false;
  },
  formatStop(output) {
    if (output?.decision === "block") return { decision: "continue", reason: output.reason };
    return { decision: "stop", ...(output?.systemMessage ? { reason: output.systemMessage } : {}) };
  },
};
