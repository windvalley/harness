// Codex CLI 的 PreToolUse 载荷与 Claude 同构：tool_name + tool_input。
// 拒绝优先用协议里的 permissionDecision，便于宿主展示原因；
// 同时也写到 stderr 并返回非零退出码，兼容只认退出码的版本。
const SHELL_TOOLS = new Set(["shell", "exec_command", "Bash", "local_shell"]);
const WRITE_TOOLS = new Set(["apply_patch", "write", "edit", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["read", "Read"]);

function patchContent(input) {
  for (const key of ["input", "patch", "content", "text"]) {
    if (typeof input?.[key] === "string") return input[key];
  }
  return undefined;
}

function patchPaths(text) {
  if (typeof text !== "string") return [];
  const paths = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
    if (match) paths.push(match[1].trim());
  }
  return paths;
}

export const codex = {
  name: "codex",
  normalize(payload) {
    const tool = payload?.tool_name;
    if (typeof tool !== "string") return null;
    const input = payload.tool_input ?? {};
    if (SHELL_TOOLS.has(tool)) {
      const command = input.command ?? input.cmd ?? input.script;
      return { call: { kind: "shell", command: String(command ?? "") }, tool };
    }
    if (WRITE_TOOLS.has(tool)) {
      const path = input.file_path ?? input.path;
      const content = input.content ?? input.new_string ?? patchContent(input);
      // apply_patch 一次可能改多个文件，逐个判，任一被拒即拒。
      const paths = path ? [path] : patchPaths(content);
      if (paths.length > 1) {
        return { call: { kind: "write", paths, path: paths[0], content }, tool };
      }
      return { call: { kind: "write", path: paths[0] ?? path, content }, tool };
    }
    if (READ_TOOLS.has(tool)) return { call: { kind: "read", path: input.file_path ?? input.path }, tool };
    if (tool === "grep" || tool === "Grep") return { call: { kind: "search", path: input.path, glob: input.glob }, tool };
    return null;
  },
  formatDeny(text) {
    const stdout = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: text,
      },
    });
    return { exitCode: 0, stdout: `${stdout}\n`, stderr: `${text}\n` };
  },
};
