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
  const incoming = hashTree(PACKAGE_ROOT, ["src", "assets", "bin", "package.json", "VERSION"]);
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
  for (const entry of ["src", "assets", "bin", "package.json", "VERSION"]) {
    const source = join(PACKAGE_ROOT, entry);
    if (!existsSync(source)) continue;
    const dest = join(tmp, entry);
    if (isDir(source)) copyTree(source, dest);
    else copyFileSync(source, dest);
  }
  const manifest = hashTree(tmp, ["src", "assets", "bin", "package.json", "VERSION"]);
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

export function shimPath(root) {
  return join(root, ".harness", "bin", "harness");
}

export function writeShim({ root, version = packageVersion() }) {
  const file = shimPath(root);
  mkdirSync(join(file, ".."), { recursive: true });
  const body = `#!/bin/sh
# harness 入口 shim，由 harness install 生成，请勿手工修改。
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

function gitHooksDir(root) {
  const hooksPath = git(root, ["config", "--get", "core.hooksPath"]).stdout.trim();
  if (hooksPath) return join(root, hooksPath);
  return join(commonDir(root), "hooks");
}

function appendHookBlock({ file, block, legacy }) {
  mkdirSync(join(file, ".."), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "#!/bin/sh\n";
  if (existing.includes(HOOK_MARK)) return { file, updated: false };
  const suffix = existsSync(file) && existing.trim().length > 0 ? "\n" : "";
  writeFileSync(file, `${existing.replace(/\n+$/, "")}${suffix}${block}\n`);
  chmodSync(file, 0o755);
  return { file, updated: true };
}

/** 把 harness 接进 git 钩子：pre-commit、commit-msg、reference-transaction。 */
export function writeGitHooks({ root }) {
  const dir = gitHooksDir(root);
  const shim = relative(dir, shimPath(root)).split("\\").join("/");
  // 用绝对路径调用：钩子在各种 cwd 下运行，相对路径不可靠。
  const runShim = `"$(cd "$(git rev-parse --show-toplevel)" && pwd)/.harness/bin/harness"`;
  const results = [];

  results.push(
    appendHookBlock({
      file: join(dir, "pre-commit"),
      block: `${HOOK_MARK} pre-commit
${runShim} githook pre-commit "$@" || exit $?`,
    }),
  );

  results.push(
    appendHookBlock({
      file: join(dir, "commit-msg"),
      block: `${HOOK_MARK} commit-msg
${runShim} githook commit-msg "$@" || exit $?`,
    }),
  );

  results.push(
    appendHookBlock({
      file: join(dir, "reference-transaction"),
      block: `${HOOK_MARK} reference-transaction
[ "$1" = "prepared" ] || exit 0
[ "\${HARNESS_MAIN_BYPASS:-}" = "1" ] && exit 0
input="$(cat)"
case "$input" in
  *" refs/heads/main"* | *" refs/heads/master"*) ;;
  *) exit 0 ;;
esac
printf '%s\\n' "$input" | ${runShim} githook reference-transaction "$1"`,
    }),
  );

  return { dir, hooks: results, shim };
}

function versionImport(version, rel) {
  return `${versionDir(version)}/src/${rel}`;
}

/**
 * 写出 Claude 与 Codex 的钩子入口脚本。
 * 脚本本身在项目里（客户端按项目路径调用），实际判定逻辑从版本目录导入，
 * 保证跑的是已安装并校验过的那份代码，任务分支改不动它。
 */
export function writeHookEntries({ root, version }) {
  const dir = join(root, ".harness", "bin");
  mkdirSync(dir, { recursive: true });
  const specs = {
    "claude-hook.mjs": [
      ["../adapters/claude.mjs", "adapters/claude.mjs"],
      ["../adapters/index.mjs", "adapters/index.mjs"],
    ],
    "codex-hook.mjs": [
      ["../adapters/codex.mjs", "adapters/codex.mjs"],
      ["../adapters/index.mjs", "adapters/index.mjs"],
    ],
  };
  const written = [];
  for (const [name, replacements] of Object.entries(specs)) {
    let source = readFileSync(join(PACKAGE_ROOT, "assets", "hooks", name), "utf8");
    for (const [from, to] of replacements) {
      source = source.split(from).join(versionImport(version, to));
    }
    const target = join(dir, name);
    writeFileSync(target, source);
    chmodSync(target, 0o755);
    written.push(target);
  }
  return written;
}

/** Claude Code 的 PreToolUse 钩子配置；保留文件里其他设置。 */
export function writeClaudeSettings({ root }) {
  const file = join(root, ".claude", "settings.json");
  mkdirSync(join(file, ".."), { recursive: true });
  const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const hook = {
    type: "command",
    command: 'node "$CLAUDE_PROJECT_DIR/.harness/bin/claude-hook.mjs"',
  };
  const matcher = "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep";
  const pre = current.hooks?.PreToolUse ?? [];
  const kept = pre.filter((entry) => !(entry.hooks ?? []).some((item) => String(item.command ?? "").includes("claude-hook.mjs")));
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
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: 'node "$(git rev-parse --show-toplevel)/.harness/bin/codex-hook.mjs"',
            },
          ],
        },
      ],
    },
  };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
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
  const entries = writeHookEntries({ root, version: published.version });
  const shim = writeShim({ root });
  const hooks = writeGitHooks({ root });
  const claude = writeClaudeSettings({ root });
  const codex = writeCodexHooks({ root });
  const dsh = writeDshPlugin({ root });
  return { root, published, shim, entries, hooks, claude, codex, dsh };
}
