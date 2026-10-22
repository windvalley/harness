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

本项目的本地门禁由 harness 管。开发前先读 \`.harness/rules/core.md\`，按场景读同目录下的方法文档。
合并到主分支只能通过 \`harness merge --branch <任务分支>\`，它要求验证证据、独立评审，涉及其配置改动时还需要人工确认。
细则见 \`.harness/rules/harness.md\`。`;
}
