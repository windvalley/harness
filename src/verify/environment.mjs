import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// 依赖目录里记录“装了什么”的清单文件，内容变了说明依赖被重装或升降级过。
const INSTALL_MANIFESTS = [".package-lock.json", ".modules.yaml", ".yarn-state.yml", ".yarn-integrity"];
const VERSION_ARGS = { go: ["version"] };
const VERSIONED_TOOLS = new Set(["node", "npm", "npx", "pnpm", "yarn", "bun", "go", "python", "python3", "cargo"]);
const NODE_BASED = new Set(["npm", "npx", "pnpm", "yarn"]);
const MAX_ENTRIES = 5000;

const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** 依赖目录的安装状态：清单文件内容加顶层条目的名字与修改时间，不递归，几千个包也只是一次目录遍历。 */
export function dependencyState(dir) {
  if (!existsSync(dir)) return "missing";
  const parts = [];
  for (const name of INSTALL_MANIFESTS) {
    try {
      parts.push(`${name}:${sha(readFileSync(join(dir, name)))}`);
    } catch {
      // 没有这个清单就不参与
    }
  }
  try {
    // 点开头的目录是缓存之类，工具运行时会改写，算进去指纹会不停变动。
    for (const name of readdirSync(dir).filter((entry) => !entry.startsWith(".")).sort().slice(0, MAX_ENTRIES)) {
      const stat = lstatSync(join(dir, name));
      parts.push(`${name}:${Math.round(stat.mtimeMs)}:${stat.size}`);
    }
  } catch {
    parts.push("unreadable");
  }
  return sha(parts.join("\n"));
}

function toolVersion(tool, { cwd, env, cache }) {
  const key = tool;
  if (cache.has(key)) return cache.get(key);
  const outcome = spawnSync(tool, VERSION_ARGS[tool] ?? ["--version"], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const text = outcome.error || outcome.status !== 0 ? "unavailable" : `${outcome.stdout}${outcome.stderr}`.trim().split("\n")[0];
  cache.set(key, text);
  return text;
}

/**
 * 每项检查的运行环境指纹：命令用到的工具链版本与 requires 依赖目录的安装状态。
 * 固定检出只绑定了代码，依赖是从主 Worktree 软链进来的，它们变了而代码没变时，旧的通过结果不再可信。
 * items 是 { id, tool, requires }，tool 是命令的可执行名（没有就传 null）。
 */
export function environmentDigests({ items, mainRoot, cwd, env = {} }) {
  const cache = new Map();
  const result = new Map();
  for (const item of items) {
    const parts = [];
    if (item.tool && VERSIONED_TOOLS.has(item.tool)) {
      parts.push(`${item.tool}=${toolVersion(item.tool, { cwd, env, cache })}`);
      if (NODE_BASED.has(item.tool)) parts.push(`node=${toolVersion("node", { cwd, env, cache })}`);
    }
    for (const rel of item.requires ?? []) parts.push(`${rel}=${dependencyState(join(mainRoot, rel))}`);
    result.set(item.id, sha(parts.join("\n")));
  }
  return result;
}

/** 配置里的检查转成 environmentDigests 的输入：go-packages 选择器实际执行 go。 */
export function environmentItems(checks) {
  return checks.map((check) => ({
    id: check.id,
    tool: Array.isArray(check.cmd) ? check.cmd[0] : check.selector === "go-packages" ? "go" : null,
    requires: check.requires ?? [],
  }));
}
