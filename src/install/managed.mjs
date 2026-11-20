import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { PACKAGE_ROOT } from "../policy/resolve.mjs";

export const MARK_START = "<!-- harness:start -->";
export const MARK_END = "<!-- harness:end -->";

export function packageVersion() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
}

export function assetPath(rel) {
  return join(PACKAGE_ROOT, "assets", rel);
}

/** 把托管块写进 AGENTS.md 的现有内容（null 表示文件不存在）；块外内容原样保留。 */
export function renderManagedBlock(text, body) {
  const block = `${MARK_START}\n${body.trim()}\n${MARK_END}`;
  if (text === null) return `${block}\n`;
  const start = text.indexOf(MARK_START);
  const end = text.indexOf(MARK_END);
  if (start >= 0 && end > start) return `${text.slice(0, start)}${block}${text.slice(end + MARK_END.length)}`;
  return `${text.replace(/\n+$/, "")}\n\n${block}\n`;
}

/** 替换或追加 AGENTS.md 里的托管块；块外内容原样保留。 */
export function writeManagedBlock({ root, body }) {
  const file = join(root, "AGENTS.md");
  const created = !existsSync(file);
  writeFileSync(file, renderManagedBlock(created ? null : readFileSync(file, "utf8"), body));
  return { path: "AGENTS.md", created };
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

const RULE_SOURCES = [
  "rules/core.md",
  "rules/harness.md",
  "rules/method-requirements.md",
  "rules/method-diagnosis.md",
  "rules/method-test-design.md",
  "rules/method-ui-visual.md",
  "rules/method-cross-platform.md",
  "rules/method-backfill-tests.md",
  "rules/method-design-planning.md",
  "rules/method-review.md",
  "rules/method-retrospective.md",
  "templates/acceptance.md",
  "templates/contract.md",
  "templates/spec.md",
  "templates/plan.md",
  "templates/test-backfill.md",
  "templates/visual-contract.md",
  "templates/platform-matrix.md",
];

/** 随版本分发的规则与模板：[.harness 下的相对路径, 内容]。 */
export function ruleEntries() {
  return RULE_SOURCES.filter((rel) => existsSync(assetPath(rel))).map((rel) => [rel, readFileSync(assetPath(rel), "utf8")]);
}

export const MANAGED_MANIFEST = ".harness/managed-files.json";
const MANAGED_PATH = /^(rules|templates)\/[a-z0-9][a-z0-9.-]*\.md$/;
const sha = (text) => createHash("sha256").update(text).digest("hex");

function readRegular(file) {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) return { exists: true, text: null, problem: "符号链接" };
    if (!stat.isFile()) return { exists: true, text: null, problem: "不是普通文件" };
    return { exists: true, text: readFileSync(file, "utf8"), problem: null };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, text: null, problem: null };
    throw error;
  }
}

function parentProblem(root, rel) {
  let current = root;
  for (const part of dirname(rel).split(sep)) {
    if (!part || part === ".") continue;
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return `父目录是符号链接: ${current}`;
      if (!stat.isDirectory()) return `父路径不是目录: ${current}`;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  return null;
}

function manifestState(root) {
  const found = readRegular(join(root, MANAGED_MANIFEST));
  if (found.problem) return { files: null, problem: `${MANAGED_MANIFEST} 是${found.problem}` };
  if (!found.exists) return { files: null, problem: null };
  try {
    const parsed = JSON.parse(found.text);
    if (parsed?.version !== 1 || !parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files) || Object.keys(parsed).sort().join(",") !== "files,version") {
      return { files: null, problem: `${MANAGED_MANIFEST} 格式无效` };
    }
    for (const [rel, hash] of Object.entries(parsed.files)) {
      if (!MANAGED_PATH.test(rel) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
        return { files: null, problem: `${MANAGED_MANIFEST} 含无效文件或哈希` };
      }
    }
    return { files: parsed.files, problem: null };
  } catch {
    return { files: null, problem: `${MANAGED_MANIFEST} 不是有效 JSON` };
  }
}

function previousHash(previousRoot, rel) {
  if (!previousRoot) return null;
  const found = readRegular(join(previousRoot, rel));
  return found.exists && !found.problem ? sha(found.text) : null;
}

/** 计算托管规则变更。旧项目没有清单时，以锁定版本的已安装资源作为比较基线。 */
export function planManagedRules({ root, previousRoot = null, force = false }) {
  const entries = ruleEntries();
  const desired = Object.fromEntries(entries.map(([rel, content]) => [rel, sha(content)]));
  const manifest = manifestState(root);
  const old = manifest.files ?? {};
  const conflicts = [];
  const conflict = (path, reason, forceable = true) => {
    if (!force || !forceable) conflicts.push({ path, reason });
  };
  if (manifest.problem) conflict(MANAGED_MANIFEST, manifest.problem);
  const actions = [];
  for (const rel of [...new Set([...Object.keys(old), ...Object.keys(desired)])].sort()) {
    const path = `.harness/${rel}`;
    const parent = parentProblem(root, path);
    if (parent) conflict(path, parent, false);
    const current = readRegular(join(root, path));
    if (current.problem) conflict(path, current.problem);
    const currentHash = current.exists && !current.problem ? sha(current.text) : null;
    const wanted = Object.hasOwn(desired, rel) ? desired[rel] : null;
    const previous = manifest.files ? old[rel] : previousHash(previousRoot, rel);
    if (current.exists && currentHash !== wanted && currentHash !== previous) {
      conflict(path, previous ? "内容在上次托管写入后被修改" : "本地修改或归属不明");
    }
    if (wanted === null) {
      if (current.exists && currentHash === previous) actions.push({ action: "删除", path, rel, content: null });
    } else if (!current.exists) actions.push({ action: "新增", path, rel, content: entries.find(([name]) => name === rel)[1] });
    else if (currentHash !== wanted) actions.push({ action: "更新", path, rel, content: entries.find(([name]) => name === rel)[1] });
  }
  const manifestText = `${JSON.stringify({ version: 1, files: desired }, null, 2)}\n`;
  const currentManifest = readRegular(join(root, MANAGED_MANIFEST));
  const manifestChanged = !currentManifest.exists || currentManifest.text !== manifestText;
  return { actions, conflicts, manifestText, manifestChanged };
}

export function managedConflictError(plan) {
  if (plan.conflicts.length === 0) return null;
  return new Error(
    `托管文件冲突:\n${plan.conflicts.map(({ path, reason }) => `  - ${path}: ${reason}`).join("\n")}\n` +
      "先把项目自己的说明迁到 AGENTS.md 托管块之外；确认用当前版本覆盖这些托管文件时，由人明确运行 upgrade --force",
  );
}

/** 写入托管规则、模板及其内容清单；默认拒绝覆盖本地修改或跟随符号链接。 */
export function writeRules({ root, version, previousRoot = null, force = false }) {
  const plan = planManagedRules({ root, previousRoot, force });
  const problem = managedConflictError(plan);
  if (problem) throw problem;
  for (const item of plan.actions) {
    const target = join(root, item.path);
    if (item.action === "删除") {
      rmSync(target, { force: true });
      continue;
    }
    const current = readRegular(target);
    if (current.problem) rmSync(target, { force: true });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, item.content);
  }
  const manifestFile = join(root, MANAGED_MANIFEST);
  if (readRegular(manifestFile).problem) rmSync(manifestFile, { force: true });
  mkdirSync(dirname(manifestFile), { recursive: true });
  if (plan.manifestChanged) writeFileSync(manifestFile, plan.manifestText);
  const versionFile = join(root, ".harness", "VERSION");
  mkdirSync(dirname(versionFile), { recursive: true });
  writeFileSync(versionFile, `${version}\n`);
  return plan.actions.map(({ path }) => path);
}

export function managedBlockBody() {
  return `## Harness

本项目的门禁由 harness 管理，以下要求适用于所有任务，不得跳过：

- 开始任何任务前（包括分析、设计与评审）先读 \`.harness/rules/core.md\`，再按场景读同目录下的方法文档；读不到时报告，不凭印象继续。
- 开始任务前读 \`.harness/pitfalls.md\` 避开本项目已知的坑。
- 先判断任务分级，在第一条回复里说明判断和依据；分析、评审、诊断类请求保持只读。
  需求已明确的小优化、小迭代或缺陷修复，不改库表、对外接口契约与数据兼容性，预计代码改动少于 500 行（测试、文档与锁文件不计）的，直接实施；阈值、依赖清单与敏感路径的条件以 \`core.md\` 为准，提交后可用 \`harness verify --plan\` 核对。
  直接实施也必须先写简短验收清单；小任务不需要另写 \`spec.md\` 与 \`plan.md\`，也不新增实施授权。
  不满足或拿不准时先探索、逐个澄清、写方案，交出方案后停下。
  方案交付后用户表达开始实施的意思才算授权，最初提出需求或回答澄清问题都不算。
- 改变行为的实施默认先红后绿：先把验收标准写成测试并确认失败，再实现到全部通过；不删测试、不弱化断言、不跳过检查。
- 改动放在任务分支里，交付只走 \`harness merge --branch <任务分支>\`（本地）或 \`harness submit --branch <任务分支>\`（远程，平台合入后 \`harness sync\`），按 \`.harness/config.json\` 的 \`delivery.mode\` 二选一，未配置时为 \`local\`。
- 主分支上经人确认的 \`delivery\` 设置就是这两条路径所需推送与 PR/MR 操作的授权，不逐次请示；Agent 自行 \`git push\`、推标签、强推、在平台上合并、部署与生产操作仍须单独授权。\n  用户本轮明确说暂不合并或暂不推送时照办。
- 已授权的任务连续推进到交付，轮次长短、耗时与上下文大小都不是停下的理由。\n  每一轮以工具调用推进，进度汇报只夹在工具调用之间；回应客户端的进度提醒后继续调用工具，不结束这一轮。\n  授权范围内的实现、提交、验证、按评审意见修改和交付直接执行，不以提问或选项征询是否继续；上下文压缩或续接已有任务后，沿用已确定的分级与授权。\n  需要人决定的阻塞先 \`harness escalate open\` 上报，\`context.branch\` 填任务分支；只差用户同意实施或人工确认时，说明要人做什么后结束，不用上报。

细则见 \`.harness/rules/harness.md\`。`;
}
