import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { commonDir, git, repoRoot } from "../lib/git.mjs";
import { removeManagedBlock } from "./managed.mjs";

const HOOK_MARK = "# harness:hook";
const CLIENT_MARKERS = [
  [".claude/settings.json", "claude-hook.mjs"],
  [".codex/hooks.json", "codex-hook.mjs"],
];

function gitHooksDir(root) {
  const hooksPath = git(root, ["config", "--get", "core.hooksPath"]).stdout.trim();
  return hooksPath ? join(root, hooksPath) : join(commonDir(root), "hooks");
}

/** 纯函数式地算出要删的内容，dry-run 与真实执行共用同一份判断。 */
function plan({ root }) {
  const targets = [];

  for (const rel of [".harness/bin", ".harness/dsh-plugin"]) {
    if (existsSync(join(root, rel))) targets.push({ kind: "path", rel });
  }

  const hooksDir = gitHooksDir(root);
  for (const name of ["pre-commit", "commit-msg", "reference-transaction"]) {
    const file = join(hooksDir, name);
    if (existsSync(file) && readFileSync(file, "utf8").includes(HOOK_MARK)) {
      targets.push({ kind: "hook", rel: `git 钩子 ${name}`, file });
    }
  }

  for (const [rel, marker] of CLIENT_MARKERS) {
    const file = join(root, rel);
    if (!existsSync(file)) continue;
    let config;
    try {
      config = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const list = config?.hooks?.PreToolUse;
    if (!Array.isArray(list)) continue;
    if (list.some((entry) => (entry.hooks ?? []).some((item) => String(item.command ?? "").includes(marker)))) {
      targets.push({ kind: "client", rel: `${rel} 的 harness 钩子`, file, marker, config });
    }
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
      const text = readFileSync(target.file, "utf8");
      const before = text.slice(0, text.indexOf(HOOK_MARK)).replace(/\n+$/, "");
      writeFileSync(target.file, before ? `${before}\n` : "#!/bin/sh\n");
      return;
    }
    case "client": {
      const config = target.config;
      const kept = config.hooks.PreToolUse.filter(
        (entry) => !(entry.hooks ?? []).some((item) => String(item.command ?? "").includes(target.marker)),
      );
      if (kept.length === 0) delete config.hooks.PreToolUse;
      else config.hooks.PreToolUse = kept;
      if (Object.keys(config.hooks).length === 0) delete config.hooks;
      if (Object.keys(config).length === 0) rmSync(target.file, { force: true });
      else writeFileSync(target.file, `${JSON.stringify(config, null, 2)}\n`);
      return;
    }
    case "codex-trust": {
      const text = readFileSync(target.file, "utf8");
      const index = text.indexOf(`[hooks.state."${target.root}/.codex/hooks.json`);
      const rest = text.slice(index);
      const nextHeader = rest.slice(1).search(/\n\[/);
      const end = nextHeader < 0 ? text.length : index + 1 + nextHeader;
      writeFileSync(target.file, `${text.slice(0, index).replace(/\n+$/, "")}\n${text.slice(end).replace(/^\n+/, "")}`);
      return;
    }
    case "agents":
      removeManagedBlock({ root });
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
  const targets = plan({ root });
  if (!dryRun) for (const target of targets) applyOne(target, root);

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

  return { root, removed, kept, dryRun };
}
