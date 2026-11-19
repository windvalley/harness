import { deliveryAt, deliverySettings, describeDelivery, loadGateProject, mainBranch, sameDelivery, trustedMainRef } from "../lib/config.mjs";
import { gitOk, isAncestor, refExists, repoRoot, resolveCommit, run } from "../lib/git.mjs";
import { redact, tail } from "../lib/redact.mjs";
import { appendLedger } from "../lib/store.mjs";
import { MergeError, acquireLock, checkGates, planMergeResult } from "../merge/merge.mjs";
import { writeObligations } from "../verify/obligation.mjs";
import { reviewerSummary } from "../review/review.mjs";
import { fetchRemoteMain, pushCommit, remoteBranchTips } from "./remote.mjs";
import { createRequest, findOpen, managedSection, matchesManagedSection, platformFailureAdvice, platformOf, platformRepo, platformStatus, replaceManagedSection, updateRequest } from "./platform.mjs";
import { readSubmit, saveSubmit } from "./record.mjs";

/** 由命令、status、交接与 Stop 共用的后续动作。 */
export function submitContinuation(record) {
  const { branch, provider, remote, stage, failure } = record;
  const command = `harness submit --branch ${branch}`;
  if (failure === "remote_changed" || failure === "request_changed") {
    const object = failure === "remote_changed" ? "远端任务分支" : "原 PR/MR 的状态";
    return { human: true, summary: "远端状态已变化", next: `由人核对${object}，确认后再运行 ${command}` };
  }
  const summary = stage === "pushed" ? "已推送，PR/MR 还没有就绪" : "PR/MR 提交未完成";
  if (failure === "base_stale") {
    return { human: false, summary, next: `核对主分支的远端基线，可快进时运行 harness sync，再运行 ${command}` };
  }
  if (failure === "base_diverged") {
    return { human: true, summary, next: `由人核对本地主分支多出的提交并处理基线差异，再运行 ${command}` };
  }
  if (failure === "temporary" || failure === "rate_limit") {
    const condition = failure === "temporary" ? "平台恢复后" : "限流解除后";
    const action = stage === "pushed" ? "回读远端并补 PR/MR" : "继续提交";
    return { human: false, summary, next: `${condition}运行 ${command} ${action}` };
  }
  if (failure === "readback_failed") {
    return { human: false, summary, next: `先恢复远端的只读查询，再运行 ${command} 核对并接续提交` };
  }
  if (failure === "request_unconfirmed") {
    return { human: false, summary, next: `平台尚未返回一致的请求记录，稍后运行 ${command} 回读并核对` };
  }
  if (failure === "git_login" || failure === "git_permission") {
    const access = failure === "git_login" ? "认证" : "仓库权限与分支保护";
    return { human: true, summary, next: `由人核对 Git 远程 ${remote} 的${access}，恢复后运行 ${command}` };
  }
  if (failure === "git_temporary" || failure === "git_rate_limit" || failure === "push_failed") {
    const condition = {
      git_temporary: "Git 远程恢复后",
      git_rate_limit: "Git 远程限流解除后",
      push_failed: "核对 Git 推送报错后",
    }[failure];
    return { human: false, summary, next: `${condition}运行 ${command}，先回读再接续提交` };
  }
  if (failure) {
    const { human, detail } = platformFailureAdvice(provider, failure);
    return { human, summary, next: `${detail}，解决后运行 ${command}` };
  }
  return { human: false, summary, next: `重跑 ${command}，核对远端后补 PR/MR` };
}

export function deliveryForSubmit({ project, root, branch, branchCommit }) {
  const mainSettings = deliverySettings(project.config);
  const trusted = { settings: mainSettings, openedByBranch: false };
  if (mainSettings.mode === "remote") return trusted;
  // 切换远程交付的配置与确认记录都取预期合并结果，避免使用任务分支上的过时远程。
  try {
    if (deliveryAt(root, branchCommit)?.mode !== "remote") return trusted;
    const planned = planMergeResult({ project, root, branch });
    const proposal = deliveryAt(root, planned.resultCommit);
    if (proposal?.mode !== "remote") return trusted;
    return { settings: proposal, openedByBranch: true, resultTree: planned.resultTree };
  } catch (error) {
    if (error instanceof MergeError) throw error;
    throw new MergeError(`分支提议的交付设置无法解析: ${error.message}`, "delivery_invalid");
  }
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
  // 旧记录里的原话可能是未脱敏写入的，写进会发到平台之前再遮一次。
  lines.push(`- 实施授权: ${approval ? redact(approval) : "本任务不需要（未写方案、改动未超过阈值）"}`);
  if (risk?.confirmReasons?.length > 0) lines.push(`- 风险确认: 已由人确认（${risk.confirmReasons.join("；")}）`);
  return lines;
}

export function sectionBody({ branch, branchCommit, baseCommit, baseRef, resultTree, gateTouched, evidence, review, approval, risk }) {
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

function submitFailure(error) {
  if (error.gitReason === "login" || error.gitReason === "permission") return `git_${error.gitReason}`;
  return error.platformReason ?? {
    push_rejected: "remote_changed",
    push_failed: error.gitReason === "temporary" || error.gitReason === "rate_limit" ? `git_${error.gitReason}` : "push_failed",
    request_changed: "request_changed",
    request_unconfirmed: "request_unconfirmed",
    base_stale: "base_stale",
    fetch_failed: "readback_failed",
  }[error.code];
}

function resumeStage(previous) {
  return previous?.stage === "pushed" || previous?.stage === "ready" ? "pushed" : "pending";
}

function submitError(error, progress, stage, failure) {
  const { branch, remote, head, provider } = progress;
  const { next } = submitContinuation({ ...progress, stage, failure });
  return new MergeError(
    [
      stage === "pushed" ? `已推送过 ${branch} 到 ${remote}（${head.slice(0, 10)}），${platformOf(provider).label} 尚未就绪。` : null,
      error.message,
      `下一步：${next}`,
    ].filter(Boolean).join("\n"),
    error.code,
  );
}

/** 门禁前已确认交付暂不可用时，保留已有请求的身份和推送进度。 */
function recordPreflightFailure(root, progress, error, failure) {
  const release = acquireLock(root);
  try {
    const previous = readSubmit(root, progress);
    const stage = resumeStage(previous);
    saveSubmit(root, progress, stage, {
      failure, requestId: previous?.requestId ?? null, awaitingRequest: previous?.awaitingRequest === true,
    }, previous);
    return submitError(error, progress, stage, failure);
  } finally {
    release();
  }
}

function remoteHeadChanged({ remote, branch }, expected, actual) {
  return new MergeError(
    `远端 ${remote}/${branch} 已变化，原提交 ${expected?.slice(0, 10) ?? "不存在"}，当前 ${actual?.slice(0, 10) ?? "不存在"}。`,
    "push_rejected",
  );
}

/** 写失败后用 Git 回执判断是否已经完成，只在远端原状且故障已明确时补推一次。 */
function pushTaskBranch({ root, progress, initialTip, readRemote, checkBase, checkLocal, log }) {
  const { head, branch, remote } = progress;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    checkLocal();
    try {
      pushCommit({ root, remote, branch, commit: head, run });
      return;
    } catch (error) {
      let tips;
      try {
        tips = readRemote();
      } catch (readError) {
        if (error.gitReason === "login" || error.gitReason === "permission") throw error;
        throw readError;
      }
      const actual = tips.get(branch) ?? null;
      if (actual === head) {
        log(`[submit] Git 推送返回失败，回读确认 ${remote}/${branch} 已收到 ${head.slice(0, 10)}`);
        return;
      }
      if (actual !== initialTip) throw remoteHeadChanged(progress, initialTip, actual);
      if (attempt > 0 || error.code !== "push_failed" || error.gitReason !== "temporary") throw error;
      checkBase(tips);
      log(`[submit] Git 推送暂时失败，远端引用未变，补推一次 ${branch}`);
    }
  }
}

function finishSubmit({ root, progress, mainRef, gates, checkLocal, log }) {
  const { head, branch, provider, remote, repo, base } = progress;
  const options = { provider, branch, base: mainRef, repo, cwd: root };
  const label = platformOf(provider).label;
  const release = acquireLock(root);
  try {
    checkLocal();
    const previous = readSubmit(root, progress);
    let stage = resumeStage(previous);
    let requestId = previous?.requestId ?? null;
    let awaitingRequest = previous?.awaitingRequest === true;
    let pushed = false;
    const save = (fields) => saveSubmit(root, progress, stage, { requestId, awaitingRequest, ...fields }, previous);

    const readRequest = () => {
      const request = findOpen(options);
      if (requestId != null && request?.id !== requestId && (request || !awaitingRequest)) {
        throw new MergeError(`续跑时已找不到原 ${label} #${requestId}。`, "request_changed");
      }
      if (request) {
        requestId = request.id;
        awaitingRequest = false;
      }
      return request;
    };

    const readRemote = () => remoteBranchTips({ root, remote, branches: [mainRef, branch], run });
    const checkBase = (tips) => {
      if (tips.get(mainRef) !== base) {
        throw new MergeError(`远端 ${remote}/${mainRef} 已变化，需要重新核对交付门禁。`, "base_stale");
      }
    };
    const checkHead = (tips) => {
      if (tips.get(branch) !== head) throw remoteHeadChanged(progress, head, tips.get(branch));
    };

    try {
      // 合入后验收义务先记录。平台请求无法回读时，在任何远程写入前停止。
      writeObligations({ root, branch, tip: head, items: gates.postMergeChecks });
      let request = readRequest();
      checkLocal();
      let tips = readRemote();
      const initialTip = tips.get(branch) ?? null;
      if (initialTip === head) {
        if (stage === "pending") {
          stage = "pushed";
          save();
        }
        log(`[submit] ${branch} 已经在远程，跳过推送，核对 ${label}`);
      }
      checkBase(tips);
      if (stage === "pending") {
        pushTaskBranch({ root, progress, initialTip, readRemote, checkBase, checkLocal, log });
        stage = "pushed";
        pushed = true;
        save();
        appendLedger(root, { event: "submit.push", branch, head, remote });
        // 已打开请求的源提交可能随推送前进，写正文之前用平台的最新读数。
        if (request) request = readRequest();
        tips = readRemote();
      }
      const section = sectionBody({ ...gates, branch, branchCommit: head, baseCommit: base, baseRef: progress.baseRef });
      let writeError;
      for (let attempt = 0; ; attempt += 1) {
        checkBase(tips);
        checkHead(tips);
        checkLocal();
        if (request && request.head !== head) {
          throw new MergeError(`${label} #${request.id} 的平台源提交与门禁核对的 ${head.slice(0, 10)} 不一致。`, "request_unconfirmed");
        }
        if (request && matchesManagedSection(request.body, section)) break;
        if ((awaitingRequest && !request) || (attempt > 0 && !writeError)) {
          throw new MergeError(`尚未从平台读到包含当前门禁结果的 ${label}。`, "request_unconfirmed");
        }
        if (attempt === 2) throw writeError;
        if (attempt > 0) log(`[submit] 平台临时失败，已回读远端，补做一次 ${label}`);
        try {
          if (request) {
            const body = replaceManagedSection(request.body, section);
            updateRequest({ ...options, id: request.id, body });
          } else {
            const created = createRequest({ ...options, title: titleFor({ root, branchCommit: head }), body: section });
            requestId = created.id;
            awaitingRequest = true;
            save();
          }
          writeError = null;
        } catch (error) {
          if (error.platformReason !== "temporary") throw error;
          writeError = error;
        }
        request = readRequest();
        tips = readRemote();
      }
      const record = saveSubmit(root, progress, "ready", { url: request.url, requestId: request.id, requestHead: request.head });
      appendLedger(root, { event: "submit.ready", branch, head, url: request.url, pushed, riskObserved: gates.risk.observed });
      return { record, pushed };
    } catch (error) {
      const failure = submitFailure(error);
      if (!failure) throw error;
      save({ failure });
      throw submitError(error, progress, stage, failure);
    }
  } finally {
    release();
  }
}

/**
 * 把核对过的任务提交推送到远程，并创建或更新指向主分支的 PR/MR。
 * 核对门禁后推送任务提交，创建或更新请求，并回读 Git 引用与平台实际源提交。
 * 推送之后的失败停在“已推送”，下次核对远端后接续。
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
  const { settings, openedByBranch } = deliveryForSubmit({ project, root, branch, branchCommit });
  if (settings.mode !== "remote") {
    throw new MergeError(
      [
        `当前是本地交付，${mainRef} 的配置里没有开启远程交付，不能 submit。`,
        "本地交付下由 harness merge 合入本地主分支；要改为远程交付，在任务分支把 .harness/config.json 的 delivery.mode 改成 remote 并注明 provider，由人确认后即可 submit。",
      ].join("\n"),
      "delivery_local",
    );
  }

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

  const localMain = mainRef === sourceRef ? pinnedMain : resolveCommit(root, mainRef);
  const target = {
    branch, head: branchCommit, base: localMain, baseRef: `${settings.remote}/${mainRef}`,
    provider: settings.provider, remote: settings.remote, repo,
  };
  let relay;
  try {
    relay = fetchRemoteMain({ root, remote: settings.remote, mainRef, run });
  } catch (error) {
    const failure = submitFailure(error);
    if (failure === "git_login" || failure === "git_permission") {
      throw recordPreflightFailure(root, target, error, failure);
    }
    throw error;
  }
  const remoteBase = resolveCommit(root, relay);
  if (remoteBase !== localMain) {
    const fastForward = isAncestor(root, localMain, remoteBase);
    const error = new MergeError(
      `本地 ${mainRef}(${localMain.slice(0, 10)}) 与 ${settings.remote}/${mainRef}(${remoteBase.slice(0, 10)}) 不一致，不能提交。`,
      "base_stale",
    );
    throw recordPreflightFailure(root, target, error, fastForward ? "base_stale" : "base_diverged");
  }

  // 门禁核对与 merge 共用：本地主分支此刻等于远程主分支，核对结果对两者都成立。
  const gates = await checkGates({ project, root, branch, log, label: "submit" });
  const { resultTree, newHead } = gates;
  if (openedByBranch && !sameDelivery(settings, gates.delivery.after)) {
    throw new MergeError("核对期间的预期合并结果改变了交付目标，重新运行 submit 核对。", "delivery_target_changed");
  }
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
    ...target,
    resultTree,
    mergedHead: newHead,
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
