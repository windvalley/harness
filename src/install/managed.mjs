import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PACKAGE_ROOT } from "../policy/resolve.mjs";

export const MARK_START = "<!-- harness:start -->";
export const MARK_END = "<!-- harness:end -->";

export function packageVersion() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
}

export function assetPath(rel) {
  return join(PACKAGE_ROOT, "assets", rel);
}

/** 替换或追加 AGENTS.md 里的托管块；块外内容原样保留。 */
export function writeManagedBlock({ root, body }) {
  const file = join(root, "AGENTS.md");
  const block = `${MARK_START}\n${body.trim()}\n${MARK_END}`;
  if (!existsSync(file)) {
    writeFileSync(file, `${block}\n`);
    return { path: "AGENTS.md", created: true };
  }
  const text = readFileSync(file, "utf8");
  const start = text.indexOf(MARK_START);
  const end = text.indexOf(MARK_END);
  let next;
  if (start >= 0 && end > start) {
    next = `${text.slice(0, start)}${block}${text.slice(end + MARK_END.length)}`;
  } else {
    next = `${text.replace(/\n+$/, "")}\n\n${block}\n`;
  }
  writeFileSync(file, next);
  return { path: "AGENTS.md", created: false };
}

export function removeManagedBlock({ root }) {
  const file = join(root, "AGENTS.md");
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  const start = text.indexOf(MARK_START);
  const end = text.indexOf(MARK_END);
  if (start < 0 || end <= start) return false;
  writeFileSync(file, `${text.slice(0, start).replace(/\n+$/, "")}\n${text.slice(end + MARK_END.length).replace(/^\n+/, "")}`);
  return true;
}

/** 写入项目内的规则文件（项目自有，可改，可随版本升级重写）。 */
export function writeRules({ root, version }) {
  const write = (rel, content) => {
    const target = join(root, ".harness", rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    return `.harness/${rel}`;
  };
  const written = [];
  const rules = [
    ["rules/core.md", assetPath("rules/core.md")],
    ["rules/harness.md", assetPath("rules/harness.md")],
    ["rules/method-requirements.md", assetPath("rules/method-requirements.md")],
    ["rules/method-diagnosis.md", assetPath("rules/method-diagnosis.md")],
    ["rules/method-test-design.md", assetPath("rules/method-test-design.md")],
    ["rules/method-design-planning.md", assetPath("rules/method-design-planning.md")],
    ["rules/method-review.md", assetPath("rules/method-review.md")],
    ["rules/method-retrospective.md", assetPath("rules/method-retrospective.md")],
    ["templates/acceptance.md", assetPath("templates/acceptance.md")],
    ["templates/spec.md", assetPath("templates/spec.md")],
    ["templates/plan.md", assetPath("templates/plan.md")],
  ];
  for (const [rel, source] of rules) {
    if (!existsSync(source)) continue;
    written.push(write(rel, readFileSync(source, "utf8")));
  }
  write("VERSION", `${version}\n`);
  return written;
}

export function managedBlockBody() {
  return `## Harness

本项目的本地门禁由 harness 管。
下面几条对所有任务生效，不得跳过：

- 开始任何任务前（包括分析、设计与评审）先读 \`.harness/rules/core.md\`，再按场景读同目录下的方法文档；读不到时报告，不凭印象继续。
- 开始任务前读 \`.harness/pitfalls.md\` 避开本项目已知的坑；踩到新的环境类坑并解决后，当场运行 \`harness pitfall add\` 记录。
- 先判断任务分级，在第一条回复里说明判断和依据；分析、评审、诊断类请求保持只读。
  需求已明确的小优化、小迭代或缺陷修复，不改库表、对外接口契约与数据兼容性的，直接实施；行数、依赖清单与敏感路径的条件以 \`core.md\` 为准，提交后可用 \`harness verify --plan\` 核对。
  不满足或拿不准时先探索、逐个澄清、写方案，交出方案后停下。
  方案交付后用户表达开始实施的意思才算授权，最初提出需求或回答澄清问题都不算；授权后连续实施到完成，不再等用户逐步安排。
- 改变行为的实施默认先红后绿：先把验收标准写成测试并确认失败，再实现到全部通过；不删测试、不弱化断言、不跳过检查。
- 改动放在任务分支里，交付只走 \`harness merge --branch <任务分支>\`（本地）或 \`harness submit --branch <任务分支>\`（远程，平台合入后 \`harness sync\`），按 \`.harness/config.json\` 的 \`delivery.mode\` 二选一，未配置时为 \`local\`。
- 主分支上经人确认的 \`delivery\` 设置就是这两条路径所需推送与 PR/MR 操作的授权，不逐次请示；Agent 自行 \`git push\`、推标签、强推、在平台上合并、部署与生产操作仍须单独授权。\n  用户本轮明确说暂不合并或暂不推送时照办。
- 已授权的任务连续推进到交付，轮次长短、耗时与上下文大小都不是停下的理由。\n  需要人决定的阻塞（缺权限、需要业务拍板、用户要求暂不合并、必要验证被外部问题阻塞等）先 \`harness escalate open\` 上报，\`context.branch\` 填任务分支；只差用户同意实施或人工确认时，说明要人做什么后结束，不用上报。\n  收尾检查会拦下没有交付也没有上报的结束，按它的提示处理。
- 合并后保留任务 Worktree，不要自行删除；用户要求清理时先运行 \`harness worktree clean\` 预览，用户确认后再加 \`--yes\`。

细则见 \`.harness/rules/harness.md\`。`;
}
