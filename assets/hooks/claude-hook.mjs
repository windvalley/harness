#!/usr/bin/env node
// Claude Code PreToolUse 入口：读 stdin 的 JSON，拒绝时退出码 2，stderr 作为反馈。
import { readFileSync } from "node:fs";
import { claude } from "../adapters/claude.mjs";
import { guard, renderDenial } from "../adapters/index.mjs";

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.stderr.write("[harness] 钩子输入不是有效 JSON，按失败处理\n");
    process.exit(2);
  }
  const outcome = guard({ adapter: claude, payload });
  if (outcome.decision === "error") {
    process.stderr.write(`[harness] 门禁无法加载项目配置: ${outcome.message}\n`);
    process.exit(2);
  }
  if (outcome.decision === "deny") {
    const rendered = renderDenial(outcome);
    process.stderr.write(rendered.stderr);
    process.exit(rendered.exitCode);
  }
  process.exit(0);
}

main();
