import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locatePath } from "../lib/git.mjs";
import { dataDir, readLedger } from "../lib/store.mjs";
import { locateSegments } from "../policy/engine.mjs";

// 会话与任务分支的关联：实时拦截看到 Agent 在哪些任务分支上动过手，收尾检查就核对哪些分支。
// 会话常停在主 Worktree、用 cd 去任务 Worktree 干活，所以不按会话目录判断，而按每次调用实际落在哪个分支记录。

// 推进交付的 harness 命令；Agent 按规则都会写 --branch。只列计划、只做核对的 --plan 与 --dry-run 不算。
const DELIVERY_STEP = /(?:^|[\s/])harness(?:\.mjs)?\s+(?:approve|verify|review|merge|submit)\b/;
const PREVIEW_FLAG = /\s--(?:plan|dry-run)\b/;
const BRANCH_FLAG = /\s--branch(?:=|\s+)("[^"]+"|'[^']+'|[^\s;&|]+)/;
// 会话记录保留的天数，过期的在新会话写入时顺带清掉。
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function taskBranch(branch) {
  return branch && !["main", "master"].includes(branch) ? branch : null;
}

// 引号里的文字（提交信息、--note 原话）不是命令，提到 harness review 也不算推进交付。
function maskQuoted(text) {
  return text.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
}

/**
 * 一次工具调用涉及的任务分支。
 * 写文件按落点所在 Worktree 的分支；命令里认推进交付的 harness 命令（--branch）与 git commit（按它执行的目录）。
 */
export function callBranches({ root, call, context, cwd }) {
  if (call.kind === "write") {
    const branch = context.outsideRepo ? null : taskBranch(context.branch);
    return branch ? [branch] : [];
  }
  if (call.kind !== "shell" || !call.command) return [];
  const branches = new Set();
  for (const segment of locateSegments(String(call.command), cwd)) {
    const command = maskQuoted(segment.norm);
    if (DELIVERY_STEP.test(command)) {
      if (PREVIEW_FLAG.test(command)) continue;
      const flag = segment.norm.match(BRANCH_FLAG);
      const branch = taskBranch(flag?.[1].replace(/^["']|["']$/g, ""));
      if (branch) branches.add(branch);
    } else if (/^git\s+commit\b/.test(command) && segment.dir) {
      const place = locatePath(root, segment.dir);
      const branch = place.outsideRepo ? null : taskBranch(place.branch);
      if (branch) branches.add(branch);
    }
  }
  return [...branches];
}

function sessionsDir(root) {
  const dir = join(dataDir(root), "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionFile(root, client, session) {
  const key = createHash("sha256").update(`${client}:${session}`).digest("hex").slice(0, 32);
  return join(sessionsDir(root), `${key}.json`);
}

export function readSession(root, { client, session }) {
  const file = sessionFile(root, client, session);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function saveSession(root, state) {
  const file = sessionFile(root, state.client, state.session);
  // 并行的工具调用会同时写，先写临时文件再改名，读到的总是完整内容。
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, file);
}

function pruneSessions(root) {
  const dir = sessionsDir(root);
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > SESSION_TTL_MS) rmSync(file, { force: true });
    } catch {
      // 并发清理时文件可能已经不在。
    }
  }
}

/** 记下会话涉及的任务分支；已经记过的不再写文件。 */
export function noteSession(root, { client, session, branches }) {
  if (!session || branches.length === 0) return;
  const existing = readSession(root, { client, session });
  const state = existing ?? { client, session, branches: {} };
  const fresh = branches.filter((branch) => !state.branches[branch]);
  if (fresh.length === 0) return;
  if (!existing) pruneSessions(root);
  const at = new Date().toISOString();
  for (const branch of fresh) state.branches[branch] = { since: at };
  saveSession(root, state);
}

/** 收尾检查放行过的“没有上报阻塞就结束”：只认针对分支当前顶端的最后一次，分支之后有新提交就不再提示。 */
export function unresolvedStop(root, branch, head) {
  const last = readLedger(root)
    .filter((event) => event.event === "stop.unresolved" && event.branch === branch)
    .at(-1);
  return last && last.head === head ? last : null;
}
