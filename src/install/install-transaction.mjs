import { createHash, randomBytes } from "node:crypto";
import {
  accessSync, closeSync, constants, existsSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  readlinkSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { commonDir, git, hooksPlacement, repoRoot, run } from "../lib/git.mjs";
import { liveLockHolders, withInstallLock } from "./install-lock.mjs";
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

function notRegularError(file, state) {
  return new Error(
    state?.type === "link"
      ? `${file} 是符号链接，不跟随链接写入目标文件；确认要把它替换成普通文件时，用 --force 或 --take-over 重新运行`
      : `${file} 不是普通文件`,
  );
}

export function readRegularText(file) {
  const state = pathState(file);
  if (state && state.type !== "file") throw notRegularError(file, state);
  return state ? textOf(state) : null;
}

/** 读取链接指向的普通文件内容；只在显式接管时用于生成计划，写入仍替换链接本身。 */
function readLinkTarget(file) {
  const target = resolve(dirname(file), readlinkSync(file));
  const stat = statIfPresent(target);
  if (!stat || !stat.isFile()) throw new Error(`${file} 是符号链接，但目标不是普通文件，请先处理这个链接`);
  return readRegularText(target);
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

/**
 * takeOverLinks 表示调用方带上了显式接管参数（--force 或 --take-over）：
 * 文件级软链允许替换链接本身，不跟随写入目标文件；目录级软链始终拒绝。
 */
export function createProjectChanges(root, common, { takeOverLinks = false } = {}) {
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
      if (planned.after.type !== "file") throw notRegularError(file, planned.after);
      return textOf(planned.after);
    }
    const before = pathState(file);
    // 类型检查先于内容校验：不带接管参数时，软链在读阶段就报出来，不让用户先修内容再撞链接。
    if (before?.type === "link") return takeOverLinks ? readLinkTarget(file) : readRegularText(file);
    if (before && before.type !== "file") throw notRegularError(file, before);
    return before ? textOf(before) : null;
  };
  const set = (file, content, { mode, allowLink = takeOverLinks, directory = false } = {}) => {
    inspectParents(file, false);
    const before = pathState(file);
    if (directory && before?.type === "dir") return false;
    if (before && before.type !== "file" && !(allowLink && before.type === "link")) throw notRegularError(file, before);
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

// 分支引用是否成立交给 Git 判定：自己写的记录必须能被自己读回，不能比 Git 更严。
export function validBranchRef(value) {
  return value === "" || run("git", ["check-ref-format", value]).status === 0;
}

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

function invalidJournal(location, detail) {
  return new Error(
    `安装恢复记录格式无效: ${location.file}${detail ? `（${detail}）` : ""}。` +
      `请核对记录与同目录的私有备份；无法自动恢复时，可把 ${location.dir} 移开后重新安装`,
  );
}

function journal(location) {
  const { dir, file } = location;
  const stat = statIfPresent(dir);
  requireDirectory(dir, stat);
  const item = statIfPresent(file);
  if (stat && !asPrivate(stat)) throw new Error(`安装状态目录权限不是仅本人可访问: ${dir}`);
  if (!item) return null;
  if (!asPrivate(item) || !item.isFile()) throw new Error(`安装恢复记录不是私有普通文件: ${file}`);
  let state;
  try {
    state = parseInstallJson(readRegularText(file), file);
  } catch (error) {
    throw invalidJournal(location, error.message);
  }
  const seen = new Set();
  if (state.version !== 1 || !["init", "upgrade", "install", "install --local"].includes(state.command) ||
      !["应用", "回滚"].includes(state.phase) || !absolute(state.root) || !absolute(state.hooksDir) ||
      typeof state.branch !== "string" || !validBranchRef(state.branch) ||
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
    throw invalidJournal(location);
  }
  return state;
}

/**
 * 待恢复记录的当前状态：active 表示还有安装进程持有锁，正在写入；stale 表示进程已不在，可以恢复。
 * 锁目录里的持有者文件在安装全程存在，崩溃后残留，正是判断“进行中还是已中断”的现成依据。
 */
export function pendingInstallState(location) {
  const state = journal(location);
  if (!state) return null;
  const checkout = [state.branch.replace(/^refs\/heads\//, ""), state.head || "未提交"].filter(Boolean).join(" @ ");
  const summary = `${state.command}（${state.phase}阶段，Worktree ${state.root}，检出 ${checkout}）留有安装恢复记录 ${location.file}`;
  const holders = liveLockHolders(location.lock);
  if (holders.length > 0) {
    return { status: "active", holders, detail: `${summary}；另一个安装正在进行（pid ${holders.map((item) => item.pid).join("、")}），完成后再继续` };
  }
  return { status: "stale", holders: [], detail: `${summary}。${commandHint}` };
}

export function pendingInstall(location) {
  const found = pendingInstallState(location);
  return found ? found.detail : null;
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
  const ref = branch.stdout.trim();
  // 写入端先按同一规则校验，不写出自己读不回的恢复记录。
  if (!validBranchRef(ref)) throw new Error(`分支引用无效，无法记录本次安装: ${ref}`);
  return {
    root,
    branch: ref,
    head: head.stdout.trim(),
  };
}

function checkCheckout(root, state) {
  const current = installCheckout(root);
  if (current.root !== state.root || current.branch !== state.branch || current.head !== state.head) {
    throw new Error(
      `当前检出与安装记录不一致，请回到原 Worktree 和检出: ${state.root} (${state.branch || state.head})。` +
        "回不去时用 harness install --recover --adopt 尽力回滚，或 --recover --abandon 只归档记录与备份",
    );
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
  unlinkPresent(join(location.dir, ".state.tmp"));
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

/**
 * 逐项恢复。strict 用于默认恢复：目标既不是安装前也不是本次写入后的状态时保留现状并让整次恢复失败；
 * adopt 用于显式放弃：保留现状、记入未恢复清单，其余项照常恢复。
 */
function rollback(context, location, state, { strict = true } = {}) {
  // 默认恢复要求回到原检出；显式放弃时不要求，否则原 Worktree 已删除就永远解不开。
  if (strict) checkCheckout(context.root, state);
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
        if (!isDeepStrictEqual(current, entry.after)) {
          if (strict) throw new Error("状态已变更，保留现状");
          left.push(`${entry.file}: ${existsSync(context.root) ? "中断后又被改动" : "原 Worktree 已不存在"}，保留现状`);
          state.entries[i] = null;
          save(location, state);
          continue;
        }
        change(context, location, state, i, entry, entry.after, original(location, state, i));
        expect(context, entry, entry.before);
      }
      state.entries[i] = null;
      save(location, state);
    } catch (error) {
      left.push(`${entry.file}: ${error.message}`);
    }
  }
  if (left.length > 0 && strict) {
    throw new Error(`恢复未完成，保留未恢复的项与安装记录 ${location.file}：\n  ${left.join("\n  ")}\n${commandHint}`);
  }
  return { left };
}

function finishRecovery(location) {
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
    // 先落记录再备份：备份阶段被强杀也要留下可恢复的记录，孤儿备份才有人收。
    save(location, state);
    backUp(location, state.id, entries);
  } catch (error) {
    unlinkPresent(location.file);
    try {
      clearOrphanBackups(location);
    } catch {
      // 清理失败不覆盖原始错误；下一次安装会再清一次。
    }
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
      finishRecovery(location);
    } catch (recoveryError) {
      throw new Error(`${error.message}\n${recoveryError.message}\n${commandHint}`);
    }
    throw new Error(`${error.message}\n本次项目改动已回滚`);
  }
}

export function recoverProjectInstall({ cwd, adopt = false, abandon = false }) {
  const root = repoRoot(cwd);
  const location = installLocation(commonDir(root));
  if (abandon) {
    // 记录可能已经损坏，不能先解析：只要有记录或备份就允许归档。
    if (!statIfPresent(location.file)) return { recovered: false };
    return withProjectInstallLock(location, () => ({ abandoned: true, ...archiveWithoutRecovery(location) }));
  }
  if (!journal(location)) return { recovered: false };
  return withProjectInstallLock(location, () => {
    const state = journal(location);
    if (!state) return { recovered: false };
    const context = { root, common: location.common };
    const result = rollback(context, location, state, { strict: !adopt });
    if (!adopt) {
      finishRecovery(location);
      return { recovered: true };
    }
    // --adopt：无法恢复的项连同原件一起归档，安装随即可用，输出归档路径与未恢复清单。
    return { recovered: true, adopted: true, left: result.left, ...archiveWithoutRecovery(location) };
  });
}

/** 放弃恢复：项目文件一律不动，只把记录与私有备份移进归档目录，交给人在那里取用。 */
function archiveWithoutRecovery(location) {
  const archive = archiveLocation(location);
  if (statIfPresent(location.file)) renameSync(location.file, join(archive, "state.json"));
  const backups = readdirSync(location.dir).filter((name) => /^originals-[0-9a-f]{24}$/.test(name));
  for (const name of backups) renameSync(join(location.dir, name), join(archive, name));
  return { archive, backupCount: backups.length };
}

function archiveLocation(location) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${location.dir}.${stamp}`;
  let dir = base;
  for (let i = 2; existsSync(dir); i++) dir = `${base}-${i}`;
  mkdirSync(dir, { mode: 0o700 });
  const stat = statSync(dir);
  if (!asPrivate(stat)) throw new Error(`归档目录权限不是仅本人可访问: ${dir}`);
  return dir;
}
