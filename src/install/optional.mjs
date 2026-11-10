import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 升级时提示的可选项登记表。新增可选配置时在这里加一项，upgrade 才会提示。
 * path 是配置文件内的点号路径，没有这个路径才算未配置；when 缺省表示始终适用；since 是引入它的版本。
 */
export const OPTIONS = [
  { path: "risk", file: "config.json", since: "0.13.0", text: "risk（observe 只记录命中的敏感路径与依赖清单，不拦截；确认误报可接受后再改 enforce）" },
  { path: "testFirst", file: "verify.json", since: "0.13.0", text: "testFirst（observe 只记录改了实现却没有会先失败的测试，不拦截）" },
  { path: "coverage", file: "verify.json", since: "0.13.0", text: "coverage（observe 只记录改动行的覆盖率，不拦截）" },
  { path: "requiredPaths", file: "verify.json", since: "0.12.0", text: "requiredPaths（没有 observe 模式，配置后无检查覆盖的改动路径会直接拦截，按项目目录结构评估后再加）" },
  {
    path: "delivery.push",
    file: "config.json",
    since: "0.15.0",
    when: (config) => (config.delivery?.mode ?? "local") === "local",
    text: "delivery.push（仅本地交付；开启后 harness merge 合入时把核对过的提交推送到远程主分支，授予推送权限，没有 observe 模式，开启的那次合并不推送；不默认加，由用户决定）",
  },
];

function readJson(root, name) {
  const file = join(root, ".harness", name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function valueAt(object, path) {
  let current = object;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

/** 项目配置里还没出现的可选项；只读，读不出来的文件不报。 */
export function unconfiguredOptions(root) {
  const files = { "config.json": readJson(root, "config.json"), "verify.json": readJson(root, "verify.json") };
  return OPTIONS.filter((option) => {
    const config = files[option.file];
    if (!config || valueAt(config, option.path) !== undefined) return false;
    return option.when ? option.when(config) : true;
  }).map((option) => option.text);
}
