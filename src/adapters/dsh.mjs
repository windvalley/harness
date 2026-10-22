// DeepSeek Harness 的 Cordis 工具管线：exec.name + exec.arguments。
// 插件通过 ctx.tools.guard(fn) 注册，返回字符串即拒绝，返回 undefined 放行。
// 这里的 normalize 同时供守卫插件与 `harness hook --client dsh` 复用。
const SHELL = new Set(["bash", "pwsh", "shell"]);
const WRITE = new Set(["write", "edit"]);
const READ = new Set(["read", "read_image"]);
const SEARCH = new Set(["grep", "glob", "search"]);

function callOf(name, args = {}) {
  if (SHELL.has(name)) return { kind: "shell", command: String(args.command ?? "") };
  if (WRITE.has(name)) {
    const content = args.content ?? args.new_string;
    return {
      kind: "write",
      path: args.file_path ?? args.path,
      content: typeof content === "string" ? content : undefined,
    };
  }
  if (READ.has(name)) return { kind: "read", path: args.file_path ?? args.path };
  if (SEARCH.has(name)) return { kind: "search", path: args.path, glob: args.glob };
  return null;
}

export const dsh = {
  name: "dsh",
  normalize(payload) {
    // 守卫插件直接传 { name, arguments }，CLI 入口传 { tool_name, tool_input }。
    const tool = payload?.name ?? payload?.tool_name;
    if (typeof tool !== "string") return null;
    const args = payload?.arguments ?? payload?.tool_input ?? {};
    const call = callOf(tool, args);
    return call ? { call, tool } : null;
  },
  formatDeny(text) {
    return { exitCode: 2, stderr: `${text}\n`, decision: { kind: "deny", reason: text } };
  },
};
