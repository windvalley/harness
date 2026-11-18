#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const USAGE = `用法:
  node scripts/release.mjs ensure --tag <vX.Y.Z> --commit <完整SHA> --notes-file <文件> --repository <owner/repo>
  node scripts/release.mjs audit  --tag <vX.Y.Z> --commit <完整SHA> --notes-file <文件> --repository <owner/repo>

ensure 只补建缺失且 tag 身份匹配的 Release；audit 只读，不写 tag 或 Release。`;

function execute(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr || result.error?.message || "" };
}

function validate({ tag, commit, notes, repository }) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error(`tag 必须是 vX.Y.Z: ${tag ?? ""}`);
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("commit 必须是完整的 40 位 SHA");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) throw new Error(`repository 必须是 owner/repo: ${repository ?? ""}`);
  if (typeof notes !== "string" || !notes.trim()) throw new Error("发布正文不能为空");
}

function checked(cmd, args, exec) {
  const result = exec(cmd, args);
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} 失败: ${result.stderr.trim() || `退出码 ${result.status}`}`);
  return result.stdout;
}

function readRelease({ tag, repository }, exec) {
  const fields = "tagName,targetCommitish,body,isDraft,isPrerelease,url";
  const result = exec("gh", ["release", "view", tag, "--repo", repository, "--json", fields]);
  if (result.status === 0) {
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(`Release ${tag} 查询结果不是有效 JSON`);
    }
  }
  if (/not found/i.test(result.stderr)) return null;
  throw new Error(`查询 Release ${tag} 失败: ${result.stderr.trim() || `退出码 ${result.status}`}`);
}

function remoteTagCommit(tag, exec) {
  const output = checked("git", ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], exec);
  let direct = null;
  let peeled = null;
  for (const line of output.split("\n").filter(Boolean)) {
    const [sha, ref] = line.split("\t");
    if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error(`tag ${tag} 的远端响应无效`);
    if (ref === `refs/tags/${tag}`) direct = sha;
    else if (ref === `refs/tags/${tag}^{}`) peeled = sha;
  }
  return peeled ?? direct;
}

function assertRelease(release, { tag, commit, notes }, remoteCommit) {
  if (!release) throw new Error(`Release ${tag} 不存在`);
  if (remoteCommit !== commit) throw new Error(`tag ${tag} 的实际提交与发布提交不一致`);
  if (release.tagName !== tag) throw new Error(`Release 名称与 tag ${tag} 不一致`);
  if (release.targetCommitish !== commit) throw new Error(`Release ${tag} 的目标提交与发布提交不一致`);
  if (release.body?.replaceAll("\r\n", "\n").trimEnd() !== notes.replaceAll("\r\n", "\n").trimEnd()) {
    throw new Error(`Release ${tag} 正文与已确认的发布说明不一致`);
  }
  if (release.isDraft || release.isPrerelease) throw new Error(`Release ${tag} 仍是草稿或预发布`);
}

export function auditRelease({ tag, commit, notes, repository, exec = execute }) {
  const input = { tag, commit, notes, repository };
  validate(input);
  const release = readRelease(input, exec);
  const remoteCommit = remoteTagCommit(tag, exec);
  assertRelease(release, input, remoteCommit);
  return { status: "verified", tag, commit, url: release.url };
}

export function ensureRelease({ tag, commit, notes, notesFile, repository, exec = execute }) {
  const input = { tag, commit, notes, repository };
  validate(input);
  if (typeof notesFile !== "string" || !notesFile) throw new Error("ensure 需要 notesFile");
  const existing = readRelease(input, exec);
  const remoteCommit = remoteTagCommit(tag, exec);
  if (existing) {
    assertRelease(existing, input, remoteCommit);
    return { status: "existing", tag, commit, url: existing.url };
  }
  if (remoteCommit && remoteCommit !== commit) throw new Error(`tag ${tag} 指向其他提交，拒绝补建 Release`);
  checked(
    "gh",
    ["release", "create", tag, "--repo", repository, "--target", commit, "--title", tag, "--notes-file", notesFile, "--latest"],
    exec,
  );
  const audited = auditRelease({ ...input, exec });
  return { ...audited, status: "created" };
}

function parseCli(args) {
  const command = args[0];
  if (!command || ["--help", "-h"].includes(command)) return { help: true };
  if (!["ensure", "audit"].includes(command)) throw new Error(`未知操作: ${command}`);
  const input = {};
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const key = { "--tag": "tag", "--commit": "commit", "--notes-file": "notesFile", "--repository": "repository" }[flag];
    if (!key || args[index + 1] === undefined) throw new Error(`无效或缺失参数: ${flag}`);
    input[key] = args[index + 1];
  }
  return { command, input };
}

export function main(args = process.argv.slice(2), exec = execute) {
  const { command, input, help } = parseCli(args);
  if (help) {
    console.log(USAGE);
    return 0;
  }
  const notes = readFileSync(input.notesFile ?? "", "utf8");
  const result = command === "audit" ? auditRelease({ ...input, notes, exec }) : ensureRelease({ ...input, notes, exec });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
