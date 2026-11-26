import { accessSync, constants, lstatSync, readlinkSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

export function statIfPresent(file, options) {
  try {
    return lstatSync(file, options);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function requireDirectory(dir, stat = statIfPresent(dir)) {
  if (stat && !stat.isDirectory()) {
    throw new Error(`${stat.isSymbolicLink() ? "父目录是符号链接" : "路径不是目录"}: ${dir}`);
  }
}

export function parentDirectories(file, base) {
  const parents = [];
  let dir = dirname(file);
  while (dir !== base && dirname(dir) !== dir) {
    parents.unshift(dir);
    dir = dirname(dir);
  }
  return parents;
}

export function checkParent(dir, stat) {
  // macOS 的系统路径别名不是项目可替换的父目录。
  if (process.platform === "darwin" && ["/tmp", "/var", "/etc"].includes(dir) && stat?.isSymbolicLink() &&
      [`private${dir}`, `/private${dir}`].includes(readlinkSync(dir))) return;
  requireDirectory(dir, stat);
}

/**
 * 检查写入目录是否存在、是否可写。默认拒绝路径上任何一层符号链接。
 * allowSymlinks 用于用户自己的共享目录（版本库、证据密钥、DSH 插件）：
 * 它们的祖先可能来自 $HOME、挂载点或 dotfiles 布局，不是项目里可被替换的目录；
 * 目录里的具体文件仍按普通文件检查，不跟随链接写入。
 */
export function inspectDirectory(path, { writable = true, allowSymlinks = false } = {}) {
  const dir = resolve(path);
  let existing = sep;
  for (const parent of parentDirectories(dir)) {
    const stat = statIfPresent(parent);
    if (!allowSymlinks) checkParent(parent, stat);
    if (stat) existing = parent;
  }
  const stat = statIfPresent(dir);
  if (allowSymlinks) requireDirectory(dir, stat?.isSymbolicLink() ? statSync(dir) : stat);
  else checkParent(dir, stat);
  if (writable) accessSync(stat ? dir : existing, constants.W_OK | constants.X_OK);
  return Boolean(stat);
}
