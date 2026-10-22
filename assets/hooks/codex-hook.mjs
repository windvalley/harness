#!/usr/bin/env node
// Codex CLI PreToolUse 入口：拒绝时输出 permissionDecision，同时写 stderr 并返回非零退出码。
import { readFileSync } from "node:fs";
import { codex } from "../adapters/codex.mjs";
import { guard, renderDenial } from "../adapters/index.mjs";

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.stderr.write("[harness] 钩子输入不是有效 JSON，按失败处理\n");
    process.exit(2);
  }
  const outcome = guard({ adapter: codex, payload });
  if (outcome.decision === "error") {
    process.stderr.write(`[harness] 门禁无法加载项目配置: ${outcome.message}\n`);
    process.exit(2);
  }
  if (outcome.decision === "deny") {
    const rendered = renderDenial(outcome);
    if (rendered.stdout) process.stdout.write(rendered.stdout);
    process.stderr.write(rendered.stderr);
    process.exit(rendered.exitCode);
  }
  process.exit(0);
}

main();
