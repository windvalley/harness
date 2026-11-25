import { accessSync, constants, lstatSync, readlinkSync } from "node:fs";
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

export function inspectDirectory(path, { writable = true } = {}) {
  const dir = resolve(path);
  let existing = sep;
  for (const parent of parentDirectories(dir)) {
    const stat = statIfPresent(parent);
    checkParent(parent, stat);
    if (stat) existing = parent;
  }
  const stat = statIfPresent(dir);
  checkParent(dir, stat);
  if (writable) accessSync(stat ? dir : existing, constants.W_OK | constants.X_OK);
  return Boolean(stat);
}
