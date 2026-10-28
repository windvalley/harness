// DeepSeek Harness 守卫插件（Cordis）。本机只有一份，每个 profile 注册一次，所有项目共用。
// 宿主的 tools/pre-execute 是 waterfall：这里返回 {kind:'deny', reason} 即拦下，
// 返回 next() 表示交给后续插件与工具执行，不会放行被其他插件拒绝的调用。
// 插件只做转发：按会话所在仓库的入口锁定的版本导入那个版本的门禁代码，与 Claude Code、Codex 经入口执行的版本一致。
// 这份文件会被之后运行的更新版本的 harness 覆盖，保持精简，只依赖各版本都有的 guard 与 dsh 两个导出。
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 版本目录的绝对路径，由 harness install 生成插件时写入。
const STORE = "@@HARNESS_STORE@@";
const VERSION = /^\d+\.\d+\.\d+$/;
const INSTALL_HINT = "请用户在自己的终端于项目目录运行 node <harness 仓库>/bin/harness.mjs install --local";

export const name = "harness-guard";
export const inject = ["tools", "workingDirectory"];

function workingDirectory(ctx, agent, signal) {
  try {
    return ctx.workingDirectory ? ctx.workingDirectory.ensure(agent, signal) : undefined;
  } catch {
    return undefined;
  }
}

// 会话所在仓库的根目录；不是 Git 仓库返回 null，git 无法执行时抛错，按失败关闭处理。
function repoRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  if (result.error) throw new Error(`无法执行 git: ${result.error.message}`);
  if (result.status === 0) return result.stdout.trim();
  if (result.status === 128 && result.stderr.startsWith("fatal: not a git repository ")) return null;
  throw new Error(`git rev-parse --show-toplevel 失败(${result.status}): ${result.stderr.trim()}`);
}

// 入口锁定的版本，与 Claude Code、Codex 的钩子经过的入口一致；入口有 gate-self 规则保护。没有入口时返回 null。
function pinnedVersion(root) {
  const shim = join(root, ".harness", "bin", "harness");
  if (!existsSync(shim)) return null;
  return readFileSync(shim, "utf8").match(/:-([0-9][^}"]*)\}/)?.[1] ?? null;
}

// 没有入口的仓库（未接入，或停在接入之前的分支）用本机最新的版本判定：未接入的放行，主分支已有配置的照常拦截。
function newestVersion() {
  let names;
  try {
    names = readdirSync(STORE);
  } catch {
    return null;
  }
  return names.filter((item) => VERSION.test(item)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) ?? null;
}

/** 返回拒绝原因，放行时返回 null。 */
async function decide(ctx, exec) {
  let cwd;
  try {
    cwd = await workingDirectory(ctx, exec.agent, exec.signal);
  } catch {
    cwd = undefined;
  }
  if (!cwd) return "门禁无法确定会话工作目录";
  let root;
  try {
    root = repoRoot(cwd);
  } catch (error) {
    return `门禁无法加载项目配置: ${error.message}`;
  }
  if (!root) return null;
  const pinned = pinnedVersion(root);
  if (pinned !== null && !VERSION.test(pinned)) return `门禁入口锁定的版本号无法识别: ${pinned}`;
  const version = pinned ?? newestVersion();
  if (!version) return `本机没有安装 harness 门禁代码。${INSTALL_HINT}`;
  const adapters = join(STORE, version, "src", "adapters");
  if (!existsSync(join(adapters, "index.mjs")) || !existsSync(join(adapters, "dsh.mjs"))) {
    return `本机没有安装门禁${pinned ? "锁定的" : ""}版本 ${version}。${INSTALL_HINT}`;
  }
  const { guard } = await import(pathToFileURL(join(adapters, "index.mjs")).href);
  const { dsh } = await import(pathToFileURL(join(adapters, "dsh.mjs")).href);
  const outcome = guard({ adapter: dsh, payload: { name: exec.name, arguments: exec.arguments, cwd } });
  if (outcome.decision === "deny") return outcome.result.reason;
  if (outcome.decision === "error") return `门禁无法加载项目配置: ${outcome.message}`;
  return null;
}

export function apply(ctx) {
  ctx.on("tools/pre-execute", async (exec, next) => {
    let reason;
    try {
      reason = await decide(ctx, exec);
    } catch (error) {
      reason = `门禁执行出错: ${error.message}`;
    }
    return reason ? { kind: "deny", reason: `[harness] ${reason}` } : next();
  });
}
