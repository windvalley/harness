import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git, run } from "../lib/git.mjs";
import { PACKAGE_ROOT } from "../policy/resolve.mjs";
import { withInstallLock } from "./install-lock.mjs";
import { inspectDirectory, statIfPresent } from "./install-paths.mjs";
import { packageVersion } from "./managed.mjs";

const VERSION = /^\d+\.\d+\.\d+(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i;
const DIRECTORIES = ["assets", "bin", "src"];
const REQUIRED_FILES = ["bin/harness.mjs", "package.json", "src/cli.mjs"];

// 仓库只保存 shim 与配置，版本目录独立于任务分支且按版本不可变。
export function storeRoot() {
  return process.env.HARNESS_STORE || join(homedir(), ".local", "share", "harness", "versions");
}

export function isVersion(version) {
  return typeof version === "string" && VERSION.test(version);
}

export function versionDir(version = packageVersion()) {
  if (!isVersion(version)) throw new Error("版本号格式不对，应为 x.y.z 或带预发布后缀的版本号");
  return join(storeRoot(), version);
}

export function storeEntry(version = packageVersion()) {
  return join(versionDir(version), "bin", "harness.mjs");
}

export function readVersionPin(versionText, shimText) {
  const file = versionText?.trim() || null;
  const shim = shimText?.match(/^\s*HARNESS_VERSION="\$\{HARNESS_VERSION:-([0-9][^}"]*)\}"/m)?.[1] ?? null;
  return { version: file ?? shim, file, shim, mismatch: Boolean(file && shim && file !== shim) };
}

function plainFile(file) {
  if (!lstatSync(file).isFile()) throw new Error(`${file} 不是普通文件`);
  return readFileSync(file);
}

function jsonFile(file) {
  const bytes = plainFile(file);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${file} 不是有效的 JSON`);
  }
}

function validPath(rel) {
  if (rel === "package.json") return true;
  const [dir, ...parts] = rel.split("/");
  return DIRECTORIES.includes(dir) && parts.length > 0 && parts.every((part) => part && part !== "." && part !== ".." && !/[\\\0]/.test(part));
}

function readManifest(dir, version) {
  if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} 不是普通目录`);
  const file = join(dir, "MANIFEST.json");
  const manifest = jsonFile(file);
  const files = manifest?.files;
  if (manifest?.version !== version || !files || typeof files !== "object" || Array.isArray(files) ||
      !REQUIRED_FILES.every((name) => Object.hasOwn(files, name)) ||
      !Object.entries(files).every(([rel, hash]) => validPath(rel) && typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))) {
    throw new Error(`${file} 的版本或文件清单无效`);
  }
  return manifest;
}

// 只扫描分发树；不跟随软链接，也不把读取错误误当成空目录。
function scanTree(root, version) {
  if (!lstatSync(root).isDirectory()) throw new Error(`${root} 不是普通目录`);
  if (jsonFile(join(root, "package.json"))?.version !== version) throw new Error(`${root} 的 package.json 版本不是 ${version}`);
  const files = {};
  const addFile = (rel) => {
    if (!validPath(rel)) throw new Error(`不支持分发文件路径 ${rel}`);
    files[rel] = createHash("sha256").update(plainFile(join(root, rel))).digest("hex");
  };
  const walk = (rel) => {
    if (!lstatSync(join(root, rel)).isDirectory()) throw new Error(`${join(root, rel)} 不是普通目录`);
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else addFile(child);
    }
  };
  for (const dir of DIRECTORIES) walk(dir);
  addFile("package.json");
  for (const name of REQUIRED_FILES) {
    if (!Object.hasOwn(files, name)) throw new Error(`${join(root, name)} 缺失`);
  }
  return { version, files };
}

function treeDrift(expected, actual) {
  for (const [rel, hash] of Object.entries(expected)) {
    if (!Object.hasOwn(actual, rel)) return `${rel} 缺失`;
    if (actual[rel] !== hash) return `${rel} 内容被改动`;
  }
  for (const rel of Object.keys(actual)) {
    if (!Object.hasOwn(expected, rel)) return `${rel} 不在清单中`;
  }
  return null;
}

function verifyTree(dir, manifest) {
  try {
    const reason = treeDrift(manifest.files, scanTree(dir, manifest.version).files);
    return reason ? { ok: false, reason } : { ok: true, files: Object.keys(manifest.files).length };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

export function verifyVersion({ version = packageVersion() } = {}) {
  try {
    const dir = versionDir(version);
    if (!statIfPresent(dir)) return { ok: false, reason: `版本 ${version} 未安装` };
    return verifyTree(dir, readManifest(dir, version));
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

const versionLockPath = (version) => join(storeRoot(), ".locks", version);
const backupPath = (version) => join(storeRoot(), `.repair-${version}`);

function versionLock(version, action) {
  const lock = versionLockPath(version);
  inspectDirectory(lock, { allowSymlinks: true });
  return withInstallLock(lock, action);
}

function checkIdentity(dir, incoming) {
  let manifest;
  try {
    manifest = readManifest(dir, incoming.version);
  } catch (error) {
    throw new Error(`无法确认 ${dir} 的版本内容，未覆盖该目录。请先人工检查并移开: ${error.message}`);
  }
  if (treeDrift(manifest.files, incoming.files)) {
    throw new Error(`版本 ${incoming.version} 已经安装在 ${dir}，内容与待安装代码不同。版本目录按版本号不可变：改了门禁代码先升版本号再安装。`);
  }
  return manifest;
}

function publishState(target, backup, incoming) {
  const exists = Boolean(statIfPresent(target));
  const healthy = exists && verifyTree(target, checkIdentity(target, incoming)).ok;
  const repairing = !healthy && Boolean(statIfPresent(backup));
  if (repairing) checkIdentity(backup, incoming);
  return { exists, healthy, repairing };
}

function discardScratch(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败时保留隐藏目录，不影响正式版本或覆盖原始错误。
  }
}

/** 当前源码和历史标签共用发布器，正式目录只由同盘 rename 产生。 */
function publishTree(source, version) {
  const target = versionDir(version);
  const backup = backupPath(version);
  const incoming = scanTree(source, version);
  return versionLock(version, () => {
    const { exists, healthy, repairing } = publishState(target, backup, incoming);
    if (healthy) return { version, dir: target, existed: true };

    const stage = mkdtempSync(join(storeRoot(), `.stage-${version}-`));
    let quarantine;
    try {
      for (const dir of DIRECTORIES) mkdirSync(join(stage, dir));
      for (const rel of Object.keys(incoming.files)) {
        const dest = join(stage, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(join(source, rel), dest);
      }
      writeFileSync(join(stage, "MANIFEST.json"), `${JSON.stringify(incoming, null, 2)}\n`, { flag: "wx" });
      const integrity = verifyTree(stage, readManifest(stage, version));
      if (!integrity.ok) throw new Error(`版本 ${version} 暂存校验失败: ${integrity.reason}`);

      if (exists) {
        if (repairing) quarantine = mkdtempSync(join(storeRoot(), `.quarantine-${version}-`));
        renameSync(target, quarantine ? join(quarantine, version) : backup);
      }
      // 修复中断时，备份中的原清单仍保留版本身份，下一次不能用另一份代码补位。
      renameSync(stage, target);
      if (exists || repairing) discardScratch(backup);
      return { version, dir: target, existed: false, files: integrity.files };
    } finally {
      discardScratch(stage);
      if (quarantine) discardScratch(quarantine);
    }
  });
}

export function publishVersion({ version = packageVersion() } = {}) {
  return publishTree(PACKAGE_ROOT, version);
}

function candidates() {
  if (!statIfPresent(storeRoot())) return [];
  return readdirSync(storeRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && VERSION.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** 按语义化版本比较：先比主次补丁号，同号时正式版高于预发布版；构建元数据不参与比较。 */
export function compareVersions(a, b) {
  const parse = (value) => {
    const [core, pre = null] = value.split("+")[0].split(/-(.*)/s);
    return { nums: core.split(".").map(Number), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) if (left.nums[i] !== right.nums[i]) return left.nums[i] - right.nums[i];
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre.localeCompare(right.pre, undefined, { numeric: true });
}

/** 本机已安装且校验通过、比给定版本新的版本，从旧到新；只校验更新的候选，避免逐个哈希全部旧版本。 */
export function newerVersions(version) {
  return candidates()
    .filter((item) => compareVersions(item, version) > 0)
    .sort(compareVersions)
    .filter((item) => verifyVersion({ version: item }).ok);
}

export function listVersions() {
  return candidates().filter((version) => verifyVersion({ version }).ok);
}

export function pruneVersions({ keep = [], dryRun = false } = {}) {
  const keepSet = new Set(keep);
  const removed = [];
  for (const version of candidates()) {
    if (keepSet.has(version)) continue;
    const remove = () => {
      if (!verifyVersion({ version }).ok) return;
      if (!dryRun) {
        const trash = mkdtempSync(join(storeRoot(), `.prune-${version}-`));
        try {
          renameSync(versionDir(version), join(trash, version));
        } finally {
          discardScratch(trash);
        }
      }
      removed.push(version);
    };
    if (dryRun) remove();
    else versionLock(version, remove);
  }
  return { removed, kept: [...keepSet], dryRun };
}

export function resolveVersionTag(version) {
  versionDir(version);
  const tag = `v${version}`;
  const ref = git(PACKAGE_ROOT, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
  if (ref.status !== 0) {
    throw new Error(
      `项目锁定的版本是 ${version}，但 ${PACKAGE_ROOT} 里没有标签 ${tag}。` +
        `先在 harness 仓库 git fetch --tags；或者把项目升级到当前版本 ${packageVersion()}（在任务分支运行 harness upgrade）`,
    );
  }
  return { tag, commit: ref.stdout.trim() };
}

function withVersionSource(version, action) {
  if (version === packageVersion()) return action(PACKAGE_ROOT);
  const { tag, commit } = resolveVersionTag(version);
  const tmp = mkdtempSync(join(tmpdir(), "harness-tag-"));
  try {
    const tar = join(tmp, "code.tar");
    const archived = git(PACKAGE_ROOT, ["archive", "--format=tar", `--output=${tar}`, commit, ...DIRECTORIES, "package.json"]);
    if (archived.status !== 0) throw new Error(`导出标签 ${tag} 失败: ${archived.stderr.trim()}`);
    const extracted = run("tar", ["-xf", tar, "-C", tmp]);
    if (extracted.status !== 0) throw new Error(`解开标签 ${tag} 失败: ${extracted.stderr.trim()}`);
    return action(tmp, tag);
  } finally {
    discardScratch(tmp);
  }
}

/** 不写版本库；发布器在持有版本锁后仍会检查身份和完整性。 */
export function planVersionInstall({ version }) {
  const dir = versionDir(version);
  if (version !== packageVersion() && verifyVersion({ version }).ok) return { dir, action: "复用" };
  inspectDirectory(versionLockPath(version), { allowSymlinks: true });
  return withVersionSource(version, (source, tag) => {
    const { exists, healthy, repairing } = publishState(dir, backupPath(version), scanTree(source, version));
    if (healthy) return { dir, action: "复用" };
    inspectDirectory(storeRoot(), { allowSymlinks: true });
    return { dir, action: `${tag ? "从标签" : ""}${exists || repairing ? "修复" : "安装"}`, tag };
  });
}

/** 只装版本，不写项目文件或刷新钩子。健康的历史版本不需要标签即可复用。 */
export function installVersion({ version }) {
  if (version === undefined) throw new Error("请指定需要安装的版本号");
  const dir = versionDir(version);
  if (version !== packageVersion() && verifyVersion({ version }).ok) return { version, dir, existed: true, fromTag: false };
  return withVersionSource(version, (source, tag) => ({ ...publishTree(source, version), fromTag: Boolean(tag) }));
}
