// DeepSeek Harness 守卫插件（Cordis）。
// 宿主的 tools/pre-execute 是 waterfall：这里返回 {kind:'deny', reason} 即拦下，
// 返回 next() 表示交给后续插件与工具执行，不会放行被其他插件拒绝的调用。
import { guard } from "../../src/adapters/index.mjs";
import { dsh } from "../../src/adapters/dsh.mjs";

export const name = "harness-guard";
export const inject = ["tools", "workingDirectory"];

function workingDirectory(ctx, agent, signal) {
  try {
    return ctx.workingDirectory ? ctx.workingDirectory.ensure(agent, signal) : undefined;
  } catch {
    return undefined;
  }
}

export function apply(ctx) {
  ctx.on("tools/pre-execute", async (exec, next) => {
    let cwd;
    try {
      cwd = await workingDirectory(ctx, exec.agent, exec.signal);
    } catch {
      cwd = undefined;
    }
    const outcome = guard({
      adapter: dsh,
      payload: {
        name: exec.name,
        arguments: exec.arguments,
        cwd,
      },
    });
    if (outcome.decision === "deny") {
      return { kind: "deny", reason: `[harness] ${outcome.result.reason}` };
    }
    if (outcome.decision === "error") {
      return { kind: "deny", reason: `[harness] 门禁无法加载项目配置: ${outcome.message}` };
    }
    return next();
  });
}
