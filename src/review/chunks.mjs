import { createHash } from "node:crypto";

/** 分批评审只接收完整 Git patch；连续原始区间的覆盖由 harness 而不是模型判定。 */
export function diffDigest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function diffFiles(diff) {
  const offsets = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index);
  if (!offsets.length || offsets[0] !== 0) {
    throw new Error("无法可靠解析 Git diff 文件边界，已拒绝分批评审");
  }
  return offsets.map((start, index) => {
    const patch = diff.slice(start, offsets[index + 1] ?? diff.length);
    return { index, patch, header: patch.slice(0, patch.indexOf("\n") < 0 ? undefined : patch.indexOf("\n")) };
  });
}

/**
 * 一个超大文件可跨多个批次，但只按原始换行边界切割；禁止截断一行。
 * 每个分片保存原 patch 的精确 [start,end) 字符区间，续片重复文件头仅为评审定位。
 */
function fragmentsOf(file, budget, maxChars) {
  if (file.patch.length <= budget) {
    return [{ fileIndex: file.index, start: 0, end: file.patch.length, raw: file.patch, text: file.patch }];
  }
  const fragments = [];
  let start = 0;
  while (start < file.patch.length) {
    const prefix = start === 0 ? "" : `${file.header}\n# 以下为同一文件 diff 的连续续片；并非新的改动\n`;
    const room = budget - prefix.length;
    if (room <= 0) throw new Error("评审上限小于续片文件头，无法安全分批");
    let end = Math.min(file.patch.length, start + room);
    if (end < file.patch.length) {
      const boundary = file.patch.lastIndexOf("\n", end - 1);
      if (boundary < start) {
        throw new Error(
          `变更 diff 超过独立评审上限 ${maxChars}：文件 ${file.header} 含无法按行拆分的超长行；` +
          "请拆分生成内容或在主分支审慎调整 review.maxDiffChars 与 review.maxBudgetUsd，不能截断后放行",
        );
      }
      end = boundary + 1;
    }
    if (end <= start) throw new Error("分批评审无法取得有效的连续 diff 区间");
    const raw = file.patch.slice(start, end);
    fragments.push({ fileIndex: file.index, start, end, raw, text: prefix + raw });
    start = end;
  }
  return fragments;
}

export function planChunkedDiff(diff, maxChars) {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new Error("评审上限必须是正整数");
  // 给每批的系统指令、验收、统计和额外上下文留余量。
  const budget = Math.floor(maxChars * 0.72);
  const files = diffFiles(diff);
  if (budget < 64) throw new Error("评审上限过小，无法安全分批");
  const chunks = [];
  let current = { index: 0, segments: [], chars: 0 };
  const flush = () => {
    if (!current.segments.length) return;
    current.text = current.segments.map((segment) => segment.text).join("\n");
    chunks.push(current);
    current = { index: chunks.length, segments: [], chars: 0 };
  };
  for (const file of files) {
    for (const segment of fragmentsOf(file, budget, maxChars)) {
      const extra = segment.text.length + (current.segments.length ? 1 : 0);
      if (current.segments.length && current.chars + extra > budget) flush();
      if (segment.text.length > budget) throw new Error("分片超过评审预算，拒绝遗漏内容");
      current.segments.push(segment);
      current.chars += segment.text.length + (current.segments.length > 1 ? 1 : 0);
    }
  }
  flush();
  const plan = { files, chunks, budget, diffHash: diffDigest(diff), totalChars: diff.length };
  assertChunkCoverage(plan, diff);
  return plan;
}

export function assertChunkCoverage(plan, diff) {
  if (diffDigest(diff) !== plan.diffHash || diff.length !== plan.totalChars) {
    throw new Error("分批评审 diff 版本与计划不一致");
  }
  const originals = plan.files.map((file) => file.patch).join("");
  if (originals !== diff) throw new Error("分批评审的文件集合存在遗漏或重复");
  let covered = 0;
  for (const file of plan.files) {
    const parts = plan.chunks.flatMap((chunk) => chunk.segments).filter((part) => part.fileIndex === file.index);
    let offset = 0;
    for (const part of parts) {
      if (part.start !== offset || part.end <= part.start || part.raw !== file.patch.slice(part.start, part.end)) {
        throw new Error(`文件 ${file.header} 的分片存在遗漏、重叠或内容不一致`);
      }
      offset = part.end;
      covered += part.raw.length;
    }
    if (offset !== file.patch.length) throw new Error(`文件 ${file.header} 未被完整评审`);
  }
  for (const chunk of plan.chunks) {
    if (!chunk.segments.length || chunk.chars !== chunk.text.length || chunk.chars > plan.budget) {
      throw new Error("分批评审分片大小或内容校验失败");
    }
  }
  if (covered !== diff.length) throw new Error("分批评审的字符覆盖率不足 100%");
  return { complete: true, totalChars: diff.length, coveredChars: covered, diffHash: plan.diffHash,
    files: plan.files.length, fragments: plan.chunks.reduce((n, chunk) => n + chunk.segments.length, 0) };
}

/**
 * 全局阶段消费全部文件清单和结构性修改的有界摘录；不声称摘录等于完整代码。
 * 逐批评审覆盖完整 diff，全局评审据此重点寻找跨文件契约问题。
 */
export function integrationDiff(plan, maxChars = 80_000) {
  const header = "以下为跨模块集成评审的结构性摘录，可能只包含每个文件的部分行。\n" +
    "完整 diff 已由各批独立评审覆盖；不得把摘录缺少的内容当作不存在。\n";
  const allowance = maxChars - header.length;
  if (allowance <= 0) throw new Error("全局评审上下文预算不足");
  const perFile = Math.floor(allowance / plan.files.length);
  if (perFile < 150) throw new Error("改动文件过多，无法给全局评审提供完整文件清单");
  const excerpts = plan.files.map((file) => {
    const rows = file.patch.split("\n");
    const structural = rows.filter((line) => line.startsWith("diff --git ") || line.startsWith("@@") ||
      (/^[+-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---")));
    let sample = `${file.header}\n`;
    for (const row of structural) {
      if (row === file.header) continue;
      if (sample.length + row.length + 2 > perFile - 24) break;
      sample += `${row}\n`;
    }
    if (sample.length === file.header.length + 1) {
      // 至少明确记录这个文件的存在；原始完整内容仍由局部评审覆盖。
      sample += "(结构性摘录预算不足)\n";
    }
    const clipped = sample.length < file.patch.length;
    return sample + (clipped ? "(仅为摘录，完整变更请参考局部评审)\n" : "");
  });
  const result = header + excerpts.join("\n");
  if (result.length > maxChars) throw new Error("全局集成评审材料超限，拒绝不完整评审");
  return result;
}

/** 签名记录的附加自检；所有条件成立才有资格被旧合并门禁复用。 */
export function chunkedRecordProblem(record) {
  if (record?.reviewMode !== "chunked") return null;
  const info = record.chunked;
  if (!info || info.version !== 1 || !info.coverage?.complete ||
    !Number.isSafeInteger(info.coverage.totalChars) || info.coverage.totalChars <= 0 ||
    info.coverage.coveredChars !== info.coverage.totalChars ||
    !/^[a-f0-9]{64}$/.test(info.coverage.diffHash ?? "") ||
    !Number.isInteger(info.coverage.fragments) || info.coverage.fragments < 1 ||
    !Number.isInteger(info.coverage.files) || info.coverage.files < 1 ||
    !Array.isArray(info.chunks) || info.chunks.length < 2) {
    return "分批评审缺少可信的完整覆盖记录";
  }
  if (info.chunks.some((chunk, i) => chunk.index !== i || chunk.status !== "complete" ||
    !Number.isInteger(chunk.fragments) || chunk.fragments <= 0 ||
    !Number.isInteger(chunk.chars) || chunk.chars <= 0 ||
    chunk.verdict !== "approve")) {
    return "部分代码批次尚未有效评审通过";
  }
  if (info.chunks.reduce((sum, chunk) => sum + chunk.fragments, 0) !== info.coverage.fragments) {
    return "分批评审的分片数量与完整性记录不一致";
  }
  if (info.integration?.status !== "complete" || info.integration.verdict !== "approve") {
    return "全局集成评审没有有效通过";
  }
  return null;
}
