const HEADING = /^##\s+(.+?)\s*$/;
const POST_MERGE = /^(?:合并后验收|post-merge(?:\s+acceptance)?)$/i;

/** 旧清单默认全部属于合并前；只有显式命名同级章节的内容才后置。 */
export function splitAcceptance(text) {
  const preMerge = [];
  const postMerge = [];
  let target = preMerge;
  const source = String(text ?? "").replace(/<!--[\s\S]*?-->/g, "");
  for (const line of source.split("\n")) {
    const heading = line.match(HEADING);
    if (heading) {
      target = POST_MERGE.test(heading[1].trim()) ? postMerge : preMerge;
      if (target === postMerge) continue;
    }
    target.push(line);
  }
  return {
    preMergeText: preMerge.join("\n").trim(),
    postMergeText: postMerge.join("\n").trim(),
  };
}
