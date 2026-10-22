import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadTrustedProject, mainBranch } from "../lib/config.mjs";
import { commonDir, git, repoRoot } from "../lib/git.mjs";
import { resolvePolicy } from "../policy/resolve.mjs";
import { packageVersion, MARK_START } from "./managed.mjs";
import { shimPath, verifyVersion, versionDir } from "./install.mjs";

function gitHooksDir(root) {
  const hooksPath = git(root, ["config", "--get", "core.hooksPath"]).stdout.trim();
  return hooksPath ? join(root, hooksPath) : join(commonDir(root), "hooks");
}

function hookInstalled(file) {
  return existsSync(file) && readFileSync(file, "utf8").includes("# harness:hook");
}

/**
 * 逐客户端检查安装状态。
 * codex 的钩子是否需要宿主信任，由宿主自己决定；这里只报“文件已就位、执行未验证”，
 * 不把没验证过的接入算成通过。
 */
export function doctor({ cwd = process.cwd() } = {}) {
  const root = repoRoot(cwd);
  const checks = [];

  const version = packageVersion();
  const store = versionDir(version);
  const integrity = verifyVersion({ version });
  checks.push({
    id: "store",
    ok: integrity.ok,
    detail: integrity.ok ? `版本 ${version} 已安装(${integrity.files} 个文件)，内容与清单一致` : integrity.reason,
  });

  const shim = shimPath(root);
  checks.push({ id: "shim", ok: existsSync(shim), detail: existsSync(shim) ? shim : "缺少 .harness/bin/harness" });

  const hooksDir = gitHooksDir(root);
  for (const name of ["pre-commit", "commit-msg", "reference-transaction"]) {
    const file = join(hooksDir, name);
    checks.push({ id: `git:${name}`, ok: hookInstalled(file), detail: hookInstalled(file) ? file : `${file} 未接入或未生效` });
  }

  const claude = join(root, ".claude", "settings.json");
  const claudeOk = existsSync(claude) && readFileSync(claude, "utf8").includes("claude-hook.mjs");
  checks.push({ id: "client:claude", ok: claudeOk, detail: claudeOk ? "PreToolUse 已接入" : "未接入 .claude/settings.json" });

  const codex = join(root, ".codex", "hooks.json");
  const codexOk = existsSync(codex) && readFileSync(codex, "utf8").includes("codex-hook.mjs");
  checks.push({
    id: "client:codex",
    ok: codexOk,
    verified: false,
    detail: codexOk ? "钩子文件已就位；Codex 需在宿主要求时批准项目钩子，执行路径尚未实测" : "未接入 .codex/hooks.json",
  });

  const dsh = join(root, ".harness", "dsh-plugin");
  const dshOk = existsSync(join(dsh, "index.mjs"));
  checks.push({
    id: "client:dsh",
    ok: dshOk,
    verified: false,
    detail: dshOk
      ? `插件目录已生成: ${dsh}；需在 DSH 中注册: dsh plugin --profile <名称> add ${dsh}`
      : "未生成 DSH 插件目录",
  });

  const configOk = existsSync(join(root, ".harness", "config.json"));
  checks.push({ id: "project:config", ok: configOk, detail: configOk ? "项目配置存在" : "缺少 .harness/config.json" });

  const agents = join(root, "AGENTS.md");
  const agentsOk = existsSync(agents) && readFileSync(agents, "utf8").includes(MARK_START);
  checks.push({ id: "project:managed-block", ok: agentsOk, detail: agentsOk ? "AGENTS.md 托管块存在" : "AGENTS.md 缺少托管块" });

  try {
    const project = loadTrustedProject(root);
    const resolved = resolvePolicy(project.policy);
    const stats = { rules: resolved.rules.length, checks: project.verify.checks.length };
    const unknown = resolved.unknownDisabled;
    checks.push({
      id: "project:policy",
      ok: unknown.length === 0,
      detail: `${stats.rules} 条拦截规则，${stats.checks} 项验证检查` + (unknown.length ? `；disabled 里有未知规则 ${unknown.join(", ")}` : ""),
    });
    checks.push({ id: "project:main", ok: true, detail: `主分支配置来源: ${mainBranch(project)}` });
  } catch (error) {
    checks.push({ id: "project:policy", ok: false, detail: error.message });
  }

  return { root, version, store, checks, ok: checks.every((check) => check.ok) };
}

export function formatDoctor(report) {
  const lines = [`harness ${report.version}  ${report.ok ? "自检通过" : "自检发现问题"}`];
  for (const check of report.checks) {
    const mark = check.ok ? (check.verified === false ? "?" : "ok") : "!!";
    lines.push(`  [${mark}] ${check.id}: ${check.detail}`);
  }
  lines.push("说明: [?] 表示文件已就位但客户端会否真正调用尚未实测");
  return lines.join("\n");
}
