import { existsSync } from "node:fs";
import { join } from "node:path";
import { entryPaths } from "../lib/config.mjs";
import { matchAny } from "../lib/glob.mjs";
import { commandExists } from "../review/review.mjs";
import { codexTrustState } from "./doctor.mjs";
import { worktreeHooksConfig } from "./install.mjs";

/**
 * 客户端这一侧无法由 harness 代劳的动作，在接入或合并结束时集中列出，不靠人去记清单。
 * changed 是本次合入主分支的文件；bootstrap 表示首次接入。
 */
export function followUps({ mainRoot, changed = [], bootstrap = false, hooksDirBefore = null }) {
  const touched = (glob) => changed.some((path) => matchAny(path, [glob]));
  const notes = [];
  // core.hooksPath 存在各自机器的 .git/config 里，不随仓库分发：合并只切换了本机，其他机器要各自运行一次。
  const hooksDirAfter = worktreeHooksConfig(mainRoot)?.hooksDir ?? null;
  if (hooksDirAfter && hooksDirAfter !== hooksDirBefore) {
    notes.push(
      `git 钩子改由 ${hooksDirAfter} 提供：本机已切换；其他机器拉到新的主分支后各自运行 harness install --local，否则 core.hooksPath 仍指向旧目录，钩子会被跳过`,
    );
  }
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
    notes.push(`DeepSeek Harness 注册插件: dsh plugin --profile <desktop|web> add ${join(mainRoot, ".harness", "dsh-plugin")}（桌面版用 desktop，浏览器版用 web）`);
  }
  return notes;
}

export function entryTouched(changed, project = null) {
  return changed.some((path) => matchAny(path, entryPaths(project)));
}
