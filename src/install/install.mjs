import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PACKAGE_ROOT } from "../policy/resolve.mjs";
import { commonDir, git, hooksPlacement, mainWorktreeRoot, repoRoot, samePath, showBlob } from "../lib/git.mjs";
import { gitHooksConfig, loadCurrentProject, trustedMainRef } from "../lib/config.mjs";
import { keyPath, keyStatus, loadKey } from "../lib/store.mjs";
import { MANAGED_MANIFEST, managedConflictError, packageVersion, planManagedRules } from "./managed.mjs";
import { installVersion, isVersion, planVersionInstall, readVersionPin, storeRoot, versionDir } from "./version-store.mjs";
import { planGitignore, SHIM_REL, verifyShimIgnore } from "./install-ignore.mjs";
import { withInstallLock } from "./install-lock.mjs";
import { inspectDirectory, statIfPresent } from "./install-paths.mjs";
import {
  applyProjectChanges, createProjectChanges, HOOK_NAMES, installCheckout, installLocation, parseInstallJson,
  pendingInstall, readRegularText, replaceInstallFile, validateProjectInstall, withProjectInstallLock,
} from "./install-transaction.mjs";

export { installVersion, listVersions, pruneVersions, publishVersion, storeEntry, storeRoot, verifyVersion, versionDir } from "./version-store.mjs";
export { HOOK_NAMES } from "./install-transaction.mjs";

export function shimPath(root) {
  return join(root, ".harness", "bin", "harness");
}

/**
 * 入口 shim 只依赖 $HOME 与固定版本号，因此可以入库：
 * 每个 Linked Worktree 检出后立刻可用，不用在每棵树里各跑一次 install。
 * 本机没有装这个版本时退出码固定为 3，git 钩子据此区分“没装”与“被拦截”。
 */
export const SHIM_MISSING_VERSION = 3;

export function shimBody(version = packageVersion()) {
  return `#!/bin/sh
# harness 入口 shim，由 harness install 生成，入库随仓库分发，请勿手工修改。
# 代码在用户目录按版本安装；这里只负责转发，并锁住版本，避免任务分支改代码影响门禁。
HARNESS_VERSION="\${HARNESS_VERSION:-${version}}"
HARNESS_STORE="\${HARNESS_STORE:-$HOME/.local/share/harness/versions}"
entry="$HARNESS_STORE/$HARNESS_VERSION/bin/harness.mjs"
if [ ! -f "$entry" ]; then
  msg="[harness] 本机没有安装门禁锁定的版本 $HARNESS_VERSION。请用户在自己的终端（Claude Code 里可在输入框用 ! 前缀）于项目目录运行 node <harness 仓库>/bin/harness.mjs install --local"
  # 实时拦截在未安装时一律拒绝：放行等于门禁不存在。Claude 以退出码 2 拒绝，Codex 与 Antigravity 读各自的 JSON 判定。
  if [ "$1" = "hook" ]; then
    # 收尾检查只提示不拦：拦下会让会话停不下来。
    if [ "$4" = "--event" ] && [ "$5" = "stop" ]; then
      if [ "$3" = "antigravity" ]; then
        printf '{"decision":"stop","reason":"%s"}\\n' "$msg"
      else
        printf '%s\\n' "$msg" >&2
      fi
      exit 0
    fi
    if [ "$3" = "codex" ]; then
      printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n' "$msg"
      exit 0
    fi
    if [ "$3" = "antigravity" ]; then
      printf '{"decision":"deny","reason":"%s"}\\n' "$msg"
      exit 0
    fi
    printf '%s\\n' "$msg" >&2
    exit 2
  fi
  printf '%s\\n' "$msg" >&2
  exit ${SHIM_MISSING_VERSION}
fi
exec node "$entry" "$@"
`;
}

const HOOK_MARK = "# harness:hook";
const HOOK_END = "# harness:hook-end";

/** hooks 是 gitHooksConfig 的结果；为 null 时按 core.hooksPath 或 .git/hooks 定位。 */
export function gitHooksDir(root, hooks = null) {
  return hooksPlacement(root, { hooksDir: hooks?.hooksDir }).dir;
}

/** 生效配置（主分支已接入时取主分支）所声明的钩子目录；项目还没有配置时返回 null。 */
export function currentHooksConfig(root) {
  let project;
  try {
    project = loadCurrentProject(root);
  } catch {
    return null;
  }
  return gitHooksConfig(project.config);
}

/** 当前 Worktree 里的项目配置所声明的钩子目录；install 写的是这个 Worktree，按它自己的配置。 */
export function worktreeHooksConfig(root, read = readRegularText) {
  const file = join(root, ".harness", "config.json");
  const text = read(file);
  return text === null ? null : gitHooksConfig(parseInstallJson(text, file));
}

function localHooksConfig(root, read) {
  let ref;
  try {
    ref = trustedMainRef(root);
  } catch {
    // 空仓库也能安装；没有主分支配置时读当前 Worktree。
  }
  const rel = ".harness/config.json";
  const text = ref ? showBlob(root, ref, rel) : null;
  return text === null ? worktreeHooksConfig(root, read) : gitHooksConfig(parseInstallJson(text, `${ref}:${rel}`));
}

/**
 * 去掉文件里已有的 harness 块。
 * 旧版本把块追加在末尾且不带结束标记，这种块从标记一直延伸到文件结尾，按到结尾清掉，
 * 否则重复安装会在同一个钩子里留下两个块。
 */
export function stripHookBlock(text) {
  let next = text;
  for (;;) {
    const start = next.search(/^# harness:hook(?!-end)/m);
    if (start < 0) return next;
    const end = next.indexOf(HOOK_END, start);
    if (end < 0) return next.slice(0, start);
    const lineEnd = next.indexOf("\n", end);
    next = next.slice(0, start) + (lineEnd < 0 ? "" : next.slice(lineEnd + 1));
  }
}

/**
 * 把 harness 块插到最前面（shebang 之后）。
 * 追加在末尾会失效：已有的 pre-commit 常见写法是“没有相关改动就 exit 0”，
 * reference-transaction 则会先把标准输入读完，追加的块既拿不到输入也可能永远不执行。
 */
function planHookBlock(changes, { file, block, dropForeign = false }) {
  const existing = changes.read(file) ?? "";
  // 接管时只留 shebang，其他工具写进来的内容整段移除。
  const kept = dropForeign ? (existing.startsWith("#!") ? existing.split("\n")[0] : "") : stripHookBlock(existing);
  const body = kept.replace(/\n+$/, "");
  const lines = body ? body.split("\n") : [];
  const hasShebang = lines.length > 0 && lines[0].startsWith("#!");
  const head = hasShebang ? [lines[0]] : ["#!/bin/sh"];
  const rest = hasShebang ? lines.slice(1) : lines;
  const next = `${[...head, block.trimEnd(), ...rest].join("\n")}\n`;
  return { file, updated: changes.set(file, next, { mode: 0o755 }) };
}

/**
 * 钩子里定位入口的公共函数，只定义不执行，放在每次引用更新都会跑的钩子里也没有开销。
 * 用主 Worktree 的入口：门禁代码与配置的信任根在主分支，任务分支不能决定自己是否放行。
 * main 上没有 .harness/config.json 说明这个仓库还没接入（例如接入前的自举阶段），直接放行。
 */
const HOOK_FUNCTIONS = `harness_entry() {
  printf '%s/.harness/bin/harness' "$(git worktree list --porcelain | sed -n 's/^worktree //p' | sed -n '1p')"
}
harness_enabled() {
  git cat-file -e refs/heads/main:.harness/config.json 2>/dev/null ||
    git cat-file -e refs/heads/master:.harness/config.json 2>/dev/null
}`;

/**
 * 把 harness 接进 git 钩子：pre-commit、commit-msg、reference-transaction。
 * takeOver 只作用于 reference-transaction：原有的主分支保护会拒绝 harness 的合并，接管时移除；
 * pre-commit 与 commit-msg 里的原有脚本（lint、提交信息校验等）一律保留。
 */
function planGitHooks({ dir, changes, takeOver = false, hooks = null }) {
  if (hooks) return planManagedHooks({ dir, changes, hooks });
  const results = [];

  for (const name of ["pre-commit", "commit-msg"]) {
    results.push(
      planHookBlock(changes, {
        file: join(dir, name),
        // 提交前检查只是提前提示：入口缺失或本机没装锁定的版本时提示后放行；真正的约束在合并与引用保护。
        block: `${HOOK_MARK} ${name}
${HOOK_FUNCTIONS}
if harness_enabled; then
  harness_bin="$(harness_entry)"
  if [ -x "$harness_bin" ]; then
    "$harness_bin" githook ${name} "$@"
    harness_status=$?
    if [ "$harness_status" -eq ${SHIM_MISSING_VERSION} ]; then
      printf '[harness] 本机没有安装门禁锁定的版本，跳过 ${name} 检查\\n' >&2
    elif [ "$harness_status" -ne 0 ]; then
      exit "$harness_status"
    fi
  else
    printf '[harness] 主 Worktree 缺少 %s，跳过 ${name} 检查；在主 Worktree 运行 harness install 补齐\\n' "$harness_bin" >&2
  fi
fi
${HOOK_END}`,
      }),
    );
  }

  // 标准输入只能读一次：harness 先读走，判定后用 here-doc 原样交还给钩子里原有的脚本。
  results.push(
    planHookBlock(changes, {
      file: join(dir, "reference-transaction"),
      dropForeign: takeOver,
      block: `${HOOK_MARK} reference-transaction
${HOOK_FUNCTIONS}
harness_input="$(cat)"
if [ "$1" = "prepared" ] && [ "\${HARNESS_MAIN_BYPASS:-}" != "1" ] && harness_enabled; then
  case "$harness_input" in
    *" refs/heads/main"* | *" refs/heads/master"*)
      harness_bin="$(harness_entry)"
      if [ ! -x "$harness_bin" ]; then
        printf '[harness] 拒绝更新主分支: 主 Worktree 缺少 %s，在主 Worktree 运行 harness install 后重试\\n' "$harness_bin" >&2
        exit 1
      fi
      printf '%s\\n' "$harness_input" | "$harness_bin" githook reference-transaction "$1" || exit $?
      ;;
  esac
fi
exec 0<<HARNESS_HOOK_INPUT
$harness_input
HARNESS_HOOK_INPUT
${HOOK_END}`,
    }),
  );

  return { dir, hooks: results };
}

/**
 * 接管模式下 harness 检查的写法：pre-commit 与 commit-msg 入口缺失或本机没装锁定的版本时提示后放行，
 * 真正的约束在合并与引用保护；reference-transaction 与插入模式相同。
 */
function managedCheck(name) {
  return `harness_check() {
  harness_enabled || return 0
  harness_bin="$(harness_entry)"
  if [ ! -x "$harness_bin" ]; then
    printf '[harness] 主 Worktree 缺少 %s，跳过 ${name} 检查；在主 Worktree 运行 harness install 补齐\\n' "$harness_bin" >&2
    return 0
  fi
  "$harness_bin" githook ${name} "$@"
  harness_status=$?
  if [ "$harness_status" -eq ${SHIM_MISSING_VERSION} ]; then
    printf '[harness] 本机没有安装门禁锁定的版本，跳过 ${name} 检查\\n' >&2
    return 0
  fi
  return "$harness_status"
}`;
}

/** 项目钩子存在但不可执行时拒绝，而不是像 git 那样静默跳过，免得项目检查悄悄失效。 */
function projectHookLookup(projectHooks, name) {
  return `project_hook="$(git rev-parse --show-toplevel 2>/dev/null)/${projectHooks}/${name}"
if [ -e "$project_hook" ] && [ ! -x "$project_hook" ]; then
  printf '[harness] 项目钩子 %s 没有可执行权限，chmod +x 后重试\\n' "$project_hook" >&2
  exit 1
fi`;
}

/**
 * 接管模式的钩子文件，整份都在 harness 块里，由 harness 生成。
 * core.hooksPath 指向主 Worktree 里的这个目录，所有 Worktree 执行主分支上确认过的同一份；
 * 项目钩子在当前 Worktree 的检出里执行，跟着分支走。
 * 项目钩子改了暂存区或提交信息时（例如格式化后重新暂存），按最终内容再判一次，检查之后加进来的内容同样要过门禁。
 */
export function managedHookBody(name, projectHooks) {
  const head = `#!/bin/sh
${HOOK_MARK} ${name}
# 由 harness install 生成，请勿手工修改。core.hooksPath 指向主 Worktree 里的这个目录，所有 Worktree 执行同一份。
${projectHooks ? `# 项目自己的检查放在 ${projectHooks}/${name}，harness 检查通过后调用。\n` : ""}${HOOK_FUNCTIONS}`;
  if (name === "reference-transaction") {
    const delegate = projectHooks
      ? `${projectHookLookup(projectHooks, name)}
if [ -x "$project_hook" ]; then
  if [ -n "$harness_input" ]; then printf '%s\\n' "$harness_input"; fi | "$project_hook" "$@"
  exit $?
fi
`
      : "";
    return `${head}
harness_input="$(cat)"
if [ "$1" = "prepared" ] && [ "\${HARNESS_MAIN_BYPASS:-}" != "1" ] && harness_enabled; then
  case "$harness_input" in
    *" refs/heads/main"* | *" refs/heads/master"*)
      harness_bin="$(harness_entry)"
      if [ ! -x "$harness_bin" ]; then
        printf '[harness] 拒绝更新主分支: 主 Worktree 缺少 %s，在主 Worktree 运行 harness install 后重试\\n' "$harness_bin" >&2
        exit 1
      fi
      printf '%s\\n' "$harness_input" | "$harness_bin" githook reference-transaction "$1" || exit $?
      ;;
  esac
fi
${delegate}exit 0
${HOOK_END}
`;
  }
  // pre-commit 比较暂存区的 tree，commit-msg 比较提交信息文件的校验和。
  const snapshot = name === "pre-commit" ? 'git write-tree 2>/dev/null' : 'cksum < "$1" 2>/dev/null';
  const delegate = projectHooks
    ? `${projectHookLookup(projectHooks, name)}
if [ -x "$project_hook" ]; then
  harness_before="$(${snapshot})"
  "$project_hook" "$@" || exit $?
  if [ "$(${snapshot})" != "$harness_before" ]; then
    harness_check "$@" || exit $?
  fi
fi
`
    : "";
  return `${head}
${managedCheck(name)}
harness_check "$@" || exit $?
${delegate}exit 0
${HOOK_END}
`;
}

/** 文件是不是 harness 接管模式生成的：去掉 harness 块后只剩 shebang。 */
function managedHookContent(text) {
  return Boolean(text?.includes(HOOK_MARK)) && stripHookBlock(text).split("\n").every((line) => !line.trim() || line.startsWith("#!"));
}

/**
 * 接管模式：钩子目录整个由 harness 生成。目录里已有其他工具写的内容时拒绝覆盖，
 * 提示把它们移到项目钩子目录，否则会被静默冲掉。
 */
function planManagedHooks({ dir, changes, hooks }) {
  const foreign = HOOK_NAMES.filter((name) => {
    const text = changes.read(join(dir, name));
    return text !== null && !managedHookContent(text);
  });
  if (foreign.length > 0) {
    const target = hooks.projectHooks ?? "git.projectHooks 指定的目录";
    throw new Error(
      `${hooks.hooksDir} 由 harness 接管，但其中 ${foreign.join("、")} 含有其他内容。把这些脚本移到 ${target}，harness 检查通过后会调用它们，然后重新运行`,
    );
  }
  const results = HOOK_NAMES.map((name) => {
    const file = join(dir, name);
    const body = managedHookBody(name, hooks.projectHooks);
    return { file, updated: changes.set(file, body, { mode: 0o755 }) };
  });
  return { dir, hooks: results, managed: true };
}

/** core.hooksPath 解析成绝对路径：相对路径按当前 Worktree 解析，与 git 的行为一致。 */
function resolvedHooksPath(root) {
  const current = git(root, ["config", "--get", "core.hooksPath"]).stdout.trim();
  if (!current) return { current: null, resolved: null };
  return { current, resolved: isAbsolute(current) ? current : join(root, current) };
}

/**
 * 接管模式下 core.hooksPath 的现状，只读：
 * ok 已指向主 Worktree 里的钩子目录；pending 主 Worktree 里还没有生成的钩子（任务分支尚未合入）；mismatch 指向别处。
 */
export function hooksPathState({ root, hooks }) {
  const target = join(mainWorktreeRoot(root), hooks.hooksDir);
  const { current, resolved } = resolvedHooksPath(root);
  if (resolved && samePath(resolved, target)) return { state: "ok", target, current };
  const ready = HOOK_NAMES.every((name) => {
    const file = join(target, name);
    return existsSync(file) && managedHookContent(readFileSync(file, "utf8"));
  });
  return { state: ready ? "mismatch" : "pending", target, current };
}

/**
 * 让 core.hooksPath 指向主 Worktree 里的钩子目录。写在公共配置里，所有 Worktree 共用，
 * 停在旧分支、检出里还没有这个目录的 Worktree 也执行同一份钩子。
 * 主 Worktree 里还没有生成的钩子时不切换：指向不存在的目录，git 会静默跳过钩子，主分支保护也随之失效。
 */
export function ensureHooksPath({ root, hooks }) {
  const before = hooksPathState({ root, hooks });
  if (before.state !== "mismatch") return { ...before, previous: before.current };
  const set = git(root, ["config", "--file", join(commonDir(root), "config"), "core.hooksPath", before.target]);
  if (set.status !== 0) throw new Error(`设置 core.hooksPath 失败: ${set.stderr.trim()}`);
  const after = hooksPathState({ root, hooks });
  // 仍不一致说明有更高优先级的设置（例如 Worktree 级配置）盖住了公共配置，交给 doctor 报出来。
  return { ...after, state: after.state === "ok" ? "switched" : "overridden", previous: before.current };
}

function planHooksPath({ root, hooks, changes }) {
  const target = join(mainWorktreeRoot(root), hooks.hooksDir);
  const { current, resolved } = resolvedHooksPath(root);
  const ready = HOOK_NAMES.every((name) => {
    const file = join(target, name);
    const state = changes.stat(file);
    return state?.type === "file" && (state.mode & 0o111) !== 0 && managedHookContent(changes.read(file));
  });
  const base = { target, current, previous: current };
  if (resolved && samePath(resolved, target)) return { ...base, state: "ok" };
  if (!ready) return { ...base, state: "pending" };
  const scope = git(root, ["config", "--show-scope", "--null", "--get", "core.hooksPath"]).stdout.split("\0", 1)[0];
  if (["worktree", "command"].includes(scope)) throw new Error(`core.hooksPath 被 ${scope} 级配置覆盖，请修正后再安装`);
  changes.config(target);
  return { ...base, state: "switched" };
}

/**
 * 判断一条客户端钩子命令是不是 harness 的；也认 0.2 及以前生成在 .harness/bin/ 下的入口脚本。
 * 只认这两种写法，其他工具的同名脚本不算，是否移除由接管决定。
 */
export function isHarnessClientHook(command) {
  const text = String(command ?? "");
  return /\.harness\/bin\/harness"?\s+hook\s+--client\b/.test(text) || /\.harness\/bin\/(claude|codex)-hook\.mjs/.test(text);
}

function keepEntries(entries, takeOver, file) {
  const invalid = () => new Error(`${file} 的钩子事件配置无效，应是钩子对象数组`);
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) throw invalid();
  return entries.filter((entry) => {
    const handlers = entry?.hooks ?? [entry];
    if (!Array.isArray(handlers) || !entry || typeof entry !== "object" || Array.isArray(entry) ||
        handlers.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw invalid();
    const commands = handlers.map((item) => item.command);
    if (commands.some(isHarnessClientHook)) return false;
    return !takeOver;
  });
}

const ANTIGRAVITY_HOOK_COMMAND = '"$(git rev-parse --show-toplevel)/.harness/bin/harness" hook --client antigravity';
const CLAUDE_HOOK_COMMAND = '"$CLAUDE_PROJECT_DIR/.harness/bin/harness" hook --client claude';
const CODEX_HOOK_COMMAND = '"$(git rev-parse --show-toplevel)/.harness/bin/harness" hook --client codex';
// 收尾检查挂在 Stop 事件上；入口 shim 按第 4、5 个参数识别它，参数顺序不能改。
const STOP_SUFFIX = " --event stop";

/**
 * Stop 事件里的 harness 条目换成最新的一份。其他工具的 Stop 钩子（例如结束提醒）一律保留，
 * 接管只针对拦截类的 PreToolUse，不能顺带删掉用户自己的提醒。
 */
function withStopHook(hooks, command, file, flat = false) {
  const handler = { type: "command", command };
  return { ...hooks, Stop: [...keepEntries(hooks.Stop, false, file), flat ? handler : { hooks: [handler] }] };
}

/**
 * Claude Code 与 Codex 的 PreToolUse 和 Stop 钩子配置；保留文件里其他设置。
 * 其他工具的 PreToolUse 钩子默认保留，takeOver 时移除。
 */
function planClientHooks({ file, changes, takeOver, command, matcher }) {
  const text = changes.read(file);
  const current = text === null ? {} : parseInstallJson(text, file);
  const hooks = current.hooks ?? {};
  if (typeof hooks !== "object" || Array.isArray(hooks)) throw new Error(`${file} 的 hooks 配置不是对象`);
  const kept = keepEntries(hooks.PreToolUse, takeOver, file);
  const ours = { matcher, hooks: [{ type: "command", command }] };
  current.hooks = withStopHook({ ...hooks, PreToolUse: [...kept, ours] }, command + STOP_SUFFIX, file);
  changes.set(file, `${JSON.stringify(current, null, 2)}\n`);
  return file;
}

/** Antigravity 按自定义名称分组保存事件；默认保留其他分组，takeOver 只移除其他 PreToolUse，其他事件不动。 */
function planAntigravityHooks({ root, changes, takeOver }) {
  const file = join(root, ".agents", "hooks.json");
  const text = changes.read(file);
  const current = text === null ? {} : parseInstallJson(text, file);
  for (const group of Object.values(current)) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    for (const [event, foreign] of [["PreToolUse", takeOver], ["Stop", false]]) {
      if (!Object.hasOwn(group, event)) continue;
      const kept = keepEntries(group[event], foreign, file);
      if (kept.length > 0) group[event] = kept;
      else delete group[event];
    }
  }
  const ours = current.harness && typeof current.harness === "object" && !Array.isArray(current.harness) ? current.harness : {};
  const hook = { type: "command", command: ANTIGRAVITY_HOOK_COMMAND };
  current.harness = withStopHook(
    { ...ours, enabled: true, PreToolUse: [...(ours.PreToolUse ?? []), { matcher: "*", hooks: [hook] }] },
    ANTIGRAVITY_HOOK_COMMAND + STOP_SUFFIX,
    file,
    true,
  );
  changes.set(file, `${JSON.stringify(current, null, 2)}\n`);
  return file;
}

/** 本机共用的 DeepSeek Harness 插件目录，与版本目录同级；每个 profile 注册一次，所有项目共用。 */
export function dshPluginDir() {
  return join(dirname(storeRoot()), "dsh-plugin");
}

const DSH_STORE_MARK = '"@@HARNESS_STORE@@"';

/** 当前代码会写出的 DSH 插件文件内容，文件名到正文。 */
function dshPluginFiles() {
  const version = packageVersion();
  const source = readFileSync(join(PACKAGE_ROOT, "assets", "dsh", "index.mjs"), "utf8");
  if (!source.includes(DSH_STORE_MARK)) throw new Error("DSH 插件模板缺少版本目录占位");
  const manifest = { name: "harness-guard", version, private: true, type: "module", main: "./index.mjs", dsh: { bundle: { patch: "./cordis.patch.yml" } } };
  return {
    "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "cordis.patch.yml": "- insert:\n    - id: harness-guard\n      name: harness-guard\n",
    "index.mjs": source.split(DSH_STORE_MARK).join(JSON.stringify(storeRoot())),
  };
}

/**
 * 本机已有的 DSH 插件内容是否落后于当前代码会写出的内容：文件缺失或不同，且不是更新版本生成的。
 * 只做判断不写文件；插件文件没变的版本升级不算落后，避免每次发版都提示。
 */
export function dshPluginStale() {
  const dir = dshPluginDir();
  const manifestFile = join(dir, "package.json");
  if (!existsSync(manifestFile)) return false;
  try {
    const current = JSON.parse(readFileSync(manifestFile, "utf8")).version;
    if (typeof current === "string" && current.localeCompare(packageVersion(), undefined, { numeric: true }) > 0) return false;
  } catch {
    return true;
  }
  const { "package.json": _manifest, ...rest } = dshPluginFiles();
  return Object.entries(rest).some(([name, body]) => {
    const file = join(dir, name);
    return !existsSync(file) || readFileSync(file, "utf8") !== body;
  });
}

/**
 * 写本机共用的 DSH 插件（Cordis 组合包），由用户在 DSH 里注册。
 * 插件按会话所在仓库锁定的版本导入门禁代码，与哪个项目、哪个版本生成它无关。
 * 已有的插件由更新的版本生成时保持不变，旧版本的 install 不会把它换回旧代码。
 */
function planDshPlugin() {
  const dir = resolve(dshPluginDir());
  const version = packageVersion();
  const manifestFile = join(dir, "package.json");
  try {
    inspectDirectory(dir, { writable: false, allowSymlinks: true });
    const manifest = readRegularText(manifestFile);
    let current = null;
    try {
      if (manifest !== null) current = JSON.parse(manifest)?.version;
    } catch {
      // 读不出版本的插件按损坏处理，下面整份重写。
    }
    if (typeof current === "string" && current.localeCompare(version, undefined, { numeric: true }) > 0) {
      return { dir, version: current, files: [] };
    }
    const files = Object.entries(dshPluginFiles()).flatMap(([name, body]) => {
      const file = join(dir, name);
      const before = name === "package.json" ? manifest : readRegularText(file);
      return before === body ? [] : [{ file, body, action: before === null ? "新增" : "更新" }];
    });
    if (files.length > 0) {
      inspectDirectory(dir, { allowSymlinks: true });
      inspectDirectory(dshLock(dir), { allowSymlinks: true });
    }
    return { dir, version, files };
  } catch (error) {
    throw new Error(`预检冲突（DSH 插件）: ${error.message}`);
  }
}

const dshLock = (dir) => join(dirname(dir), ".dsh-install-lock");

function prepareDshPlugin(plan) {
  const { dir, version, files } = plan;
  if (files.length === 0) return { dir, version, updated: false };
  return withInstallLock(dshLock(dir), () => {
    // 另一个项目可能刚装完新版插件，持锁重新确认，不会降级或互相覆盖。
    const current = planDshPlugin();
    mkdirSync(dir, { recursive: true });
    for (const { file, body } of current.files) replaceInstallFile(file, body);
    return { dir, version: current.version, updated: current.files.length > 0 };
  });
}

function planKey() {
  const file = resolve(keyPath());
  inspectDirectory(dirname(file), { writable: false, allowSymlinks: true });
  const stat = statIfPresent(file);
  if (stat && !stat.isFile()) throw new Error(`证据密钥路径不是普通文件: ${file}`);
  if (!stat) inspectDirectory(dirname(file), { allowSymlinks: true });
  const key = keyStatus();
  if (key.exists && !key.valid) throw new Error(key.reason);
  return { path: file, action: key.exists ? "复用" : "生成" };
}

function planFileActions(root, entries) {
  return entries.map(({ kind, file, before, after }) => ({
    path: kind === "hooks-path" ? `core.hooksPath (${file})` : file.startsWith(`${root}/.git/`) || !file.startsWith(`${root}/`) ? file : relative(root, file),
    action: after === null ? "删除" : before === null ? "新增" : "更新",
  }));
}

/** 先完整规划，再准备本机共享资源，最后应用同一份项目变更。 */
export function runProjectInstall({ cwd, command, dryRun = false, force = false, takeOver = false, planExtra, inspect }) {
  const root = repoRoot(cwd);
  const location = installLocation(commonDir(root));
  const local = command === "install --local";
  const planInstall = () => {
    const pending = pendingInstall(location);
    if (pending) throw new Error(pending);
    const checkout = installCheckout(root);
    // 显式接管（--force 或 --take-over）时允许把文件级软链替换成普通文件，不跟随链接写入。
    const changes = createProjectChanges(root, location.common, { takeOverLinks: !local && (takeOver || force) });
    const pin = readVersionPin(changes.read(join(root, ".harness", "VERSION")), changes.read(shimPath(root)));
    const version = local ? pin.version ?? packageVersion() : packageVersion();
    const plan = { root, version, pinned: isVersion(pin.version) ? pin.version : null, dryRun, files: [], shared: [], conflicts: [] };
    if (!local) {
      const previousRoot = plan.pinned ? join(versionDir(plan.pinned), "assets") : null;
      const managed = planManagedRules({ root, previousRoot, force });
      const problem = managedConflictError(managed);
      if (problem) {
        if (dryRun) return { result: { ...plan, conflicts: managed.conflicts } };
        throw problem;
      }
      for (const { path, content } of managed.actions) changes.set(join(root, path), content, { allowLink: force });
      if (managed.manifestChanged) changes.set(join(root, MANAGED_MANIFEST), managed.manifestText, { allowLink: force });
    }

    const extra = planExtra?.({ root, changes });
    const hooksConfig = local ? localHooksConfig(root, changes.read) : worktreeHooksConfig(root, changes.read);
    const placement = hooksPlacement(root, { hooksDir: hooksConfig?.hooksDir });
    const hooksDir = resolve(placement.dir);
    const install = { root, hooksTracked: placement.tracked };
    if (!local) {
      changes.set(join(root, ".harness", "VERSION"), `${version}\n`);
      for (const name of ["claude-hook.mjs", "codex-hook.mjs"]) changes.set(join(root, ".harness", "bin", name), null, { allowLink: true });
      install.shim = shimPath(root);
      changes.set(install.shim, shimBody(version), { mode: 0o755 });
    }
    // 入库钩子由分支分发，--local 只刷新未入库的钩子和本机配置。
    install.hooks = local && placement.tracked ? null : planGitHooks({ dir: hooksDir, changes, takeOver: !local && takeOver, hooks: hooksConfig });
    install.hooksPath = hooksConfig ? planHooksPath({ root, hooks: hooksConfig, changes }) : null;
    if (!local) {
      install.claude = planClientHooks({
        file: join(root, ".claude", "settings.json"), changes, takeOver, command: CLAUDE_HOOK_COMMAND, matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep",
      });
      install.codex = planClientHooks({ file: join(root, ".codex", "hooks.json"), changes, takeOver, command: CODEX_HOOK_COMMAND, matcher: "*" });
      install.antigravity = planAntigravityHooks({ root, changes, takeOver });
      planGitignore(root, changes);
    }
    const context = { root, common: location.common, checkout, hooksDir };
    const entries = [...changes.entries.values()];
    validateProjectInstall(context, location, entries);
    const store = planVersionInstall({ version });
    const key = planKey();
    const dsh = planDshPlugin();
    plan.files = planFileActions(root, entries);
    plan.shared = [{ path: store.dir, action: store.action }, key, ...dsh.files.map(({ file, action }) => ({ path: file, action }))];
    const result = { ...plan, ...extra, ...inspect?.({ root }) };
    return { result, context, entries, install, hooksConfig, dsh };
  };
  const preview = planInstall();
  if (dryRun) return preview.result;

  return withProjectInstallLock(location, () => {
    // 等锁期间其他安装或人工编辑可能改变输入，以锁内的新计划为准。
    const { result, context, entries, install, hooksConfig, dsh } = planInstall();
    const { version } = result;
    install.published = installVersion({ version });
    install.fromTag = install.published.fromTag;
    loadKey();
    install.dsh = prepareDshPlugin(dsh);
    applyProjectChanges(context, location, command, entries, () => {
      if (install.hooksPath?.state === "switched") {
        if (hooksPathState({ root, hooks: hooksConfig }).state !== "ok") throw new Error("core.hooksPath 未生效，请检查更高优先级的 Git 配置");
        install.hooksPath.current = install.hooksPath.target;
      }
      if (!local) {
        verifyShimIgnore(root);
        install.shimTracked = git(root, ["ls-files", "--error-unmatch", SHIM_REL]).status === 0;
      }
    });
    return { ...result, install };
  });
}

export function installAll(options) {
  const result = runProjectInstall({ ...options, command: "install" });
  return result.install ?? result;
}

export function installLocal(options) {
  const result = runProjectInstall({ ...options, command: "install --local" });
  return result.install ?? result;
}

export function projectVersionPin(root) {
  const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);
  return readVersionPin(read(join(root, ".harness", "VERSION")), read(shimPath(root)));
}

export function pinnedVersion(root) {
  return projectVersionPin(root).version;
}
