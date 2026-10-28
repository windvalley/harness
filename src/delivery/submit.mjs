import { deliveryAt, deliverySettings, describeDelivery, loadGateProject, mainBranch } from "../lib/config.mjs";
import { changedPaths, git, gitOk, isAncestor, refExists, resolveCommit, run } from "../lib/git.mjs";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { appendLedger, dataDir, readRecord, writeRecord } from "../lib/store.mjs";
import { MergeError, checkGates } from "../merge/merge.mjs";
import { fetchRemoteMain, pushCommit } from "./remote.mjs";
import { createRequest, findOpen, managedSection, platformStatus, replaceManagedSection, updateRequest } from "./platform.mjs";

/** 提交记录：按任务提交索引，分“已推送”与“MR 已就绪”两个阶段，重试时据此跳过已完成的步骤。 */
export const SUBMIT_KIND = "submit";

export function submitKey(commit) {
  return commit;
}

export function readSubmit({ root, branch, commit }) {
  const record = readRecord(root, SUBMIT_KIND, submitKey(commit));
  if (!record.ok) return { ok: false, reason: record.reason };
  if (record.record.branch !== branch) return { ok: false, reason: `提交记录属于分支 ${record.record.branch}` };
  return { ok: true, record: record.record };
}

/**
 * 分支最近一次提交记录，不管它是不是当前顶端：status 要据此区分“没有提交过”与“提交后分支又前进了”。
 * 记录按提交索引，这里取该分支里时间最新的那条。
 */
export function latestSubmit({ root, branch }) {
  const dir = join(dataDir(root), SUBMIT_KIND);
  if (!existsSync(dir)) return { ok: false, reason: "没有提交记录" };
  let best = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const record = readRecord(root, SUBMIT_KIND, name.slice(0, -".json".length));
    if (!record.ok || record.record.branch !== branch) continue;
    if (!best || String(record.record.createdAt ?? "") > String(best.record.createdAt ?? "")) best = record;
  }
  return best ?? { ok: false, reason: "没有提交记录" };
}

function deliveryForSubmit({ project, root, branchCommit, mainRef }) {
  const mainSettings = deliverySettings(project.config);
  if (mainSettings.mode === "remote") return { settings: mainSettings, openedByBranch: false };
  // 主分支还是本地交付时，分支可以把交付方式改成远程：这是“开启开关”的路径，
  // 门禁核对仍按主分支的配置，remote 与 provider 取分支提议的值，且必须有人工确认。
  let proposal = null;
  try {
    proposal = deliveryAt(root, branchCommit);
  } catch (error) {
    throw new MergeError(`分支提议的交付设置无法解析: ${error.message}`, "delivery_invalid");
  }
  if (proposal && proposal.mode === "remote") return { settings: proposal, openedByBranch: true };
  throw new MergeError(
    [
      `当前是本地交付，${mainRef} 的配置里没有开启远程交付，不能 submit。`,
      "本地交付下由 harness merge 合入本地主分支；要改为远程交付，在任务分支把 .harness/config.json 的 delivery.mode 改成 remote 并注明 provider，由人确认后即可 submit。",
    ].join("\n"),
    "delivery_local",
  );
}

function validSource({ root, branch, mainRef }) {
  if (!branch) throw new MergeError("必须指定要提交的任务分支: --branch <name>", "invalid_source");
  if (branch === mainRef) throw new MergeError(`源必须是任务分支，不能是主分支 ${mainRef}`, "invalid_source");
  if (/^[0-9a-f]{7,40}$/i.test(branch)) throw new MergeError(`源必须是本地任务分支，不能是提交号 ${branch}`, "invalid_source");
  if (!refExists(root, `refs/heads/${branch}`)) {
    throw new MergeError(
      `找不到本地任务分支 ${branch}。submit 只接受本地任务分支，不接受远程跟踪引用或提交号。`,
      "invalid_source",
    );
  }
}

function describeGates({ evidence, review, approval }) {
  const lines = [];
  const checks = evidence?.checks ?? [];
  const passed = checks.filter((item) => item.exit === 0 && !item.skipped);
  lines.push(`- 验证: ${evidence?.status ?? "无记录"}（执行 ${checks.length} 项，通过 ${passed.length} 项${evidence?.reusedChecks?.length ? `，复用 ${evidence.reusedChecks.length} 项` : ""}）`);
  for (const item of checks) lines.push(`  - ${item.id}: exit=${item.exit}${item.reused ? "（复用）" : ""} ${item.cmd ?? ""}`.trimEnd());
  for (const item of evidence?.notExecuted ?? []) lines.push(`  - 未执行 ${item.id}: ${item.reason}`);
  for (const item of evidence?.advisory ?? []) lines.push(`  - 咨询项 ${item.id}: ${item.hint}`);
  if (review) {
    lines.push(
      `- 独立评审: ${review.verdict}（需求符合度 ${review.requirementFit?.rating ?? "?"}，工程质量 ${review.engineeringQuality?.rating ?? "?"}，清单来源 ${review.acceptanceSource ?? "无"}）`,
    );
    for (const finding of review.findings ?? []) {
      if (finding.severity === "info") continue;
      lines.push(`  - ${finding.severity}: ${finding.title ?? finding.summary ?? ""}`.trimEnd());
    }
  }
  lines.push(`- 实施授权: ${approval ? approval : "本任务不需要（未写方案、改动未超过阈值）"}`);
  return lines;
}

function sectionBody({ project, root, branch, branchCommit, baseCommit, baseRef, resultTree, evidence, review, approval, previous }) {
  const lines = [
    "## harness 门禁结果",
    "",
    `- 任务提交: \`${branchCommit}\``,
    `- 目标主分支提交: \`${baseCommit}\`（${baseRef}）`,
    `- 预期合并结果 tree: \`${resultTree}\``,
    `- 任务分支: \`${branch}\``,
    "",
    ...describeGates({ evidence, review, approval }),
    "",
    "以上由本机门禁核对，签名记录在本机。它保证这个任务提交相对目标主分支通过了验证与独立评审，",
    "不保证平台最终合入的内容，也不保证此后别人推到这个分支的提交。",
  ];
  if (previous?.createdAt) lines.push("", `上次提交时间: ${previous.createdAt}`);
  // 门禁改动与实施授权的说明留在区块里，评审人不必去翻本机记录。
  const configPaths = changedPaths(root, baseCommit, branchCommit).filter((path) => path.startsWith(".harness/"));
  if (configPaths.length > 0) lines.push("", `门禁文件改动 ${configPaths.length} 个:`, ...configPaths.slice(0, 20).map((path) => `- \`${path}\``));
  return managedSection(lines.join("\n"));
}

function titleFor({ root, branchCommit }) {
  const subject = gitOk(root, ["log", "-1", "--format=%s", branchCommit]).trim();
  return subject || `harness submit ${branchCommit.slice(0, 10)}`;
}

/**
 * 把核对过的任务提交推送到远程，并创建或更新指向主分支的 PR/MR。
 * 顺序：校验源 -> 预检平台命令 -> 取得远程主分支 -> 要求本地主分支等于远程 -> 门禁核对 -> 推送 -> 创建或更新。
 * 任何一步失败都不改本地主分支；推送之后的失败停在“已推送”，重跑只补 PR/MR。
 */
export async function submitTask({ cwd, branch, log = console.error }) {
  // 首次接入时主分支还没有配置，只能按分支提议的配置核对；loadGateProject 已经处理这种情况。
  const project = loadGateProject(cwd, { branch });
  const root = project.root;
  const mainRef = mainBranch(project);
  validSource({ root, branch, mainRef });

  const branchCommit = resolveCommit(root, branch);
  const { settings, openedByBranch } = deliveryForSubmit({ project, root, branchCommit, mainRef });

  // 平台命令先预检：没装就早拒绝，别等门禁都跑完了才发现推不了。
  const platform = platformStatus(settings.provider);
  if (!platform.ok) {
    throw new MergeError(
      [
        `没有找到平台命令 ${platform.bin}（${settings.provider}），不能创建 ${platform.label}。`,
        `由人在本机安装 ${platform.bin} 并登录: ${platform.login}`,
        "harness 不读取、不保存平台令牌，认证全部交给这个命令自己管理。",
      ].join("\n"),
      "platform_missing",
    );
  }

  const relay = fetchRemoteMain({ root, remote: settings.remote, mainRef, run });
  const remoteBase = resolveCommit(root, relay);
  const localMain = resolveCommit(root, mainRef);
  if (remoteBase !== localMain) {
    throw new MergeError(
      [
        `本地 ${mainRef}(${localMain.slice(0, 10)}) 与 ${settings.remote}/${mainRef}(${remoteBase.slice(0, 10)}) 不一致，不能提交。`,
        `先运行 harness sync 把本地 ${mainRef} 快进到远程，再重新 submit。`,
        isAncestor(root, remoteBase, localMain)
          ? "本地主分支有远程没有的提交：远程交付下主分支只由平台合并产生，本地多出的提交需要先弄清来源。"
          : "本地主分支落后或已分叉，sync 会核对门禁改动后再更新。",
      ].join("\n"),
      "base_stale",
    );
  }

  // 门禁核对与 merge 共用：本地主分支此刻等于远程主分支，核对结果对两者都成立。
  const gates = await checkGates({ project, root, branch, log });
  const { resultTree, newHead } = gates;

  // 先查有没有已存在的 PR/MR：查询失败时还没推送，远程保持原样；推送之后再查会把失败留在半路。
  const open = findOpen({ provider: settings.provider, branch, base: mainRef, cwd: root, env: process.env });

  if (resolveCommit(root, branch) !== branchCommit) {
    throw new MergeError(`核对期间任务分支顶端移动了，重新运行 harness submit --branch ${branch}`, "branch_moved");
  }

  // 已有提交记录且停在“已推送”、顶端没变、远程仍是那个提交时，跳过推送只补 PR/MR。
  const prior = readSubmit({ root, branch, commit: branchCommit });
  const remoteBranch = remoteTip({ root, remote: settings.remote, branch });
  let pushed = false;
  if (prior.ok && prior.record.stage === "pushed" && remoteBranch === branchCommit) {
    log(`[submit] ${branch} 已经在远程，跳过推送，只补 ${platform.label}`);
  } else {
    pushCommit({ root, remote: settings.remote, branch, commit: branchCommit, run });
    pushed = true;
    writeRecord(root, SUBMIT_KIND, submitKey(branchCommit), {
      branch,
      stage: "pushed",
      head: branchCommit,
      base: remoteBase,
      baseRef: `${settings.remote}/${mainRef}`,
      resultTree,
      mergedHead: newHead,
      provider: settings.provider,
      remote: settings.remote,
      createdAt: new Date().toISOString(),
    });
    appendLedger(root, { event: "submit.push", branch, head: branchCommit, remote: settings.remote });
  }

  const section = sectionBody({
    project,
    root,
    branch,
    branchCommit,
    baseCommit: remoteBase,
    baseRef: `${settings.remote}/${mainRef}`,
    resultTree,
    evidence: gates.evidence,
    review: gates.review,
    approval: gates.approval,
    previous: prior.ok ? prior.record : null,
  });

  let request;
  try {
    request = open
      ? updateRequest({ provider: settings.provider, id: open.id, body: replaceManagedSection(open.body, section), cwd: root, env: process.env })
      : createRequest({ provider: settings.provider, branch, base: mainRef, title: titleFor({ root, branchCommit }), body: section, cwd: root, env: process.env });
  } catch (error) {
    if (error.code !== "platform_failed") throw error;
    throw new MergeError(
      [
        `已推送 ${branch} 到 ${settings.remote}(${branchCommit.slice(0, 10)})，但创建或更新 ${platform.label} 失败。`,
        error.message,
        `远程分支已经是核对过的提交；修好 ${platform.bin} 后重新运行 harness submit --branch ${branch}，会跳过推送只补 ${platform.label}。`,
      ].join("\n"),
      "platform_failed",
    );
  }

  const record = writeRecord(root, SUBMIT_KIND, submitKey(branchCommit), {
    branch,
    stage: "ready",
    head: branchCommit,
    base: remoteBase,
    baseRef: `${settings.remote}/${mainRef}`,
    resultTree,
    mergedHead: newHead,
    provider: settings.provider,
    remote: settings.remote,
    url: request.url,
    requestId: request.id,
    createdAt: new Date().toISOString(),
  });
  appendLedger(root, { event: "submit.ready", branch, head: branchCommit, url: request.url, pushed });
  if (openedByBranch) log(`[submit] 本分支开启了远程交付（${describeDelivery(settings)}），确认记录已存在`);

  return {
    branch,
    head: branchCommit,
    base: remoteBase,
    baseRef: `${settings.remote}/${mainRef}`,
    resultTree,
    pushed,
    url: request.url,
    provider: settings.provider,
    remote: settings.remote,
    delivery: settings,
    record: { stage: record.stage, createdAt: record.createdAt },
  };
}

function remoteTip({ root, remote, branch }) {
  const result = git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`]);
  return result.status === 0 ? result.stdout.trim() : null;
}
