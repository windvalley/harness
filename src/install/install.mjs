import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { PACKAGE_ROOT } from "../policy/resolve.mjs";
import { git, hooksPlacement, repoRoot, run } from "../lib/git.mjs";
import { loadKey } from "../lib/store.mjs";
import { packageVersion, writeGolden, writeRules } from "./managed.mjs";

// 代码装在用户目录并按版本不可变；仓库里只放 shim 与配置。
// 这样改门禁代码不落在任何任务分支里，任务分支也就无法放宽自己的门禁。
export function storeRoot() {
  return process.env.HARNESS_STORE || join(homedir(), ".local", "share", "harness", "versions");
}

export function versionDir(version = packageVersion()) {
  return join(storeRoot(), version);
}

export function storeEntry(version = packageVersion()) {
  return join(versionDir(version), "bin", "harness.mjs");
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSafe(from)) {
    const source = join(from, entry);
    const target = join(to, entry);
    if (isDir(source)) copyTree(source, target);
    else copyFileSync(source, target);
  }
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 把当前源码树装进版本目录，并写内容哈希清单。 */
export function publishVersion({ version = packageVersion() } = {}) {
  const target = versionDir(version);
  const incoming = hashTree(PACKAGE_ROOT, ["src", "assets", "bin", "package.json"]);
  if (existsSync(target)) {
    const installedFile = join(target, "MANIFEST.json");
    if (existsSync(installedFile)) {
      const installed = JSON.parse(readFileSync(installedFile, "utf8"));
      if (JSON.stringify(installed.files) === JSON.stringify(incoming.files)) {
        return { version, dir: target, existed: true };
      }
    }
    // 内容不一致：替换旧目录，避免装着过期代码。
    rmSync(target, { recursive: true, force: true });
  }
  const tmp = `${target}.tmp-${process.pid}`;
  mkdirSync(tmp, { recursive: true });
  for (const entry of ["src", "assets", "bin", "package.json"]) {
    const source = join(PACKAGE_ROOT, entry);
    if (!existsSync(source)) continue;
    const dest = join(tmp, entry);
    if (isDir(source)) copyTree(source, dest);
    else copyFileSync(source, dest);
  }
  const manifest = hashTree(tmp, ["src", "assets", "bin", "package.json"]);
  writeFileSync(join(tmp, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  mkdirSync(storeRoot(), { recursive: true });
  copyTree(tmp, target);
  rmSync(tmp, { recursive: true, force: true });
  return { version, dir: target, existed: false, files: Object.keys(manifest.files).length };
}

// 只统计实际分发的目录，根目录下的 README、测试等不参与比对。
function hashTree(root, entries) {
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSafe(dir)) {
      const full = join(dir, entry);
      if (isDir(full)) walk(full);
      else {
        const rel = relative(root, full).split("\\").join("/");
        files[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
      }
    }
  };
  for (const entry of entries) {
    const full = join(root, entry);
    if (!existsSync(full)) continue;
    if (isDir(full)) walk(full);
    else files[relative(root, full).split("\\").join("/")] = createHash("sha256").update(readFileSync(full)).digest("hex");
  }
  return { version: packageVersion(), files };
}

/** 校验已安装版本的内容与清单一致，防止装好的门禁被就地改写。 */
export function verifyVersion({ version = packageVersion() } = {}) {
  const dir = versionDir(version);
  const manifestFile = join(dir, "MANIFEST.json");
  if (!existsSync(manifestFile)) return { ok: false, reason: `版本 ${version} 未安装` };
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const drift = [];
  for (const [rel, hash] of Object.entries(manifest.files)) {
    const full = join(dir, rel);
    if (!existsSync(full)) {
      drift.push(`${rel} 缺失`);
      continue;
    }
    const actual = createHash("sha256").update(readFileSync(full)).digest("hex");
    if (actual !== hash) drift.push(`${rel} 内容被改动`);
  }
  return drift.length === 0 ? { ok: true, files: Object.keys(manifest.files).length } : { ok: false, reason: drift.join("; ") };
}

/** 列出已安装的全部版本，按语义化版本排序。 */
export function listVersions() {
  const root = storeRoot();
  if (!existsSync(root)) return [];
  return readdirSafe(root)
    .filter((name) => /^\d+\.\d+\.\d+/.test(name) && isDir(join(root, name)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** 清理旧版本目录；keep 指定要保留的版本，其余删除。 */
export function pruneVersions({ keep = [], dryRun = false } = {}) {
  const root = storeRoot();
  const keepSet = new Set(keep);
  const removed = [];
  for (const version of listVersions()) {
    if (keepSet.has(version)) continue;
    removed.push(version);
    if (!dryRun) rmSync(join(root, version), { recursive: true, force: true });
  }
  return { removed, kept: [...keepSet], dryRun };
}

export function shimPath(root) {
  return join(root, ".harness", "bin", "harness");
}

/**
 * 入口 shim 只依赖 $HOME 与固定版本号，因此可以入库：
 * 每个 Linked Worktree 检出后立刻可用，不用在每棵树里各跑一次 install。
 * 本机没有装这个版本时退出码固定为 3，git 钩子据此区分“没装”与“被拦截”。
 */
export const SHIM_MISSING_VERSION = 3;

export function writeShim({ root, version = packageVersion() }) {
  const file = shimPath(root);
  mkdirSync(join(file, ".."), { recursive: true });
  const body = `#!/bin/sh
# harness 入口 shim，由 harness install 生成，入库随仓库分发，请勿手工修改。
# 代码在用户目录按版本安装；这里只负责转发，并锁住版本，避免任务分支改代码影响门禁。
HARNESS_VERSION="\${HARNESS_VERSION:-${version}}"
HARNESS_STORE="\${HARNESS_STORE:-$HOME/.local/share/harness/versions}"
entry="$HARNESS_STORE/$HARNESS_VERSION/bin/harness.mjs"
if [ ! -f "$entry" ]; then
  msg="[harness] 本机没有安装门禁锁定的版本 $HARNESS_VERSION。请用户在自己的终端（Claude Code 里可在输入框用 ! 前缀）于项目目录运行 node <harness 仓库>/bin/harness.mjs install --local"
  # 实时拦截在未安装时一律拒绝：放行等于门禁不存在。Claude 以退出码 2 拒绝，Codex 读 permissionDecision。
  if [ "$1" = "hook" ]; then
    if [ "$3" = "codex" ]; then
      printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n' "$msg"
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
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

const HOOK_MARK = "# harness:hook";
const HOOK_END = "# harness:hook-end";

export function gitHooksDir(root) {
  return hooksPlacement(root).dir;
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
export function insertHookBlock({ file, block, dropForeign = false }) {
  mkdirSync(join(file, ".."), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  // 接管时只留 shebang，其他工具写进来的内容整段移除。
  const kept = dropForeign ? (existing.startsWith("#!") ? existing.split("\n")[0] : "") : stripHookBlock(existing);
  const body = kept.replace(/\n+$/, "");
  const lines = body ? body.split("\n") : [];
  const hasShebang = lines.length > 0 && lines[0].startsWith("#!");
  const head = hasShebang ? [lines[0]] : ["#!/bin/sh"];
  const rest = hasShebang ? lines.slice(1) : lines;
  const next = `${[...head, block.trimEnd(), ...rest].join("\n")}\n`;
  writeFileSync(file, next);
  chmodSync(file, 0o755);
  return { file, updated: existing !== next };
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
export function writeGitHooks({ root, takeOver = false }) {
  const dir = gitHooksDir(root);
  const results = [];

  for (const name of ["pre-commit", "commit-msg"]) {
    results.push(
      insertHookBlock({
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
    insertHookBlock({
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
 * 判断一条客户端钩子命令是不是 harness 的；也认 0.2 及以前生成在 .harness/bin/ 下的入口脚本。
 * 只认这两种写法，其他工具的同名脚本不算，是否移除由接管决定。
 */
export function isHarnessClientHook(command) {
  const text = String(command ?? "");
  return /\.harness\/bin\/harness"?\s+hook\s+--client\b/.test(text) || /\.harness\/bin\/(claude|codex)-hook\.mjs/.test(text);
}

function keepEntries(entries, takeOver) {
  return (entries ?? []).filter((entry) => {
    const commands = (entry.hooks ?? []).map((item) => item.command);
    if (commands.some(isHarnessClientHook)) return false;
    return !takeOver;
  });
}

const CLAUDE_HOOK_COMMAND = '"$CLAUDE_PROJECT_DIR/.harness/bin/harness" hook --client claude';
const CODEX_HOOK_COMMAND = '"$(git rev-parse --show-toplevel)/.harness/bin/harness" hook --client codex';

/**
 * Claude Code 的 PreToolUse 钩子配置；保留文件里其他设置。
 * 其他工具的 PreToolUse 钩子默认保留，takeOver 时移除。
 */
export function writeClaudeSettings({ root, takeOver = false }) {
  const file = join(root, ".claude", "settings.json");
  mkdirSync(join(file, ".."), { recursive: true });
  const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const hook = { type: "command", command: CLAUDE_HOOK_COMMAND };
  const matcher = "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep";
  const kept = keepEntries(current.hooks?.PreToolUse, takeOver);
  current.hooks = { ...(current.hooks ?? {}), PreToolUse: [...kept, { matcher, hooks: [hook] }] };
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
  return file;
}

/** Codex 的项目级钩子文件；与 Claude 同构但用 permissionDecision 表达拒绝。规则同上：其他工具的钩子默认保留。 */
export function writeCodexHooks({ root, takeOver = false }) {
  const file = join(root, ".codex", "hooks.json");
  mkdirSync(join(file, ".."), { recursive: true });
  const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const kept = keepEntries(current.hooks?.PreToolUse, takeOver);
  const ours = { matcher: "*", hooks: [{ type: "command", command: CODEX_HOOK_COMMAND }] };
  current.hooks = { ...(current.hooks ?? {}), PreToolUse: [...kept, ours] };
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
  return file;
}

function versionImport(version, rel) {
  return `${versionDir(version)}/src/${rel}`;
}

const SHIM_REL = ".harness/bin/harness";

/**
 * 维护 .gitignore。
 * 入口 shim 必须入库：Go 项目常有全局的 `bin/` 忽略规则，会连带忽略 `.harness/bin/`，
 * 那样 Linked Worktree 里没有入口，客户端拦截与 git 钩子都会静默失效。
 */
export function ensureGitignore({ root }) {
  const file = join(root, ".gitignore");
  const original = existsSync(file) ? readFileSync(file, "utf8") : "";
  // 0.2 及以前要求忽略 .harness/bin/，现在入口要入库，把这一行去掉。
  const lines = original.split("\n").filter((line) => line.trim() !== ".harness/bin/");
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const ensure = (line) => {
    if (!lines.some((item) => item.trim() === line)) lines.push(line);
    writeFileSync(file, `${lines.join("\n")}\n`);
  };
  ensure(".harness/dsh-plugin/");
  // 父目录被排除时单独放行文件无效，先放行目录本身，仍被忽略再放行文件。
  const ignored = () => git(root, ["check-ignore", "--quiet", "--no-index", SHIM_REL]).status === 0;
  if (ignored()) ensure("!.harness/bin/");
  if (ignored()) ensure(`!${SHIM_REL}`);
  return { file, shimIgnored: ignored() };
}

/** DSH 插件目录：Cordis 包，由用户在自己的终端注册到 profile。 */
export function writeDshPlugin({ root }) {
  const dir = join(root, ".harness", "dsh-plugin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "harness-guard",
        version: packageVersion(),
        private: true,
        type: "module",
        main: "./index.mjs",
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, "cordis.patch.yml"), "- insert:\n    - id: harness-guard\n      name: harness-guard\n");
  copyFileSync(join(PACKAGE_ROOT, "assets", "dsh", "index.mjs"), join(dir, "index.mjs"));
  // 插件被复制到项目里，源码里的相对路径已失效，必须改写为指向已安装版本目录的绝对路径。
  const entry = join(dir, "index.mjs");
  const version = packageVersion();
  const rewritten = readFileSync(entry, "utf8")
    .split("../../src/adapters/index.mjs")
    .join(versionImport(version, "adapters/index.mjs"))
    .split("../../src/adapters/dsh.mjs")
    .join(versionImport(version, "adapters/dsh.mjs"));
  writeFileSync(entry, rewritten);
  return dir;
}

export function installAll({ cwd, takeOver = false }) {
  const root = repoRoot(cwd);
  loadKey();
  const published = publishVersion();
  writeRules({ root, version: published.version });
  writeGolden({ root });
  // 旧版生成过带本机绝对路径的入口脚本，入口改为 shim 后不再需要。
  for (const name of ["claude-hook.mjs", "codex-hook.mjs"]) rmSync(join(root, ".harness", "bin", name), { force: true });
  const shim = writeShim({ root });
  const hooks = writeGitHooks({ root, takeOver });
  const claude = writeClaudeSettings({ root, takeOver });
  const codex = writeCodexHooks({ root, takeOver });
  const dsh = writeDshPlugin({ root });
  const gitignore = ensureGitignore({ root });
  const shimTracked = git(root, ["ls-files", "--error-unmatch", SHIM_REL]).status === 0;
  return { root, published, shim, hooks, claude, codex, dsh, gitignore, shimTracked };
}

/**
 * 只刷新本机这一份：安装版本、所有 Worktree 共用的钩子目录、DSH 插件目录，不碰任何入库文件。
 * 合并工具在入口或钩子改动合入后，用新入口在主 Worktree 调用它，保证共用钩子与新版本一致。
 */
export function installLocal({ cwd }) {
  const root = repoRoot(cwd);
  const pinned = pinnedVersion(root);
  if (pinned && pinned !== packageVersion()) return installPinned({ root, version: pinned });
  loadKey();
  const published = publishVersion();
  const { tracked } = hooksPlacement(root);
  // 入库的钩子随分支分发，合入时已经是新内容；只刷新共用目录，避免把主 Worktree 改脏。
  const hooks = tracked ? null : writeGitHooks({ root });
  const dsh = writeDshPlugin({ root });
  return { root, published, hooks, hooksTracked: tracked, dsh };
}

/** 项目入口锁定的版本：优先读 .harness/VERSION，没有时从入口 shim 里解析。 */
export function pinnedVersion(root) {
  const file = join(root, ".harness", "VERSION");
  if (existsSync(file)) return readFileSync(file, "utf8").trim() || null;
  const shim = shimPath(root);
  if (!existsSync(shim)) return null;
  return readFileSync(shim, "utf8").match(/:-([0-9][^}"]*)\}/)?.[1] ?? null;
}

/**
 * 在新机器上使用一个已接入的项目：项目锁定的版本不一定是本地 harness 仓库当前的版本。
 * 从 harness 仓库的标签导出那个版本的代码装进版本目录，再由那个版本自己完成本机刷新，
 * 这样本机装的门禁与项目锁定的版本一致，也不改动任何入库文件。
 */
function installPinned({ root, version }) {
  let fromTag = false;
  if (!verifyVersion({ version }).ok) {
    publishFromTag(version);
    fromTag = true;
  }
  const cli = join(versionDir(version), "src", "cli.mjs");
  // 0.3 及以前没有 --local，它的 install 会重写入库文件；这时只装版本，共用钩子由当前代码补上。
  if (existsSync(cli) && readFileSync(cli, "utf8").includes("installLocal")) {
    const delegated = run(process.execPath, [storeEntry(version), "install", "--local"], { cwd: root });
    if (delegated.status !== 0) throw new Error(`版本 ${version} 刷新本机失败: ${delegated.stderr.trim()}`);
    return { root, published: { version }, fromTag, output: delegated.stdout };
  }
  const { tracked } = hooksPlacement(root);
  const hooks = tracked ? null : writeGitHooks({ root });
  return { root, published: { version }, fromTag, hooks, hooksTracked: tracked };
}

function publishFromTag(version) {
  const tag = `v${version}`;
  if (git(PACKAGE_ROOT, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]).status !== 0) {
    throw new Error(
      `项目锁定的版本是 ${version}，但 ${PACKAGE_ROOT} 里没有标签 ${tag}。` +
        `先在 harness 仓库 git fetch --tags；或者把项目升级到当前版本 ${packageVersion()}（在任务分支运行 harness upgrade）`,
    );
  }
  const tmp = mkdtempSync(join(tmpdir(), "harness-tag-"));
  try {
    const tar = join(tmp, "code.tar");
    const archived = git(PACKAGE_ROOT, ["archive", "--format=tar", `--output=${tar}`, tag, "src", "assets", "bin", "package.json"]);
    if (archived.status !== 0) throw new Error(`导出标签 ${tag} 失败: ${archived.stderr.trim()}`);
    const extracted = run("tar", ["-xf", tar, "-C", tmp]);
    if (extracted.status !== 0) throw new Error(`解开标签 ${tag} 失败: ${extracted.stderr.trim()}`);
    const published = run(process.execPath, [join(tmp, "bin", "harness.mjs"), "publish"], { cwd: tmp });
    if (published.status !== 0) throw new Error(`安装版本 ${version} 失败: ${published.stderr.trim()}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
