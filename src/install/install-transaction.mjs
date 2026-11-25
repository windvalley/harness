import { createHash, randomBytes } from "node:crypto";
import {
  accessSync, closeSync, constants, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync,
  renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { commonDir, git, hooksPlacement, repoRoot } from "../lib/git.mjs";
import { withInstallLock } from "./install-lock.mjs";
import { checkParent, inspectDirectory, parentDirectories, requireDirectory, statIfPresent } from "./install-paths.mjs";

const HOOKS_KEY = "core.hooksPath";
const CONFIG_STAGE = /^config-[0-9a-f]{24}$/;
export const HOOK_NAMES = ["pre-commit", "commit-msg", "reference-transaction"];
const DIRECTORY_MODE = 0o777 & ~process.umask();
const FILE_MODE = 0o666 & ~process.umask();

function inside(root, file) {
  const rel = relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function pathState(file) {
  const stat = statIfPresent(file);
  if (!stat) return null;
  const mode = stat.mode & 0o7777;
  if (stat.isDirectory()) return { type: "dir", mode };
  if (stat.isSymbolicLink()) return { type: "link", target: readlinkSync(file) };
  if (!stat.isFile()) throw new Error(`${file} 不是普通文件`);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    return { type: "file", mode, data: readFileSync(fd).toString("base64") };
  } finally {
    closeSync(fd);
  }
}

const fileState = (content, mode) => ({ type: "file", mode, data: Buffer.from(content).toString("base64") });
const textOf = (state) => Buffer.from(state.data, "base64").toString("utf8");

export function readRegularText(file) {
  const state = pathState(file);
  if (state && state.type !== "file") throw new Error(`${file} 不是普通文件`);
  return state ? textOf(state) : null;
}

export function parseInstallJson(text, file) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // 解析异常可能包含配置原文，不把它写进预检输出。
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error(`${file} 不是有效的 JSON 对象`);
  return json;
}

function configValue(root, file) {
  if (!statIfPresent(file)?.isFile()) throw new Error(`${file} 不是普通文件`);
  const result = git(root, ["config", "--file", file, "--no-includes", "--null", "--get-all", HOOKS_KEY]);
  if (result.status === 1) return null;
  if (result.status !== 0) throw new Error(`无法读取 ${file} 的 ${HOOKS_KEY}`);
  const values = result.stdout.slice(0, -1).split("\0");
  if (values.length !== 1) throw new Error(`${file} 中有多个 ${HOOKS_KEY}，请先整理为单值`);
  return values[0];
}

export function createProjectChanges(root, common) {
  const changes = new Map();
  const baseFor = (file) => inside(common, file) ? common : inside(root, file) ? root : null;
  const inspectParents = (file, create) => {
    let existing = baseFor(file) ?? sep;
    for (const dir of parentDirectories(file, baseFor(file))) {
      const stat = statIfPresent(dir);
      checkParent(dir, stat);
      if (stat) existing = dir;
      else if (create && !changes.has(dir)) changes.set(dir, { kind: "path", file: dir, before: null, after: { type: "dir", mode: DIRECTORY_MODE } });
    }
    if (create) accessSync(existing, constants.W_OK | constants.X_OK);
  };
  const read = (file) => {
    inspectParents(file, false);
    const planned = changes.get(file);
    if (planned) {
      if (!planned.after) return null;
      if (planned.after.type !== "file") throw new Error(`${file} 不是普通文件`);
      return textOf(planned.after);
    }
    return readRegularText(file);
  };
  const set = (file, content, { mode, allowLink = false, directory = false } = {}) => {
    inspectParents(file, false);
    const before = pathState(file);
    if (directory && before?.type === "dir") return false;
    if (before && before.type !== "file" && !(allowLink && before.type === "link")) {
      throw new Error(`${file} ${before.type === "link" ? "是符号链接" : "不是预期的文件类型"}`);
    }
    if (directory && before) throw new Error(`${file} 不是目录`);
    const after = directory ? { type: "dir", mode: DIRECTORY_MODE }
      : content === null ? null : fileState(content, mode ?? (before?.type === "file" ? before.mode : FILE_MODE));
    if (isDeepStrictEqual(before, after)) return false;
    if (changes.has(file)) throw new Error(`安装目标重叠: ${file}`);
    inspectParents(file, true);
    changes.set(file, { kind: "path", file, before, after });
    return true;
  };
  const config = (value) => {
    const file = join(common, "config");
    const before = configValue(root, file);
    if (before === value) return false;
    if (statIfPresent(`${file}.lock`)) throw new Error(`Git 配置正在被修改: ${file}.lock`);
    accessSync(dirname(file), constants.W_OK | constants.X_OK);
    changes.set(file, { kind: "hooks-path", file, before, after: value });
    return true;
  };
  const plannedState = (file) => {
    inspectParents(file, false);
    return changes.has(file) ? changes.get(file).after : pathState(file);
  };
  const remove = (file) => set(file, null);
  const mkdir = (dir) => changes.get(dir)?.after?.type === "dir" ? false : set(dir, null, { directory: true });
  return { entries: changes, read, set, remove, mkdir, config, stat: plannedState, exists: (file) => Boolean(plannedState(file)) };
}

function unlinkPresent(file) {
  try {
    unlinkSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function putFile(file, state, tmp, check = () => {}) {
  let created = false;
  try {
    if (state.type === "link") {
      symlinkSync(state.target, tmp);
      created = true;
    }
    else {
      const fd = openSync(tmp, "wx", 0o600);
      created = true;
      try {
        writeFileSync(fd, Buffer.from(state.data, "base64"));
        fchmodSync(fd, state.mode);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    check();
    renameSync(tmp, file);
  } finally {
    if (created) unlinkPresent(tmp);
  }
}

/** 共享资源的单文件替换，不进入项目的回滚记录。 */
export function replaceInstallFile(file, text) {
  const before = pathState(file);
  if (before && before.type !== "file") throw new Error(`${file} 不是普通文件`);
  const state = fileState(text, before?.mode ?? FILE_MODE);
  putFile(file, state, join(dirname(file), `.harness-install-${randomBytes(12).toString("hex")}`));
}

export function installLocation(common) {
  const dir = join(resolve(common), "harness-install");
  return { common: dirname(dir), dir, file: join(dir, "state.json"), lock: join(dir, "lock") };
}

const commandHint = "在记录对应的 Worktree 运行 harness install --recover（入口不可用时用新版 harness 源码 CLI）";

const digest = (data) => createHash("sha256").update(data).digest("hex");
const sha256 = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

function fingerprint(state) {
  if (state === null) return null;
  if (typeof state === "string") return digest(state);
  if (state.type === "link") return { type: "link", hash: digest(state.target) };
  if (state.type === "file") return { type: "file", mode: state.mode, hash: digest(Buffer.from(state.data, "base64")) };
  return state;
}

function validPathState(state) {
  if (state === null) return true;
  if (!state || typeof state !== "object" || typeof state.type !== "string") return false;
  if (state.type === "link") return sha256(state.hash);
  const mode = Number.isInteger(state.mode) && state.mode >= 0 && state.mode <= 0o7777;
  return mode && (state.type === "dir" || (state.type === "file" && sha256(state.hash)));
}

const absolute = (path) => typeof path === "string" && !path.includes("\0") && resolve(path) === path;
const asPrivate = (stat) => stat && (stat.mode & 0o077) === 0 && (!process.geteuid || stat.uid === process.geteuid());

function pathEntryAllowed(root, location, hooksDir, entry) {
  const { file, before, after } = entry;
  if (inside(location.dir, file) || file === location.common || file === root || file === join(location.common, "config")) return false;
  if (inside(root, file) && !inside(location.common, file) && !inside(join(root, ".git"), file)) return true;
  if (dirname(file) === hooksDir && HOOK_NAMES.includes(basename(file))) return after?.type === "file";
  return before === null && after?.type === "dir" && inside(file, hooksDir);
}

export function validateProjectInstall({ root, hooksDir }, location, entries) {
  if (inside(location.dir, hooksDir) || entries.some((entry) => entry.kind === "path" && !pathEntryAllowed(root, location, hooksDir, entry))) {
    throw new Error("安装计划包含不允许的恢复目标");
  }
  inspectDirectory(location.lock);
}

function journal(location) {
  const { dir, file } = location;
  const stat = statIfPresent(dir);
  requireDirectory(dir, stat);
  const item = statIfPresent(file);
  if (stat && !asPrivate(stat)) throw new Error(`安装状态目录权限不是仅本人可访问: ${dir}`);
  if (!item) return null;
  if (!asPrivate(item) || !item.isFile()) throw new Error(`安装恢复记录不是私有普通文件: ${file}`);
  const state = parseInstallJson(readRegularText(file), file);
  const seen = new Set();
  if (state.version !== 1 || !["init", "upgrade", "install", "install --local"].includes(state.command) ||
      !["应用", "回滚"].includes(state.phase) || !absolute(state.root) || !absolute(state.hooksDir) ||
      typeof state.branch !== "string" || (state.branch !== "" && !/^refs\/heads\/[^\s\0]+$/.test(state.branch)) ||
      typeof state.head !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})?$/.test(state.head) ||
      (!state.head && !state.branch) || typeof state.id !== "string" || !/^[0-9a-f]{24}$/.test(state.id) ||
      !Array.isArray(state.entries) || !Number.isInteger(state.started) || state.started < 0 || state.started > state.entries.length ||
      !state.entries.every((entry, index) => {
        if (entry === null) return state.phase === "回滚" && index < state.started;
        if (!entry || !absolute(entry.file) || seen.has(entry.file) || isDeepStrictEqual(entry.before, entry.after)) return false;
        seen.add(entry.file);
        if (entry.kind === "hooks-path") {
          return entry.file === join(location.common, "config") && (entry.before === null || sha256(entry.before)) && sha256(entry.after);
        }
        return entry.kind === "path" && validPathState(entry.before) && validPathState(entry.after) &&
          entry.before?.type !== "dir" && entry.after?.type !== "link" &&
          (entry.after?.type !== "dir" || entry.before === null) && pathEntryAllowed(state.root, location, state.hooksDir, entry);
      })) {
    throw new Error(`安装恢复记录格式无效: ${file}`);
  }
  return state;
}

export function pendingInstall(location) {
  const state = journal(location);
  if (!state) return null;
  const checkout = [state.branch.replace(/^refs\/heads\//, ""), state.head || "未提交"].filter(Boolean).join(" @ ");
  return `${state.command}（${state.phase}阶段，Worktree ${state.root}，检出 ${checkout}）留有安装恢复记录 ${location.file}。${commandHint}`;
}

export function withProjectInstallLock(location, action) {
  inspectDirectory(location.lock);
  mkdirSync(location.dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(location.dir);
  requireDirectory(location.dir, stat);
  if (!asPrivate(stat)) throw new Error(`安装状态目录权限不是仅本人可访问: ${location.dir}`);
  requireDirectory(location.lock);
  return withInstallLock(location.lock, action);
}

function save(location, state) {
  const tmp = join(location.dir, ".state.tmp");
  unlinkPresent(tmp);
  putFile(location.file, fileState(JSON.stringify(state), 0o600), tmp);
}

export function installCheckout(root) {
  const branch = git(root, ["symbolic-ref", "-q", "HEAD"]);
  const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (![0, 1].includes(branch.status) || (head.status !== 0 && (head.status !== 1 || branch.status !== 0))) {
    throw new Error(`无法确定安装所在的检出: ${root}`);
  }
  return {
    root,
    branch: branch.stdout.trim(),
    head: head.stdout.trim(),
  };
}

function checkCheckout(root, state) {
  const current = installCheckout(root);
  if (current.root !== state.root || current.branch !== state.branch || current.head !== state.head) {
    throw new Error(`当前检出与安装记录不一致，请回到原 Worktree 和检出: ${state.root} (${state.branch || state.head})`);
  }
}

function inspectEntry(context, entry) {
  const { root, common } = context;
  if (entry.kind === "hooks-path") {
    if (entry.file !== join(common, "config")) throw new Error("恢复记录的 Git 配置目标无效");
    return configValue(root, entry.file);
  }
  const base = inside(common, entry.file) ? common : inside(root, entry.file) ? root : null;
  for (const dir of parentDirectories(entry.file, base)) checkParent(dir, statIfPresent(dir));
  return pathState(entry.file);
}

function expect(context, entry, expected) {
  if (!isDeepStrictEqual(fingerprint(inspectEntry(context, entry)), expected)) throw new Error(`安装目标已变化，未覆盖: ${entry.file}`);
}

function scratch(entry, state, index) {
  return join(dirname(entry.file), `.harness-install-${state.id}-${index}`);
}

function unlinkOwnedConfigLock(lock, staged) {
  const holder = statIfPresent(lock, { bigint: true });
  if (!holder?.isFile()) return;
  const source = statIfPresent(staged, { bigint: true });
  if (source?.isFile() && holder.dev === source.dev && holder.ino === source.ino) unlinkPresent(lock);
}

function releaseInterruptedConfigLock(file, originals) {
  const lock = `${file}.lock`;
  if (!statIfPresent(lock)) return;
  const stat = statIfPresent(originals);
  if (stat?.isDirectory() && asPrivate(stat)) {
    for (const name of readdirSync(originals)) {
      if (CONFIG_STAGE.test(name)) unlinkOwnedConfigLock(lock, join(originals, name));
    }
  }
  if (statIfPresent(lock)) throw new Error(`Git 配置正在被修改，保留外部锁: ${lock}`);
}

function changeHooksPath(root, file, after, originals, check) {
  const previous = pathState(file);
  if (previous?.type !== "file") throw new Error(`${file} 不是普通文件`);
  const staged = join(originals, `config-${randomBytes(12).toString("hex")}`);
  putFile(staged, { ...previous, mode: 0o600 }, `${staged}.tmp`);
  // 被强杀后，仍在运行的 Git 子进程只能改私有暂存文件。
  const args = after === null ? ["--unset", HOOKS_KEY] : ["--", HOOKS_KEY, after];
  const result = git(root, ["config", "--file", staged, ...args]);
  if (result.status !== 0) throw new Error(`设置 ${HOOKS_KEY} 失败: ${file}: Git 退出码 ${result.status}`);
  const fd = openSync(staged, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fchmodSync(fd, previous.mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // 和普通 Git 写入共用 config.lock；硬链接让恢复能识别本次留下的锁。
  const lock = `${file}.lock`;
  linkSync(staged, lock);
  try {
    check();
    if (!isDeepStrictEqual(pathState(file), previous)) throw new Error(`Git 配置已变化，未覆盖: ${file}`);
    renameSync(lock, file);
  } finally {
    unlinkOwnedConfigLock(lock, staged);
  }
}

function change(context, location, state, index, entry, before, after) {
  const { file, kind } = entry;
  const check = () => expect(context, entry, before);
  check();
  if (kind === "hooks-path") {
    changeHooksPath(context.root, file, after, originalsDir(location, state.id), check);
  } else if (after?.type === "dir") mkdirSync(file, { mode: after.mode });
  else if (after) putFile(file, after, scratch(entry, state, index), check);
  else if (before?.type === "dir") rmdirSync(file);
  else unlinkSync(file);
}

function originalsDir(location, id) {
  return join(location.dir, `originals-${id}`);
}

// 原件单独保存为私有备份；进度记录只持久化路径、权限和指纹。
function backUp(location, id, entries) {
  const dir = originalsDir(location, id);
  mkdirSync(dir, { mode: 0o700 });
  for (const [i, { before }] of entries.entries()) {
    if (before === null) continue;
    const data = typeof before === "string" ? before : before.type === "link" ? before.target : Buffer.from(before.data, "base64");
    const file = join(dir, String(i));
    putFile(file, fileState(data, 0o600), `${file}.tmp`);
  }
}

function original(location, state, i) {
  const { before, kind } = state.entries[i];
  if (before === null) return null;
  const dir = originalsDir(location, state.id);
  const file = join(dir, String(i));
  const stat = statIfPresent(dir);
  const item = stat?.isDirectory() ? statIfPresent(file) : null;
  if (!asPrivate(stat) || !item?.isFile() || !asPrivate(item)) throw new Error(`安装原件缺失或不是私有普通文件: ${file}`);
  const backup = pathState(file);
  const value = kind === "hooks-path" ? textOf(backup) : before.type === "link" ? { type: "link", target: textOf(backup) } :
    { type: "file", mode: before.mode, data: backup.data };
  if (!isDeepStrictEqual(fingerprint(value), before)) throw new Error(`安装原件与记录不一致: ${file}`);
  return value;
}

function clearOrphanBackups(location) {
  for (const item of readdirSync(location.dir, { withFileTypes: true })) {
    if (!item.isDirectory() || !/^originals-[0-9a-f]{24}$/.test(item.name)) continue;
    const dir = join(location.dir, item.name);
    try {
      if (!asPrivate(lstatSync(dir))) continue;
      const files = readdirSync(dir, { withFileTypes: true });
      if (!files.every((file) => file.isFile() && /^(?:\d+(?:\.tmp)?|config-[0-9a-f]{24}(?:\.(?:tmp|lock))?)$/.test(file.name))) continue;
      for (const file of files) unlinkSync(join(dir, file.name));
      rmdirSync(dir);
    } catch {
      // 记录已经结束。无法清理的私有原件保留，下一次在持锁状态下重试。
    }
  }
}

function rollback(context, location, state) {
  checkCheckout(context.root, state);
  state.phase = "回滚";
  save(location, state);
  const left = [];
  for (let i = state.started - 1; i >= 0; i--) {
    const entry = state.entries[i];
    if (!entry) continue;
    try {
      if (entry.kind === "path" && !inside(context.root, entry.file) &&
          state.hooksDir !== resolve(hooksPlacement(context.root).dir)) throw new Error("外部 Git 钩子目录已变化，保留现状");
      if (entry.kind === "hooks-path") releaseInterruptedConfigLock(entry.file, originalsDir(location, state.id));
      const current = fingerprint(inspectEntry(context, entry));
      const tmp = scratch(entry, state, i);
      if (entry.kind === "path" && entry.after?.type !== "dir") unlinkPresent(tmp);
      if (!isDeepStrictEqual(current, entry.before)) {
        if (!isDeepStrictEqual(current, entry.after)) throw new Error("状态已变更，保留现状");
        change(context, location, state, i, entry, entry.after, original(location, state, i));
        expect(context, entry, entry.before);
      }
      state.entries[i] = null;
      save(location, state);
    } catch (error) {
      left.push(`${entry.file}: ${error.message}`);
    }
  }
  if (left.length > 0) throw new Error(`恢复未完成，保留未恢复的项与安装记录 ${location.file}：\n  ${left.join("\n  ")}\n${commandHint}`);
  unlinkSync(location.file);
  clearOrphanBackups(location);
}

/** 写前记录原状态与计划结果；只有已开始的操作才可能被恢复。 */
export function applyProjectChanges(context, location, command, entries, validate) {
  checkCheckout(context.root, context.checkout);
  clearOrphanBackups(location);
  if (entries.length === 0) return validate();
  const state = {
    version: 1, id: randomBytes(12).toString("hex"), command, phase: "应用", ...context.checkout, hooksDir: context.hooksDir,
    entries: entries.map(({ kind, file, before, after }) => ({ kind, file, before: fingerprint(before), after: fingerprint(after) })), started: 0,
  };
  try {
    backUp(location, state.id, entries);
    save(location, state);
  } catch (error) {
    if (!statIfPresent(location.file)) clearOrphanBackups(location);
    throw error;
  }
  try {
    for (const [i, entry] of entries.entries()) {
      const planned = state.entries[i];
      expect(context, planned, planned.before);
      state.started = i + 1;
      save(location, state);
      change(context, location, state, i, planned, planned.before, entry.after);
    }
    for (const entry of state.entries) expect(context, entry, entry.after);
    checkCheckout(context.root, state);
    const result = validate();
    unlinkSync(location.file);
    clearOrphanBackups(location);
    return result;
  } catch (error) {
    try {
      rollback(context, location, state);
    } catch (recoveryError) {
      throw new Error(`${error.message}\n${recoveryError.message}\n${commandHint}`);
    }
    throw new Error(`${error.message}\n本次项目改动已回滚`);
  }
}

export function recoverProjectInstall({ cwd }) {
  const root = repoRoot(cwd);
  const location = installLocation(commonDir(root));
  if (!journal(location)) return false;
  return withProjectInstallLock(location, () => {
    const state = journal(location);
    if (!state) return false;
    rollback({ root, common: location.common }, location, state);
    return true;
  });
}
