import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadTrustedProject, mainBranch } from "../lib/config.mjs";
import { commonDir, git, repoRoot } from "../lib/git.mjs";
import { resolvePolicy } from "../policy/resolve.mjs";
import { packageVersion, MARK_START } from "./managed.mjs";
import { shimPath, verifyVersion, versionDir } from "./install.mjs";

// 读取 Codex 用户配置里是否已有本项目钩子的 trusted_hash 记录。
// 路径要按真实路径比较：git 常返回 /private/var/...，用户配置里可能写成 /var/...，两者是同一目录。
function codexTrustState(root) {
  const file = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  const candidates = new Set([root]);
  try {
    const real = realpathSync(root);
    candidates.add(real);
    // macOS 上 /var 与 /private/var 是同一目录的两种写法，两种都要比对。
    candidates.add(real.replace(/^\/private\//, "/"));
  } catch {
    // 软链接解析失败时只比对原始路径。
  }
  for (const candidate of candidates) {
    const marker = `[hooks.state."${candidate}/.codex/hooks.json`;
    const index = text.indexOf(marker);
    if (index < 0) continue;
    const section = text.slice(index, index + 800);
    if (/trusted_hash\s*=\s*"sha256:/.test(section)) return true;
  }
  return false;
}

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
  // Codex 要求钩子先被信任一次；信任记录写在工作目录的 config.toml 的 [hooks.state] 下。
  const codexTrusted = codexTrustState(root);
  checks.push({
    id: "client:codex",
    ok: codexOk && codexTrusted,
    verified: codexTrusted,
    detail: !codexOk
      ? "未接入 .codex/hooks.json"
      : codexTrusted
        ? "钩子已接入且已信任，拦截生效"
        : "钩子已接入但尚未信任：在 Codex 里运行 /hooks 批准一次，否则命令不会经过门禁",
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
