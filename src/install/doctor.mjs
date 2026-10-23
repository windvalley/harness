import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCurrentProject, mainBranch } from "../lib/config.mjs";
import { git, repoRoot } from "../lib/git.mjs";
import { keyStatus } from "../lib/store.mjs";
import { commandExists, resolveBackend } from "../review/review.mjs";
import { resolvePolicy } from "../policy/resolve.mjs";
import { packageVersion, MARK_START } from "./managed.mjs";
import { gitHooksDir, isHarnessClientHook, shimPath, verifyVersion, versionDir } from "./install.mjs";

// 读取 Codex 用户配置里是否已有本项目钩子的 trusted_hash 记录。
// 路径要按真实路径比较：git 常返回 /private/var/...，用户配置里可能写成 /var/...，两者是同一目录。
export function codexTrustState(root) {
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

function hookInstalled(file) {
  return existsSync(file) && readFileSync(file, "utf8").includes("# harness:hook");
}

function clientHookInstalled(file) {
  if (!existsSync(file)) return false;
  try {
    const list = JSON.parse(readFileSync(file, "utf8"))?.hooks?.PreToolUse ?? [];
    return list.some((entry) => (entry.hooks ?? []).some((item) => isHarnessClientHook(item.command)));
  } catch {
    return false;
  }
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

  const key = keyStatus();
  checks.push({
    id: "key",
    ok: Boolean(key.exists && key.valid && key.private),
    detail: !key.exists
      ? `缺少证据密钥 ${key.file}，运行 harness install 生成`
      : !key.valid
        ? key.reason
        : key.private
          ? `证据密钥指纹 ${key.fingerprint}，权限仅本人可读`
          : `证据密钥 ${key.file} 其他用户可读，需要由人收紧为 600`,
  });

  const shim = shimPath(root);
  // 入口要入库，否则 Linked Worktree 检出后没有入口，客户端钩子与 git 钩子都失效。
  const shimTracked = existsSync(shim) && git(root, ["ls-files", "--error-unmatch", ".harness/bin/harness"]).status === 0;
  checks.push({
    id: "shim",
    ok: existsSync(shim) && shimTracked,
    detail: !existsSync(shim)
      ? "缺少 .harness/bin/harness，运行 harness install"
      : shimTracked
        ? `${shim}（已入库，Linked Worktree 直接可用）`
        : `${shim} 未入库：Linked Worktree 里没有入口，钩子和实时拦截都会失效，提交它`,
  });

  const hooksDir = gitHooksDir(root);
  for (const name of ["pre-commit", "commit-msg", "reference-transaction"]) {
    const file = join(hooksDir, name);
    checks.push({ id: `git:${name}`, ok: hookInstalled(file), detail: hookInstalled(file) ? file : `${file} 未接入或未生效` });
  }

  const claudeOk = clientHookInstalled(join(root, ".claude", "settings.json"));
  checks.push({
    id: "client:claude",
    ok: claudeOk,
    detail: claudeOk ? "PreToolUse 已接入（CLI 已验证；桌面版仅静态确认，未端到端实测）" : "未接入 Claude Code 的项目设置文件",
  });

  const codex = join(root, ".codex", "hooks.json");
  const codexOk = clientHookInstalled(codex);
  // Codex 要求钩子先被信任一次；信任记录写在工作目录的 config.toml 的 [hooks.state] 下。
  const codexTrusted = codexTrustState(root);
  checks.push({
    id: "client:codex",
    ok: codexOk && codexTrusted,
    verified: codexTrusted,
    detail: !codexOk
      ? "未接入 .codex/hooks.json"
      : codexTrusted
        ? "钩子已接入且已信任，拦截生效（CLI 与桌面版内置引擎均已实测）"
        : "钩子已接入但尚未信任：在 Codex 里运行 /hooks 批准一次，否则命令不会经过门禁",
  });

  // DSH 插件目录带本机绝对路径且不入库，只在跑过 install 的 Worktree 里存在；不装 DSH 的项目也不必生成，因此不算失败。
  const dsh = join(root, ".harness", "dsh-plugin");
  const dshOk = existsSync(join(dsh, "index.mjs"));
  checks.push({
    id: "client:dsh",
    ok: true,
    verified: dshOk,
    detail: dshOk
      ? `插件目录已生成: ${dsh}；需在 DSH 中注册: dsh plugin --profile <名称> add ${dsh}`
      : "未生成 DSH 插件目录；需要用 DeepSeek Harness 时在本 Worktree 运行 harness install",
  });

  const configOk = existsSync(join(root, ".harness", "config.json"));
  checks.push({ id: "project:config", ok: configOk, detail: configOk ? "项目配置存在" : "缺少 .harness/config.json" });

  const agents = join(root, "AGENTS.md");
  const agentsOk = existsSync(agents) && readFileSync(agents, "utf8").includes(MARK_START);
  checks.push({ id: "project:managed-block", ok: agentsOk, detail: agentsOk ? "AGENTS.md 托管块存在" : "AGENTS.md 缺少托管块" });

  try {
    const project = loadCurrentProject(root);
    const resolved = resolvePolicy(project.policy);
    const stats = { rules: resolved.rules.length, checks: project.verify.checks.length };
    const unknown = resolved.unknownDisabled;
    checks.push({
      id: "project:policy",
      ok: unknown.length === 0,
      detail: `${stats.rules} 条拦截规则，${stats.checks} 项验证检查` + (unknown.length ? `；disabled 里有未知规则 ${unknown.join(", ")}` : ""),
    });
    checks.push({
      id: "project:main",
      ok: true,
      detail: project.bootstrap
        ? `首次接入阶段：${mainBranch(project)} 上还没有配置，按当前工作区的配置自检；合入后以主分支为准`
        : `配置取自主分支 ${mainBranch(project)}`,
    });
    if (project.config.merge?.requireReview !== false) {
      try {
        const reviewConfig = project.config.review ?? {};
        const backend = resolveBackend(reviewConfig);
        const label = backend.name === "command" ? `command(${backend.argv[0]})` : backend.name;
        const how = (reviewConfig.backend ?? "auto") === "auto" ? "，由 auto 选中" : "";
        const bin = backend.bin ?? backend.argv[0];
        checks.push(
          commandExists(bin)
            ? { id: "review", ok: true, detail: `独立评审后端: ${label}${how}` }
            : { id: "review", ok: false, detail: `独立评审后端 ${label} 的命令 ${bin} 不在 PATH 里` },
        );
      } catch (error) {
        checks.push({ id: "review", ok: false, detail: error.message });
      }
    }
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
