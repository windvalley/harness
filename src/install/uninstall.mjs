import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { markProjectBestEffort } from "../observability/projects.mjs";
import { homedir } from "node:os";
import { commonDir, git, repoRoot } from "../lib/git.mjs";
import { gitHooksDir, HOOK_NAMES, hooksPathState, isHarnessClientHook, stripHookBlock, worktreeHooksConfig } from "./install.mjs";
import { removeManagedBlock } from "./managed.mjs";
import { installLocation, pendingInstallState } from "./install-transaction.mjs";

const HOOK_MARK = "# harness:hook";
const CLIENT_FILES = [".claude/settings.json", ".codex/hooks.json"];
const CLIENT_EVENTS = ["PreToolUse", "Stop"];

function harnessEntries(list) {
  return Array.isArray(list) ? list.filter((entry) => (entry.hooks ?? [entry]).some((item) => isHarnessClientHook(item.command))) : [];
}

/** 纯函数式地算出要删的内容，dry-run 与真实执行共用同一份判断。 */
function plan({ root }) {
  const targets = [];

  // .harness/dsh-plugin 是旧版生成在项目里的 DSH 插件；本机共用的插件服务其他项目，卸载不删。
  for (const rel of [".harness/bin", ".harness/dsh-plugin"]) {
    if (existsSync(join(root, rel))) targets.push({ kind: "path", rel });
  }

  const hooksConfig = worktreeHooksConfig(root);
  const hooksDir = gitHooksDir(root, hooksConfig);
  // 接管模式下 core.hooksPath 指向主 Worktree 的钩子目录，钩子删掉后要一并撤销，否则 git 指向一个空目录。
  if (hooksConfig && hooksPathState({ root, hooks: hooksConfig }).state === "ok") {
    targets.push({ kind: "hooks-path", rel: `core.hooksPath（指向 ${hooksConfig.hooksDir}）` });
  }
  for (const name of HOOK_NAMES) {
    const file = join(hooksDir, name);
    if (existsSync(file) && readFileSync(file, "utf8").includes(HOOK_MARK)) {
      // 接管模式的钩子整份由 harness 生成（写入时拒绝覆盖其他内容），直接删除。
      const isEmpty = Boolean(hooksConfig) || stripHookBlock(readFileSync(file, "utf8")).trim() === "";
      targets.push({ kind: "hook", rel: `git 钩子 ${name}`, file, isEmpty });
    }
  }

  for (const rel of CLIENT_FILES) {
    const file = join(root, rel);
    if (!existsSync(file)) continue;
    let config;
    try {
      config = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (CLIENT_EVENTS.some((event) => harnessEntries(config?.hooks?.[event]).length > 0)) {
      targets.push({ kind: "client", rel: `${rel} 的 harness 钩子`, file, config });
    }
  }

  const rel = ".agents/hooks.json";
  const file = join(root, rel);
  if (existsSync(file)) {
    let config;
    try {
      config = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      config = null;
    }
    const found = Object.values(config ?? {}).some((group) => group && typeof group === "object" && CLIENT_EVENTS.some((event) => harnessEntries(group[event]).length > 0));
    if (found) targets.push({ kind: "antigravity", rel: `${rel} 的 harness 钩子`, file, config });
  }

  const codexConfig = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  if (existsSync(codexConfig) && readFileSync(codexConfig, "utf8").includes(`[hooks.state."${root}/.codex/hooks.json`)) {
    targets.push({ kind: "codex-trust", rel: "Codex 的钩子信任记录", file: codexConfig, root });
  }

  const agents = join(root, "AGENTS.md");
  if (existsSync(agents) && readFileSync(agents, "utf8").includes("<!-- harness:start -->")) {
    targets.push({ kind: "agents", rel: "AGENTS.md 的托管块" });
  }

  return targets;
}

function applyOne(target, root) {
  switch (target.kind) {
    case "path":
      rmSync(join(root, target.rel), { recursive: true, force: true });
      return;
    case "hook": {
      // 钩子文件本身由项目维护时只摘掉 harness 块；整份都是 harness 写的才删除。
      if (target.isEmpty) {
        rmSync(target.file, { force: true });
        return;
      }
      const before = stripHookBlock(readFileSync(target.file, "utf8")).replace(/\n+$/, "");
      writeFileSync(target.file, `${before}\n`);
      return;
    }
    case "client": {
      const config = target.config;
      for (const event of CLIENT_EVENTS) {
        const list = config.hooks[event];
        if (!Array.isArray(list)) continue;
        const kept = list.filter((entry) => !harnessEntries([entry]).length);
        if (kept.length === 0) delete config.hooks[event];
        else config.hooks[event] = kept;
      }
      if (Object.keys(config.hooks).length === 0) delete config.hooks;
      if (Object.keys(config).length === 0) rmSync(target.file, { force: true });
      else writeFileSync(target.file, `${JSON.stringify(config, null, 2)}\n`);
      return;
    }
    case "antigravity": {
      const config = target.config;
      for (const [name, group] of Object.entries(config)) {
        if (!group || typeof group !== "object" || Array.isArray(group)) continue;
        let touched = false;
        for (const event of CLIENT_EVENTS) {
          const list = group[event];
          if (!Array.isArray(list)) continue;
          const kept = list.filter((entry) => !harnessEntries([entry]).length);
          touched ||= kept.length !== list.length;
          if (kept.length === 0) delete group[event];
          else group[event] = kept;
        }
        if (touched && Object.keys(group).every((key) => key === "enabled")) delete config[name];
      }
      if (Object.keys(config).length === 0) rmSync(target.file, { force: true });
      else writeFileSync(target.file, `${JSON.stringify(config, null, 2)}\n`);
      return;
    }
    case "codex-trust": {
      // 每个钩子各有一段信任记录（PreToolUse 与 Stop 各一段），逐段删掉。
      const marker = `[hooks.state."${target.root}/.codex/hooks.json`;
      let text = readFileSync(target.file, "utf8");
      for (let index = text.indexOf(marker); index >= 0; index = text.indexOf(marker)) {
        const nextHeader = text.slice(index + 1).search(/\n\[/);
        const end = nextHeader < 0 ? text.length : index + 1 + nextHeader;
        text = `${text.slice(0, index).replace(/\n+$/, "")}\n${text.slice(end).replace(/^\n+/, "")}`;
      }
      writeFileSync(target.file, text);
      return;
    }
    case "agents":
      removeManagedBlock({ root });
      return;
    case "hooks-path":
      git(root, ["config", "--file", join(commonDir(root), "config"), "--unset", "core.hooksPath"]);
      return;
    default:
      return;
  }
}

/**
 * 解除接入。默认保留项目自己的配置与用例，只删生成物。
 * purge=true 时连 .harness/ 一起删除。
 */
export function uninstall({ cwd = process.cwd(), purge = false, dryRun = false } = {}) {
  const root = repoRoot(cwd);
  // 待恢复记录指向的是安装前的原件：先删生成物会让恢复永远无法完成，先恢复再卸载。
  const pending = pendingInstallState(installLocation(commonDir(root)));
  const blocked = pending?.status === "stale" ? `存在待恢复的安装，先运行 harness install --recover 完成回滚，再卸载；记录损坏或不需要回滚时用 harness install --recover --abandon` :
    pending?.status === "active" ? `另一个安装正在进行（${pending.holders.map((item) => `pid ${item.pid}`).join("、")}），完成后再卸载` :
    pending?.status === "invalid" ? `${pending.detail}。核对后可用 harness install --recover --abandon 归档` : null;
  if (blocked && !dryRun) throw new Error(blocked);
  const targets = plan({ root });
  if (!dryRun) {
    for (const target of targets) applyOne(target, root);
    markProjectBestEffort(root, "uninstalled");
  }

  const removed = targets.map((target) => target.rel);
  const kept = [];
  if (purge) {
    if (existsSync(join(root, ".harness"))) {
      removed.push(".harness");
      if (!dryRun) rmSync(join(root, ".harness"), { recursive: true, force: true });
    }
  } else if (existsSync(join(root, ".harness"))) {
    kept.push(".harness/（配置、规则、黄金任务、验收清单）");
  }
  kept.push("已安装的版本目录（全局共享，卸载本仓不影响其他项目）");

  return { root, removed, kept, dryRun, warning: blocked };
}
