import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { samePath } from "../lib/git.mjs";
import { dshPluginDir } from "./install.mjs";

// 只检查桌面版与浏览器版用的两个 profile；用别的名称注册的插件两端都不会加载。
const PROFILES = ["desktop", "web"];
// 桌面版的 profile 只能由 App 管理，独立安装的 dsh 命令会拒绝；App 自带的命令行可以管理它。
const DESKTOP_CLI = "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";

/** DSH 的数据目录：先取 $DSH_HOME，否则 ~/.dsh，与 DSH 自己的解析一致。 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/** 依赖的写法解析成本地目录；注册表包名等非本地写法返回 null。pnpm 可能把本地路径记成相对 profile 或以 ~ 开头。 */
function localPath(spec, profileDir) {
  if (typeof spec !== "string") return null;
  const path = spec.replace(/^(?:file|link):/, "");
  if (path === spec && !isAbsolute(path) && !path.startsWith(".") && !path.startsWith("~")) return null;
  return resolve(profileDir, path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

/**
 * 已存在的 desktop、web 两个 profile 各自的注册状态：
 *   registered  本机插件已作为组合包启用
 *   disabled    装了本机插件但没有作为组合包启用，例如在插件页里关掉了
 *   other       启用的 harness-guard 指向别的目录，多半是旧版生成在项目里的插件
 *   none        没有注册
 *   unreadable  profile 的 package.json 读不出来
 */
export function dshRegistrations() {
  const plugin = dshPluginDir();
  const results = [];
  for (const profile of PROFILES) {
    const dir = join(dshHome(), "profiles", profile);
    const file = join(dir, "package.json");
    if (!existsSync(file)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      results.push({ profile, state: "unreadable", detail: error.message });
      continue;
    }
    const bundles = manifest?.dsh?.profile?.bundles ?? [];
    const deps = Object.entries(manifest?.dependencies ?? {}).map(([name, spec]) => ({ name, spec, path: localPath(spec, dir) }));
    const ours = deps.filter((dep) => dep.path && samePath(dep.path, plugin));
    if (ours.some((dep) => bundles.includes(dep.name))) {
      results.push({ profile, state: "registered" });
      continue;
    }
    const other = deps.find((dep) => dep.name === "harness-guard" && bundles.includes(dep.name));
    if (other) results.push({ profile, state: "other", detail: other.path ?? other.spec });
    else if (ours.length > 0) results.push({ profile, state: "disabled", detail: ours[0].name });
    else results.push({ profile, state: "none" });
  }
  return results;
}

/** 在某个 profile 注册本机插件的命令；桌面版要先完全退出，否则运行中的 App 仍用旧的组合。 */
export function dshRegisterCommand(profile) {
  if (profile !== "desktop") return `dsh plugin --profile ${profile} add ${dshPluginDir()}`;
  const bin = process.platform === "darwin" ? `"${DESKTOP_CLI}"` : "<桌面版自带的 dsh>";
  return `先完全退出桌面版，再运行 ${bin} plugin --profile desktop add ${dshPluginDir()}`;
}

/** 一个 profile 的状态说明，没有注册时附上注册命令。 */
export function describeRegistration(item) {
  switch (item.state) {
    case "registered":
      return `${item.profile} 已注册`;
    case "disabled":
      return `${item.profile} 装了本机插件（依赖名 ${item.detail}）但没有启用，在插件页里启用后重启 DeepSeek Harness`;
    case "other":
      return `${item.profile} 注册的是 ${item.detail}（旧版生成在项目里的插件或别的目录），改为注册本机插件: ${dshRegisterCommand(item.profile)}`;
    case "unreadable":
      return `${item.profile} 的 package.json 无法解析: ${item.detail}`;
    default:
      return `${item.profile} 未注册: ${dshRegisterCommand(item.profile)}`;
  }
}
