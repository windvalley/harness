// Claude Code 的 PreToolUse 载荷：tool_name + tool_input。
// 拒绝时退出码 2，stderr 会作为反馈交给模型。
const WRITE = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function callOf(payload) {
  const tool = payload.tool_name;
  const input = payload.tool_input ?? {};
  if (tool === "Bash") return { call: { kind: "shell", command: String(input.command ?? "") }, tool };
  if (WRITE.has(tool)) {
    const path = input.file_path ?? input.notebook_path ?? input.path;
    const content = input.content ?? input.new_string ?? input.new_source;
    return { call: { kind: "write", path, content: typeof content === "string" ? content : undefined }, tool };
  }
  if (tool === "Read") return { call: { kind: "read", path: input.file_path }, tool };
  if (tool === "Grep") return { call: { kind: "search", path: input.path, glob: input.glob }, tool };
  return null;
}

export const claude = {
  name: "claude",
  normalize(payload) {
    if (!payload || typeof payload.tool_name !== "string") return null;
    return callOf(payload);
  },
  formatDeny(text) {
    return { exitCode: 2, stderr: `${text}\n` };
  },
};
