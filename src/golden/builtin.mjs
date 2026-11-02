import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assetPath } from "../install/managed.mjs";

export function builtinTasks() {
  return JSON.parse(readFileSync(assetPath("golden/builtin.json"), "utf8")).tasks ?? [];
}

/**
 * 合并内置用例与项目用例。
 * 内置用例随版本走；项目里同 id 的用例整条覆盖内置，disableBuiltin 列出的内置用例停用。
 * 返回的每一项带 origin：builtin、override、project、disabled。
 */
export function resolveGolden(projectGolden) {
  const own = new Map((projectGolden.tasks ?? []).map((task) => [task.id, task]));
  const disabled = new Set(projectGolden.disableBuiltin ?? []);
  const items = [];
  const builtinIds = new Set();
  for (const task of builtinTasks()) {
    builtinIds.add(task.id);
    if (disabled.has(task.id)) items.push({ task, origin: "disabled" });
    else if (own.has(task.id)) items.push({ task: own.get(task.id), origin: "override" });
    else items.push({ task, origin: "builtin" });
  }
  for (const task of projectGolden.tasks ?? []) if (!builtinIds.has(task.id)) items.push({ task, origin: "project" });
  return items;
}

/**
 * 升级时清理项目里与当前内置用例完全相同的旧副本：它们没有任何自定义内容，留着会盖住以后的内置更新。
 * 与内置不同的同 id 用例不动，交给人决定是自己的改动还是过期副本。
 */
export function pruneBuiltinCopies(root) {
  const file = join(root, ".harness", "golden", "tasks.json");
  if (!existsSync(file)) return { removed: [], overrides: [] };
  const golden = JSON.parse(readFileSync(file, "utf8"));
  const builtin = new Map(builtinTasks().map((task) => [task.id, task]));
  const removed = [];
  const overrides = [];
  const kept = [];
  for (const task of golden.tasks ?? []) {
    const base = builtin.get(task.id);
    if (base && isDeepStrictEqual(base, task)) removed.push(task.id);
    else {
      kept.push(task);
      if (base) overrides.push(task.id);
    }
  }
  if (removed.length > 0) writeFileSync(file, `${JSON.stringify({ ...golden, tasks: kept }, null, 2)}\n`);
  return { removed, overrides };
}
