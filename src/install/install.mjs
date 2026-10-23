import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { PACKAGE_ROOT } from "../policy/resolve.mjs";
import { commonDir, git, repoRoot } from "../lib/git.mjs";
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
 */
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
  printf '[harness] 找不到已安装的版本 %s\\n' "$HARNESS_VERSION" >&2
  printf '请先运行 harness publish 安装该版本，或 harness upgrade 更新版本。\\n' >&2
  exit 2
fi
exec node "$entry" "$@"
`;
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

const HOOK_MARK = "# harness:hook";
const HOOK_END = "# harness:hook-end";

function gitHooksDir(root) {
  const hooksPath = git(root, ["config", "--get", "core.hooksPath"]).stdout.trim();
  if (hooksPath) return join(root, hooksPath);
  return join(commonDir(root), "hooks");
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
export function insertHookBlock({ file, block }) {
  mkdirSync(join(file, ".."), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const body = stripHookBlock(existing).replace(/\n+$/, "");
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

/** 把 harness 接进 git 钩子：pre-commit、commit-msg、reference-transaction。 */
export function writeGitHooks({ root }) {
  const dir = gitHooksDir(root);
  const results = [];

  for (const name of ["pre-commit", "commit-msg"]) {
    results.push(
      insertHookBlock({
        file: join(dir, name),
        // 提交前检查只是提前提示，入口缺失时提示后放行；真正的约束在合并与引用保护。
        block: `${HOOK_MARK} ${name}
${HOOK_FUNCTIONS}
if harness_enabled; then
  harness_bin="$(harness_entry)"
  if [ -x "$harness_bin" ]; then
    "$harness_bin" githook ${name} "$@" || exit $?
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

/** 判断一条客户端钩子命令是不是 harness 的；也认旧版生成的入口脚本，升级时一并替换。 */
export function isHarnessClientHook(command) {
  const text = String(command ?? "");
  return /\.harness\/bin\/harness"?\s+hook\s+--client\b/.test(text) || /(claude|codex)-hook\.mjs/.test(text);
}

const CLAUDE_HOOK_COMMAND = '"$CLAUDE_PROJECT_DIR/.harness/bin/harness" hook --client claude';
const CODEX_HOOK_COMMAND = '"$(git rev-parse --show-toplevel)/.harness/bin/harness" hook --client codex';

/** Claude Code 的 PreToolUse 钩子配置；保留文件里其他设置。 */
export function writeClaudeSettings({ root }) {
  const file = join(root, ".claude", "settings.json");
  mkdirSync(join(file, ".."), { recursive: true });
  const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const hook = { type: "command", command: CLAUDE_HOOK_COMMAND };
  const matcher = "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep";
  const pre = current.hooks?.PreToolUse ?? [];
  const kept = pre.filter((entry) => !(entry.hooks ?? []).some((item) => isHarnessClientHook(item.command)));
  current.hooks = { ...(current.hooks ?? {}), PreToolUse: [...kept, { matcher, hooks: [hook] }] };
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
  return file;
}

/** Codex 的项目级钩子文件；与 Claude 同构但用 permissionDecision 表达拒绝。 */
export function writeCodexHooks({ root }) {
  const file = join(root, ".codex", "hooks.json");
  mkdirSync(join(file, ".."), { recursive: true });
  const config = {
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: CODEX_HOOK_COMMAND }] }],
    },
  };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
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

export function installAll({ cwd }) {
  const root = repoRoot(cwd);
  loadKey();
  const published = publishVersion();
  writeRules({ root, version: published.version });
  writeGolden({ root });
  // 旧版生成过带本机绝对路径的入口脚本，入口改为 shim 后不再需要。
  for (const name of ["claude-hook.mjs", "codex-hook.mjs"]) rmSync(join(root, ".harness", "bin", name), { force: true });
  const shim = writeShim({ root });
  const hooks = writeGitHooks({ root });
  const claude = writeClaudeSettings({ root });
  const codex = writeCodexHooks({ root });
  const dsh = writeDshPlugin({ root });
  const gitignore = ensureGitignore({ root });
  const shimTracked = git(root, ["ls-files", "--error-unmatch", SHIM_REL]).status === 0;
  return { root, published, shim, hooks, claude, codex, dsh, gitignore, shimTracked };
}
