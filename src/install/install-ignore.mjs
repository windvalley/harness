import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { git, gitDir } from "../lib/git.mjs";

export const SHIM_REL = ".harness/bin/harness";
const NESTED_IGNORE = [".harness/.gitignore", ".harness/bin/.gitignore"];

function shimIgnored(root, args = []) {
  const result = git(root, [...args, "check-ignore", "--quiet", "--no-index", "--", SHIM_REL]);
  if (![0, 1].includes(result.status)) throw new Error(`Git 无法检查 ${SHIM_REL} 的忽略规则`);
  return result.status === 0;
}

function ignoredError() {
  return new Error(`入口 ${SHIM_REL} 仍被 Git 忽略，请手工调整忽略规则，否则 Linked Worktree 里没有入口`);
}

function appendException(text, pattern, eol) {
  const kept = text.split(/(?<=\n)/).filter((line) => line.trim() !== pattern).join("");
  return `${kept}${kept && !kept.endsWith("\n") ? eol : ""}${pattern}${eol}`;
}

/** 交给 Git 解析候选规则；只在私有临时目录里替换 .gitignore，沿用原仓库的 config 与 info/exclude。 */
export function planGitignore(root, changes) {
  const file = join(root, ".gitignore");
  const original = changes.read(file) ?? "";
  const nested = NESTED_IGNORE.map((rel) => [rel, changes.read(join(root, rel))]);
  let text = original.split(/(?<=\n)/).filter((line) => line.trim() !== ".harness/bin/").join("");
  if (text === original && !shimIgnored(root)) return;

  const scratch = mkdtempSync(join(tmpdir(), "harness-ignore-"));
  try {
    mkdirSync(join(scratch, dirname(SHIM_REL)), { recursive: true });
    for (const [rel, content] of nested) if (content !== null) writeFileSync(join(scratch, rel), content);
    const cmd = ["--git-dir", gitDir(root), "--work-tree", scratch];
    const excludes = git(root, ["config", "--path", "--null", "--get", "core.excludesFile"]);
    if (![0, 1].includes(excludes.status)) throw new Error("无法读取 Git 的 core.excludesFile");
    const excludeFile = excludes.stdout.slice(0, -1);
    if (excludeFile && !isAbsolute(excludeFile)) cmd.push("-c", `core.excludesFile=${resolve(root, excludeFile)}`);
    const check = () => {
      writeFileSync(join(scratch, ".gitignore"), text);
      return shimIgnored(root, cmd);
    };
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    if (check()) {
      text = appendException(text, "!.harness/bin/", eol);
      if (check()) {
        text = appendException(text, `!${SHIM_REL}`, eol);
        if (check()) throw ignoredError();
      }
    }
    if (text !== original) changes.set(file, text);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function verifyShimIgnore(root) {
  if (shimIgnored(root)) throw ignoredError();
}
