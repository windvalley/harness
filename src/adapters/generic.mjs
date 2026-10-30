// 通用客户端：给没有内置适配器的编码 Agent 用。
// 客户端的钩子脚本把自己的工具调用转成下面的统一载荷，再调用 harness hook --client generic：
//   { "kind": "shell",  "command": "..." }
//   { "kind": "write",  "path": "...", "content": "..." }        content 可省略；一次改多个文件时可用 "paths": [...]
//   { "kind": "read",   "path": "..." }
//   { "kind": "search", "path": "...", "glob": "..." }           path、glob 可省略
// 可选 "cwd" 与 "session_id"，含义与 Claude Code 一致。拒绝时退出码 2，原因写到 stderr。
const KINDS = new Set(["shell", "write", "read", "search"]);

export const generic = {
  name: "generic",
  /** 载荷不合约定时返回原因；调用方按失败处理，不能当作放行。 */
  validate(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "载荷必须是 JSON 对象";
    if (!KINDS.has(payload.kind)) return `kind 必须是 ${[...KINDS].join("、")} 之一，当前是 ${JSON.stringify(payload.kind)}`;
    if (payload.kind === "shell" && typeof payload.command !== "string") return "shell 调用必须给出字符串 command";
    if (payload.kind === "write" || payload.kind === "read") {
      const paths = Array.isArray(payload.paths) ? payload.paths : [payload.path];
      if (paths.length === 0 || !paths.every((item) => typeof item === "string" && item)) return `${payload.kind} 调用必须给出 path（写入也可以给 paths 数组）`;
    }
    return null;
  },
  normalize(payload) {
    if (this.validate(payload)) return null;
    const tool = `generic:${payload.kind}`;
    const content = typeof payload.content === "string" ? payload.content : undefined;
    if (payload.kind === "shell") return { call: { kind: "shell", command: payload.command }, tool };
    if (payload.kind === "write") {
      const paths = Array.isArray(payload.paths) ? payload.paths : [payload.path];
      return paths.length > 1 ? { call: { kind: "write", paths, path: paths[0], content }, tool } : { call: { kind: "write", path: paths[0], content }, tool };
    }
    if (payload.kind === "read") return { call: { kind: "read", path: payload.path }, tool };
    return { call: { kind: "search", path: payload.path, glob: payload.glob }, tool };
  },
  formatDeny(text) {
    return { exitCode: 2, stderr: `${text}\n` };
  },
};
