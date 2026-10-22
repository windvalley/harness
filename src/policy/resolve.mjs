import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function presetDir() {
  return join(PACKAGE_ROOT, "assets", "presets");
}

export function loadPreset(id) {
  const file = join(presetDir(), `${id}.json`);
  if (!existsSync(file)) throw new Error(`未知预设 ${id}，可选值见 assets/presets/`);
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * 把项目策略里的 presets 展开成完整规则集。
 * 规则顺序：预设按声明顺序在前，项目自有规则在后；同 id 的项目规则覆盖预设。
 * disabled 按规则 id 关闭，用于项目确认不需要某个默认禁令。
 */
export function resolvePolicy(policy) {
  const presets = policy.presets ?? [];
  const disabled = new Set(policy.disabled ?? []);
  const rules = [];
  const seen = new Set();

  for (const id of presets) {
    const preset = loadPreset(id);
    for (const rule of preset.rules) {
      if (disabled.has(rule.id)) continue;
      rules.push({ ...rule, preset: id });
      seen.add(rule.id);
    }
  }

  for (const rule of policy.rules ?? []) {
    if (disabled.has(rule.id)) continue;
    const index = rules.findIndex((item) => item.id === rule.id);
    if (index >= 0) rules[index] = { ...rule, preset: rules[index].preset };
    else rules.push({ ...rule, preset: null });
    seen.add(rule.id);
  }

  const unknownDisabled = [...disabled].filter((id) => !seen.has(id));
  return { rules, presets, unknownDisabled };
}

export function ruleStats(resolved) {
  const byKind = {};
  for (const rule of resolved.rules) byKind[rule.kind] = (byKind[rule.kind] ?? 0) + 1;
  return { total: resolved.rules.length, byKind, presets: resolved.presets };
}
