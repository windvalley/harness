import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCurrentProject, mainBranch } from "../lib/config.mjs";
import { git, mainWorktreeRoot, repoRoot } from "../lib/git.mjs";
import { keyStatus } from "../lib/store.mjs";
import { mainWorktreeProblems } from "../merge/merge.mjs";
import { commandExists, maxDiffChars, resolveBackend } from "../review/review.mjs";
import { resolvePolicy } from "../policy/resolve.mjs";
import { packageVersion, MARK_START } from "./managed.mjs";
import { leftoverWorktrees } from "../worktree/clean.mjs";
import {
  currentHooksConfig,
  gitHooksDir,
  HOOK_NAMES,
  hooksPathState,
  isHarnessClientHook,
  shimPath,
  verifyVersion,
  versionDir,
} from "./install.mjs";

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

/**
 * git 钩子是否就位。项目接管了钩子目录时，检查的是 git 实际执行的那一份：
 * core.hooksPath 必须指向主 Worktree 里的钩子目录，否则停在旧分支的 Worktree 会跳过钩子。
 */
function gitHookChecks(root) {
  const hooks = currentHooksConfig(root);
  if (!hooks) {
    const hooksDir = gitHooksDir(root);
    return HOOK_NAMES.map((name) => {
      const file = join(hooksDir, name);
      return { id: `git:${name}`, ok: hookInstalled(file), detail: hookInstalled(file) ? file : `${file} 未接入或未生效` };
    });
  }
  const state = hooksPathState({ root, hooks });
  const current = state.current ?? "(未设置)";
  const checks = [
    {
      id: "git:hooksPath",
      ok: state.state === "ok",
      detail:
        state.state === "ok"
          ? `core.hooksPath 指向主 Worktree 的 ${state.target}，所有 Worktree 执行这一份钩子`
          : state.state === "pending"
            ? `主 Worktree 里还没有生成的 ${hooks.hooksDir}，core.hooksPath 仍是 ${current}；接入分支合入主分支后由 harness merge 自动切换`
            : `core.hooksPath 是 ${current}，应为 ${state.target}；运行 harness install --local 修正，否则停在旧分支的 Worktree 不经过门禁`,
    },
  ];
  for (const name of HOOK_NAMES) {
    const file = join(state.target, name);
    checks.push({ id: `git:${name}`, ok: hookInstalled(file), detail: hookInstalled(file) ? file : `${file} 未生成，在主 Worktree 运行 harness install --local` });
  }
  if (hooks.projectHooks) {
    const present = HOOK_NAMES.filter((name) => existsSync(join(root, hooks.projectHooks, name)));
    const notExecutable = present.filter((name) => (statSync(join(root, hooks.projectHooks, name)).mode & 0o111) === 0);
    checks.push({
      id: "git:project-hooks",
      ok: notExecutable.length === 0,
      detail:
        notExecutable.length > 0
          ? `${hooks.projectHooks}/ 下 ${notExecutable.join("、")} 没有可执行权限，提交时会被拒绝；chmod +x 后提交`
          : present.length > 0
            ? `${hooks.projectHooks}/ 下的 ${present.join("、")} 在 harness 检查通过后执行，跟着当前 Worktree 的检出走`
            : `${hooks.projectHooks}/ 下没有项目钩子`,
    });
  }
  return checks;
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

  checks.push(...gitHookChecks(root));

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
      ? `插件目录已生成: ${dsh}；需在 DSH 中注册: dsh plugin --profile <desktop|web> add ${dsh}（桌面版用 desktop，浏览器版用 web）`
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
    const mainRoot = mainWorktreeRoot(root);
    const mainProblems = mainWorktreeProblems(project, mainRoot);
    checks.push({
      id: "main-worktree",
      ok: mainProblems.length === 0,
      detail:
        mainProblems.length === 0
          ? `${mainRoot} 停在 ${mainBranch(project)} 且洁净，可以接收合并`
          : `${mainProblems.join("；")}。主 Worktree 未就绪时所有任务的 harness merge 都会被拒绝`,
    });
    // 合并后不自动删除任务 Worktree，这里只报告堆积的数量，不算失败。
    const leftover = leftoverWorktrees({ root, mainRef: mainBranch(project) }).length;
    checks.push({
      id: "worktrees",
      ok: true,
      detail: `已合并但还没清理的 Worktree ${leftover} 个${leftover > 0 ? "，需要时运行 harness worktree clean 预览后清理" : ""}`,
    });
    if (project.config.merge?.requireReview !== false) {
      try {
        const reviewConfig = project.config.review ?? {};
        maxDiffChars(reviewConfig);
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
