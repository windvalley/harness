import { showBlob } from "../lib/git.mjs";
import { tail } from "../lib/redact.mjs";

/**
 * 远程操作只在这里发生，命令与参数集中一处，便于核对 harness 到底能对远程做哪些事。
 * 全部是普通推送与普通读取：不强推，不在平台上合并。
 * 主分支只在本地交付开启 delivery.push 时由 harness merge 推送，见 pushMain；submit 与 sync 不推主分支。
 */

/**
 * 本地主分支与远程主分支各有对方没有的提交时的处理说明。harness sync 只会快进，分叉时它也拒绝，所以不能让提示指向 sync。
 * 只描述由人在自己的终端做什么：先留底，再对齐远程，已合并的任务分支还在，重新 merge 会基于新主分支重新验证。
 */
export function divergedGuidance({ remote, mainRef }) {
  return [
    `本地 ${mainRef} 与 ${remote}/${mainRef} 已分叉：两边各有对方没有的提交，harness sync 只能快进，处理不了。`,
    `先用 git log ${remote}/${mainRef}..${mainRef} 看本地多出的提交；它们若都来自 harness merge，对应的任务分支还在，工作不会丢。`,
    `由人在自己的终端决定，并先留底：git branch backup/${mainRef}-diverged ${mainRef}；`,
    `然后 HARNESS_MAIN_BYPASS=1 git reset --hard ${remote}/${mainRef} 把本地 ${mainRef} 对齐远程（丢弃本地多出的合并提交，需要明确授权），`,
    "再把那些任务分支逐个重新 harness merge，它们会基于新的主分支重新验证。",
  ].join("\n");
}

/** 取得远程主分支的最新提交，同时更新远程跟踪引用。失败时抛 fetch_failed。 */
export function fetchRemoteMain({ root, remote, mainRef, run }) {
  const refspec = `+refs/heads/${mainRef}:refs/remotes/${remote}/${mainRef}`;
  const result = run("git", ["fetch", "--no-tags", remote, refspec], { cwd: root });
  if (result.status !== 0) {
    const error = new Error(
      [
        `取得 ${remote} 的 ${mainRef} 失败: ${tail(result.stderr || result.stdout)}`,
        `先确认远程可访问，例如 git remote get-url ${remote} 与 git ls-remote ${remote} ${mainRef}；`,
        "连不上远程时本地主分支与远程都保持原样。",
      ].join("\n"),
    );
    error.code = "fetch_failed";
    throw error;
  }
  return `refs/remotes/${remote}/${mainRef}`;
}

/**
 * 把某个提交普通推送到远程的同名任务分支。
 * 用 <提交>:<引用> 的形式而不是按分支名推：推上去的一定是核对过的那个提交，核对之后分支再动也影响不到它。
 * 远程分支已存在且不是这个提交的祖先时，git 自己会以 non-fast-forward 拒绝，这里不加强制推送。
 */
export function pushCommit({ root, remote, branch, commit, run }) {
  const result = run("git", ["push", "--porcelain", remote, `${commit}:refs/heads/${branch}`], { cwd: root });
  if (result.status === 0) return { pushed: true };
  const combined = tail(`${result.stdout}\n${result.stderr}`, 8);
  const diverged = /non-fast-forward|\[rejected\]|fetch first|remote contains work/i.test(combined);
  const error = new Error(
    [
      diverged
        ? `远程 ${remote} 上的 ${branch} 已经有别的提交，不能覆盖: `
        : `推送 ${branch} 到 ${remote} 失败: `,
      combined,
      diverged
        ? `远程分支与本地不一致，需要保留远程历史时先弄清是谁推的；确认要以本地为准时由人明确授权后自行处理，harness 不强推。`
        : "确认远程可写、分支名没有被保护规则拦住后重试。",
    ].join("\n"),
  );
  error.code = diverged ? "push_rejected" : "push_failed";
  throw error;
}

/**
 * 本地交付开启 delivery.push 后，把 harness merge 核对并合入的那个提交普通推送到远程主分支。
 * 按提交号推，不按分支名推：合并之后主分支再动也影响不到推上去的内容；--no-follow-tags 防止 push.followTags 把标签带出去。
 * 失败后问一次远程的真实状态，区分“已经更新”“没有更新”“无法确认”，调用方据此提示由人做什么。
 */
export function pushMain({ root, remote, mainRef, commit, previous, run }) {
  const result = run("git", ["push", "--porcelain", "--no-follow-tags", remote, `${commit}:refs/heads/${mainRef}`], { cwd: root });
  if (result.status === 0) return { pushed: true };
  const combined = tail(`${result.stdout}\n${result.stderr}`, 8);
  let tip;
  try {
    tip = remoteBranchTip({ root, remote, branch: mainRef, run });
  } catch {
    tip = undefined;
  }
  if (tip === commit) return { pushed: true, recovered: true };
  const state = tip === undefined ? "unknown" : tip === previous ? "unchanged" : "moved";
  const diverged = /non-fast-forward|\[rejected\]|fetch first|remote contains work/i.test(combined);
  const stateText = {
    unchanged: "远程 " + mainRef + " 没有变化",
    unknown: `无法确认远程 ${mainRef} 是否已经更新，先用 git ls-remote ${remote} ${mainRef} 查看`,
    moved: `远程 ${mainRef} 现在指向 ${String(tip).slice(0, 10)}，不是刚才推送的提交`,
  }[state];
  const error = new Error(
    [
      `本地 ${mainRef} 已更新到 ${commit.slice(0, 10)}，但推送到 ${remote} 失败（${stateText}）:`,
      combined,
      diverged
        ? `远程主分支已有本地没有的提交，harness 不强推。\n${divergedGuidance({ remote, mainRef })}`
        : "确认远程可写、主分支没有被保护规则拦住后，由人推送主分支。",
    ].join("\n"),
  );
  error.code = diverged ? "push_rejected" : "push_failed";
  error.remoteState = state;
  throw error;
}

/**
 * 远程同名分支当前的顶端，直接问远程。
 * 不用本地 refs/remotes/<remote>/<branch>：submit 只 fetch 主分支，那里的引用可能是旧的，
 * 据此跳过推送会在远程分支已被改写或删除时把没推上去的提交当成已推送。
 */
export function remoteBranchTip({ root, remote, branch, run }) {
  const result = run("git", ["ls-remote", "--heads", remote, `refs/heads/${branch}`], { cwd: root });
  if (result.status !== 0) {
    const error = new Error(`查询 ${remote} 的 ${branch} 失败: ${tail(result.stderr || result.stdout, 4)}`);
    error.code = "fetch_failed";
    throw error;
  }
  const line = result.stdout.trim().split("\n").find(Boolean);
  return line ? line.split("\t")[0] : null;
}

/**
 * 目标提交锁定的 harness 版本。.harness/VERSION 决定 install --local 装哪一份，
 * 入口 shim 里写的版本决定钩子与命令实际运行哪一份；两者不一致时返回 mismatch，调用方应拒绝。
 */
export function pinnedVersionAt(root, ref) {
  const file = showBlob(root, ref, ".harness/VERSION")?.trim() || null;
  const shimText = showBlob(root, ref, ".harness/bin/harness");
  const shim = shimText?.match(/:-([0-9][^}"]*)\}/)?.[1] ?? null;
  return { version: file ?? shim, file, shim, mismatch: Boolean(file && shim && file !== shim) };
}
