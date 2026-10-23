import { existsSync } from "node:fs";
import { join } from "node:path";
import { ENTRY_FILES } from "../lib/config.mjs";
import { matchAny } from "../lib/glob.mjs";
import { commandExists } from "../review/review.mjs";
import { codexTrustState } from "./doctor.mjs";

/**
 * 客户端这一侧无法由 harness 代劳的动作，在接入或合并结束时集中列出，不靠人去记清单。
 * changed 是本次合入主分支的文件；bootstrap 表示首次接入。
 */
export function followUps({ mainRoot, changed = [], bootstrap = false }) {
  const touched = (glob) => changed.some((path) => matchAny(path, [glob]));
  const notes = [];
  if (bootstrap || touched(".claude/settings.json")) {
    notes.push("重启正在运行的 Claude Code 会话：钩子在会话启动时读入，运行中的会话不会换用新钩子");
  }
  if (existsSync(join(mainRoot, ".codex", "hooks.json"))) {
    if (!codexTrustState(mainRoot)) {
      notes.push(`在 Codex 里打开 ${mainRoot}，运行 /hooks，进入 Review hooks 后按 t 信任；Codex 按路径记录信任，其他 Worktree 首次使用时同样要信任一次`);
    } else if (touched(".codex/hooks.json")) {
      notes.push("Codex 钩子内容变了，原有信任随内容失效，在 Codex 里运行 /hooks 重新信任");
    }
  }
  if (bootstrap && commandExists("dsh") && existsSync(join(mainRoot, ".harness", "dsh-plugin", "index.mjs"))) {
    notes.push(`DeepSeek Harness 注册插件: dsh plugin --profile <名称> add ${join(mainRoot, ".harness", "dsh-plugin")}`);
  }
  return notes;
}

export function entryTouched(changed) {
  return changed.some((path) => matchAny(path, ENTRY_FILES));
}
