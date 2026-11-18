import { deliveryAt, deliverySettings, describeDelivery, loadGateProject, mainBranch, trustedMainRef } from "../lib/config.mjs";
import { gitOk, isAncestor, refExists, repoRoot, resolveCommit, run } from "../lib/git.mjs";
import { tail } from "../lib/redact.mjs";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { appendLedger, dataDir, readRecord, writeRecord } from "../lib/store.mjs";
import { MergeError, acquireLock, checkGates } from "../merge/merge.mjs";
import { writeObligations } from "../verify/obligation.mjs";
import { reviewerSummary } from "../review/review.mjs";
import { fetchRemoteMain, pushCommit, remoteBranchTip } from "./remote.mjs";
import { createRequest, findOpen, managedSection, platformFailureAdvice, platformOf, platformRepo, platformStatus, replaceManagedSection, updateRequest } from "./platform.mjs";

/** 提交记录按任务提交索引。失败时区分推送前与已推送，成功时记为 PR/MR 已就绪。 */
export const SUBMIT_KIND = "submit";

export function submitKey(commit) {
  return commit;
}

export function readSubmit({ root, branch, commit }) {
  const record = readRecord(root, SUBMIT_KIND, submitKey(commit));
  if (!record.ok) return { ok: false, reason: record.reason };
  if (record.record.branch !== branch) return { ok: false, reason: `提交记录属于分支 ${record.record.branch}` };
  if (record.record.head !== commit) return { ok: false, reason: "提交记录与任务顶端不一致" };
  return { ok: true, record: record.record };
}

/**
 * 优先返回当前顶端的记录，否则返回该分支最近一条，供 status 判断顶端是否变化。
 */
export function latestSubmit({ root, branch, commit }) {
  const dir = join(dataDir(root), SUBMIT_KIND);
  if (!existsSync(dir)) return { ok: false, reason: "没有提交记录" };
  let best = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const record = readRecord(root, SUBMIT_KIND, name.slice(0, -".json".length));
    if (!record.ok || record.record.branch !== branch) continue;
    if (commit && record.record.head === commit) return record;
    if (!best || String(record.record.createdAt ?? "") > String(best.record.createdAt ?? "")) best = record;
  }
  return best ?? { ok: false, reason: "没有提交记录" };
}

export function sameSubmitTarget(record, { provider, remote, repo, baseRef }) {
  return record.provider === provider && record.remote === remote && record.repo === repo && record.baseRef === baseRef;
}

/** 由命令、status、交接与 Stop 共用的后续动作。 */
export function submitContinuation(record) {
  const { branch, provider, stage, failure } = record;
  const command = `harness submit --branch ${branch}`;
  if (failure === "remote_changed" || failure === "request_changed") {
    const object = failure === "remote_changed" ? "远端任务分支" : "原 PR/MR 的状态";
    return { human: true, summary: "远端状态已变化", next: `由人核对${object}，确认后再运行 ${command}` };
  }
  const summary = stage === "pushed" ? "已推送，PR/MR 还没有就绪" : "PR/MR 提交未完成";
  if (failure === "base_stale") {
    return { human: false, summary, next: `核对主分支的远端基线，可快进时运行 harness sync，再运行 ${command}` };
  }
  if (failure === "temporary" || failure === "rate_limit") {
    const condition = failure === "temporary" ? "平台恢复后" : "限流解除后";
    const action = stage === "pushed" ? "回读远端并补 PR/MR" : "继续提交";
    return { human: false, summary, next: `${condition}运行 ${command} ${action}` };
  }
  if (failure === "readback_failed") {
    return { human: false, summary, next: `先恢复远端的只读查询，再运行 ${command} 核对并接续提交` };
  }
  if (failure) {
    const { human, detail } = platformFailureAdvice(provider, failure);
    return { human, summary, next: `${detail}，解决后运行 ${command}` };
  }
  return { human: false, summary, next: `重跑 ${command}，核对远端后补 PR/MR` };
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

function describeGates({ evidence, review, approval, risk }) {
  const lines = [];
  const checks = evidence?.checks ?? [];
  const passed = checks.filter((item) => item.exit === 0 && !item.skipped);
  lines.push(`- 验证: ${evidence?.status ?? "无记录"}（执行 ${checks.length} 项，通过 ${passed.length} 项${evidence?.reusedChecks?.length ? `，复用 ${evidence.reusedChecks.length} 项` : ""}）`);
  for (const item of checks) lines.push(`  - ${item.id}: exit=${item.exit}${item.reused ? "（复用）" : ""} ${item.cmd ?? ""}${item.id.startsWith("harness:") && item.note ? ` - ${item.note}` : ""}`.trimEnd());
  for (const item of evidence?.attested ?? []) lines.push(`  - 外部证据 ${item.id}: 已登记（报告 SHA-256 ${item.report.sha256}）`);
  for (const item of evidence?.postMerge ?? []) lines.push(`  - 合并后验收 ${item.id}: ${item.howToVerify}（平台合入并 sync 后完成）`);
  for (const item of evidence?.notExecuted ?? []) lines.push(`  - 未执行 ${item.id}: ${item.reason}`);
  for (const item of evidence?.advisory ?? []) lines.push(`  - 咨询项 ${item.id}: ${item.hint}`);
  if (review) {
    lines.push(
      `- 独立评审: ${review.verdict}（需求符合度 ${review.requirementFit?.rating ?? "?"}，工程质量 ${review.engineeringQuality?.rating ?? "?"}，清单来源 ${review.acceptanceSource ?? "无"}）`,
      `  - 评审者: ${reviewerSummary(review, { forPlatform: true })}`,
    );
    for (const finding of review.findings ?? []) {
      if (finding.severity === "info") continue;
      lines.push(`  - ${finding.severity}: ${finding.title ?? finding.summary ?? ""}`.trimEnd());
    }
  }
  lines.push(`- 实施授权: ${approval ? approval : "本任务不需要（未写方案、改动未超过阈值）"}`);
  if (risk?.confirmReasons?.length > 0) lines.push(`- 风险确认: 已由人确认（${risk.confirmReasons.join("；")}）`);
  return lines;
}

function sectionBody({ branch, branchCommit, baseCommit, baseRef, resultTree, gateTouched, evidence, review, approval, risk, previous }) {
  const lines = [
    "## harness 门禁结果",
    "",
    `- 任务提交: \`${branchCommit}\``,
    `- 目标主分支提交: \`${baseCommit}\`（${baseRef}）`,
    `- 预期合并结果 tree: \`${resultTree}\``,
    `- 任务分支: \`${branch}\``,
    "",
    ...describeGates({ evidence, review, approval, risk }),
    "",
    "以上由本机门禁核对，签名记录在本机。它保证这个任务提交相对目标主分支通过了验证与独立评审，",
    "不保证平台最终合入的内容，也不保证此后别人推到这个分支的提交。",
  ];
  if (previous?.createdAt) lines.push("", `上次提交时间: ${previous.createdAt}`);
  // 门禁文件按门禁路径列出（与确认摘要同一份清单），评审人能看出这次是否动了门禁本身，不必去翻本机记录。
  if (gateTouched.length > 0) {
    lines.push("", `门禁文件改动 ${gateTouched.length} 个:`, ...gateTouched.slice(0, 20).map((path) => `- \`${path}\``));
    if (gateTouched.length > 20) lines.push(`- 另有 ${gateTouched.length - 20} 个`);
  }
  return managedSection(lines.join("\n"));
}

function titleFor({ root, branchCommit }) {
  const subject = gitOk(root, ["log", "-1", "--format=%s", branchCommit]).trim();
  return subject || `harness submit ${branchCommit.slice(0, 10)}`;
}

function applyRequest(options, open, section, title) {
  if (!open) return createRequest({ ...options, title, body: section });
  const body = replaceManagedSection(open.body, section);
  if (body === open.body) return open;
  return updateRequest({ ...options, id: open.id, body });
}

function finishSubmit({ root, progress, mainRef, gates, checkLocal, log }) {
  const { head, branch, provider, remote, repo, base } = progress;
  const options = { provider, branch, base: mainRef, repo, cwd: root };
  const label = platformOf(provider).label;
  const release = acquireLock(root);
  try {
    checkLocal();
    const prior = readSubmit({ root, branch, commit: head });
    const previous = prior.ok && sameSubmitTarget(prior.record, progress) ? prior.record : null;
    const save = (stage, fields = {}) => writeRecord(root, SUBMIT_KIND, submitKey(head), {
      ...progress, stage, ...fields, createdAt: new Date().toISOString(),
    });
    let stage = previous?.stage === "pushed" ? "pushed" : "pending";
    let requestId = stage === "pushed" ? previous.requestId : null;
    let pushed = false;

    const readRequest = () => {
      const request = findOpen(options);
      if (requestId != null && request?.id !== requestId) {
        throw new MergeError(`续跑时已找不到原 ${label} #${requestId}。`, "request_changed");
      }
      requestId = request?.id ?? null;
      return request;
    };

    const checkPushedHead = () => {
      const actual = remoteBranchTip({ root, remote, branch, run });
      if (actual !== head) {
        throw new MergeError(
          `续跑时远端 ${remote}/${branch} 不再指向已核对的提交 ${head.slice(0, 10)}（当前 ${actual?.slice(0, 10) ?? "不存在"}）。`,
          "push_rejected",
        );
      }
    };

    try {
      // 合入后验收义务先记录。平台请求无法回读时，在任何远程写入前停止。
      writeObligations({ root, branch, tip: head, items: gates.postMergeChecks });
      const open = readRequest();
      if (stage === "pushed") {
        checkLocal();
        checkPushedHead();
        log(`[submit] ${branch} 已经在远程，跳过推送，只补 ${label}`);
      } else {
        checkLocal();
        pushCommit({ root, remote, branch, commit: head, run });
        stage = "pushed";
        pushed = true;
        save(stage, { requestId });
        appendLedger(root, { event: "submit.push", branch, head, remote });
      }
      const section = sectionBody({
        ...gates, branch, branchCommit: head, baseCommit: base, baseRef: progress.baseRef,
        previous: previous?.stage === "pending" ? null : previous,
      });
      const title = titleFor({ root, branchCommit: head });
      checkLocal();
      let request;
      try {
        request = applyRequest(options, open, section, title);
      } catch (error) {
        if (error.platformReason !== "temporary") throw error;
        log(`[submit] 平台临时失败，回读远端并最多补做一次 ${label}`);
        checkLocal();
        const current = readRequest();
        if (remoteBranchTip({ root, remote, branch: mainRef, run }) !== base) {
          throw new MergeError(`重试时远端 ${remote}/${mainRef} 已变化，需要重新核对交付门禁。`, "base_stale");
        }
        checkPushedHead();
        checkLocal();
        request = applyRequest(options, current, section, title);
      }
      const record = save("ready", { url: request.url, requestId: request.id });
      appendLedger(root, { event: "submit.ready", branch, head, url: request.url, pushed, riskObserved: gates.risk.observed });
      return { record, pushed };
    } catch (error) {
      const failure = error.platformReason ?? {
        push_rejected: "remote_changed",
        request_changed: "request_changed",
        base_stale: "base_stale",
        fetch_failed: "readback_failed",
      }[error.code];
      if (!failure) throw error;
      if (stage !== "pending" || previous?.stage !== "ready") save(stage, { failure, requestId });
      const action = submitContinuation({ branch, provider, stage, failure });
      throw new MergeError(
        [
          stage === "pushed" ? `已推送过 ${branch} 到 ${remote}（${head.slice(0, 10)}），${label} 尚未就绪。` : null,
          error.message,
          `下一步：${action.next}`,
        ].filter(Boolean).join("\n"),
        error.code,
      );
    }
  } finally {
    release();
  }
}

/**
 * 把核对过的任务提交推送到远程，并创建或更新指向主分支的 PR/MR。
 * 顺序：校验源 -> 预检平台命令 -> 取得远程主分支 -> 要求本地主分支等于远程 -> 门禁核对 -> 推送 -> 创建或更新。
 * 任何一步失败都不改本地主分支；推送之后的失败停在“已推送”，重跑只补 PR/MR。
 */
export async function submitTask({ cwd, branch, log = console.error }) {
  // 配置与基线固定在同一个主分支提交上：先取提交，再从这个提交读配置。
  // 否则读配置之后主分支被别的合并推进，就会按旧配置核对新基线。
  // 首次接入时主分支还没有配置，只能按分支提议的配置核对；loadGateProject 已经处理这种情况。
  const repo0 = repoRoot(cwd);
  const sourceRef = trustedMainRef(repo0);
  const pinnedMain = resolveCommit(repo0, sourceRef);
  const project = loadGateProject(cwd, { branch, at: pinnedMain });
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

  // 平台调用一律绑定获授权的那个远程仓库：gh 与 glab 默认按本地 remote 或 GH_REPO 推断，
  // 配置成 upstream 时可能推送到 A、却改到 B 的同名 PR，把 A 的门禁结果写到别的代码上。
  const repo = platformRepo({ root, remote: settings.remote });
  if (settings.mode === "remote" && !repo) {
    throw new MergeError(
      [
        `无法从远程 ${settings.remote} 的地址识别平台仓库，不能创建 ${platform.label}。`,
        `远程地址: ${tail(gitOk(root, ["remote", "get-url", settings.remote]), 1)}`,
        "确认这个远程指向 GitHub 或 GitLab 的仓库地址（例如 git@host:group/repo.git 或 https://host/group/repo.git），",
        "平台命令只接受能识别出 HOST/OWNER/REPO 的地址；本地路径形式的远程只适合测试。",
      ].join("\n"),
      "platform_repo_unknown",
    );
  }

  const relay = fetchRemoteMain({ root, remote: settings.remote, mainRef, run });
  const remoteBase = resolveCommit(root, relay);
  const localMain = mainRef === sourceRef ? pinnedMain : resolveCommit(root, mainRef);
  if (remoteBase !== localMain) {
    throw new MergeError(
      [
        `本地 ${mainRef}(${localMain.slice(0, 10)}) 与 ${settings.remote}/${mainRef}(${remoteBase.slice(0, 10)}) 不一致，不能提交。`,
        isAncestor(root, localMain, remoteBase)
          ? `本地主分支可以快进，先运行 harness sync，再重新 submit。`
          : "本地主分支有远程没有的提交，需要由人核对来源后决定怎样处理。",
      ].join("\n"),
      "base_stale",
    );
  }

  // 门禁核对与 merge 共用：本地主分支此刻等于远程主分支，核对结果对两者都成立。
  const gates = await checkGates({ project, root, branch, log, label: "submit" });
  const { resultTree, newHead } = gates;
  const checkLocal = () => {
    if (gates.mainCommit !== localMain || resolveCommit(root, sourceRef) !== pinnedMain || resolveCommit(root, mainRef) !== localMain) {
      throw new MergeError(
        `${mainRef} 在核对过程中已变化，核对用的配置与基线不再是同一个提交；先 harness sync，再重新运行 harness submit --branch ${branch}`,
        "main_moved",
      );
    }
    if (gates.branchCommit !== branchCommit || resolveCommit(root, branch) !== branchCommit) {
      throw new MergeError(`核对期间任务分支顶端移动了，重新运行 harness submit --branch ${branch}`, "branch_moved");
    }
    if (platformRepo({ root, remote: settings.remote }) !== repo) {
      throw new MergeError(`核对期间远程 ${settings.remote} 的平台仓库已变化，先核对交付目标。`, "delivery_target_changed");
    }
  };
  const progress = {
    branch,
    head: branchCommit,
    base: remoteBase,
    baseRef: `${settings.remote}/${mainRef}`,
    resultTree,
    mergedHead: newHead,
    provider: settings.provider,
    remote: settings.remote,
    repo,
  };
  const { record, pushed } = finishSubmit({ root, progress, mainRef, gates, checkLocal, log });
  if (openedByBranch) log(`[submit] 本分支开启了远程交付（${describeDelivery(settings)}），确认记录已存在`);
  // 放在日志末尾：Agent 常用 tail 截取输出，开头那行评审者摘要会被截掉。
  if (gates.review) log(`[submit] 汇报时写一行代码评审的评审者: ${reviewerSummary(gates.review)}`);

  return {
    branch,
    head: branchCommit,
    base: remoteBase,
    baseRef: `${settings.remote}/${mainRef}`,
    resultTree,
    pushed,
    url: record.url,
    provider: settings.provider,
    remote: settings.remote,
    delivery: settings,
    postMergeChecks: gates.postMergeChecks,
    repo,
    record: { stage: record.stage, createdAt: record.createdAt },
  };
}
