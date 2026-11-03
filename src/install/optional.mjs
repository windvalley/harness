import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OPTIONS = [
  { key: "risk", file: "config.json", text: "risk（observe 只记录命中的敏感路径与依赖清单，不拦截；确认误报可接受后再改 enforce）" },
  { key: "testFirst", file: "verify.json", text: "testFirst（observe 只记录改了实现却没有会先失败的测试，不拦截）" },
  { key: "coverage", file: "verify.json", text: "coverage（observe 只记录改动行的覆盖率，不拦截）" },
  { key: "requiredPaths", file: "verify.json", text: "requiredPaths（没有 observe 模式，配置后无检查覆盖的改动路径会直接拦截，按项目目录结构评估后再加）" },
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

/** 项目配置里还没出现的可选项；只读，读不出来的文件不报。 */
export function unconfiguredOptions(root) {
  const files = { "config.json": readJson(root, "config.json"), "verify.json": readJson(root, "verify.json") };
  return OPTIONS.filter((option) => files[option.file] && files[option.file][option.key] === undefined).map((option) => option.text);
}
