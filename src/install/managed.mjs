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

/** 首次接入时写入起始黄金任务；已有文件不覆盖，避免冲掉项目自己的用例。 */
export function writeGolden({ root }) {
  const file = join(root, ".harness", "golden", "tasks.json");
  if (existsSync(file)) return file;
  mkdirSync(join(file, ".."), { recursive: true });
  const starter = assetPath("golden/starter.json");
  const body = existsSync(starter)
    ? readFileSync(starter, "utf8")
    : `${JSON.stringify({ version: 1, tasks: [] }, null, 2)}\n`;
  writeFileSync(file, body);
  return file;
}

export function managedBlockBody() {
  return `## Harness

本项目的本地门禁由 harness 管。
下面几条对所有任务生效，不得跳过：

- 开始任何任务前（包括分析、设计与评审）先读 \`.harness/rules/core.md\`，再按场景读同目录下的方法文档；读不到时报告，不凭印象继续。
- 先判断任务分级。
  小优化、小迭代，不改库表与接口契约，代码改动少于 500 行（以 \`.harness/config.json\` 的 \`intent.plan.maxLines\` 为准）的直接实施；其余先探索、逐个澄清、写方案，交出方案后停下；用户表达开始实施的意思后，连续实施到完成，不再等用户逐步安排。
- 用户用日常语言描述想法或问题即可，Agent 负责理解需求、整理验收标准和澄清关键歧义，不要求用户记固定话术、宣布澄清结束或逐次提醒交付要求。
  先方案后实施的任务在关键问题明确或由用户标为待定后主动整理方案，交付后等待对该方案的实施授权；初始需求和澄清答复不能替代授权。
- Agent 按项目规则准备任务分支与需要的 Worktree，连续完成已授权的实现、提交、验证、独立评审和本地合并，不要求用户逐条运行命令。
  必须由人执行的门禁确认和客户端操作给出具体步骤，完成后接续工作；交付时给出验收证据、最终合并状态与待处理项。
- 改变行为的实施默认先红后绿：先把验收标准写成测试并确认失败，再实现到全部通过；不删测试、不弱化断言、不跳过检查。
- 改动放在任务分支里；合并到主分支只能通过 \`harness merge --branch <任务分支>\`，它要求验证证据与独立评审，门禁改动还需要人工确认。
- 合并后保留任务 Worktree，不要自行删除；用户要求清理时先运行 \`harness worktree clean\` 给出预览，用户确认后再加 \`--yes\`，细则见 \`harness.md\` 的“收尾”。

细则见 \`.harness/rules/harness.md\`。`;
}
