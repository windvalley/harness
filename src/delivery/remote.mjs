import { showBlob } from "../lib/git.mjs";

/**
 * 远程操作只在这里发生，命令与参数集中一处，便于核对 harness 到底能对远程做哪些事。
 * 全部是普通推送与普通读取：不强推，不推主分支，不在平台上合并。
 */

/** 取得远程主分支的最新提交，同时更新远程跟踪引用。失败时抛 fetch_failed。 */
export function fetchRemoteMain({ root, remote, mainRef, run }) {
  const refspec = `+refs/heads/${mainRef}:refs/remotes/${remote}/${mainRef}`;
  const result = run("git", ["fetch", "--no-tags", remote, refspec], { cwd: root });
  if (result.status !== 0) {
    const error = new Error(
      [
        `取得 ${remote} 的 ${mainRef} 失败: ${(result.stderr || result.stdout).trim().split("\n").slice(-6).join("\n")}`,
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
  const combined = `${result.stdout}\n${result.stderr}`;
  const diverged = /non-fast-forward|\[rejected\]|fetch first|remote contains work/i.test(combined);
  const error = new Error(
    [
      diverged
        ? `远程 ${remote} 上的 ${branch} 已经有别的提交，不能覆盖: `
        : `推送 ${branch} 到 ${remote} 失败: `,
      combined.trim().split("\n").slice(-8).join("\n"),
      diverged
        ? `远程分支与本地不一致，需要保留远程历史时先弄清是谁推的；确认要以本地为准时由人明确授权后自行处理，harness 不强推。`
        : "确认远程可写、分支名没有被保护规则拦住后重试。",
    ].join("\n"),
  );
  error.code = diverged ? "push_rejected" : "push_failed";
  throw error;
}

/** 目标提交锁定的 harness 版本：优先 .harness/VERSION，没有时从入口 shim 里解析。 */
export function pinnedVersionAt(root, ref) {
  const version = showBlob(root, ref, ".harness/VERSION");
  if (version !== null && version.trim()) return version.trim();
  const shim = showBlob(root, ref, ".harness/bin/harness");
  if (shim === null) return null;
  return shim.match(/:-([0-9][^}"]*)\}/)?.[1] ?? null;
}
