import { loadProject, loadTrustedProject } from "../lib/config.mjs";
import { isLinkedWorktree, repoRoot } from "../lib/git.mjs";
import { appendLedger } from "../lib/store.mjs";
import { evaluateCall } from "../policy/engine.mjs";
import { resolvePolicy } from "../policy/resolve.mjs";
import { planChecks } from "../verify/verify.mjs";

function checkPolicy(task, resolved, root, linkedWorktree) {
  const failures = [];
  for (const [index, step] of (task.steps ?? []).entries()) {
    const calls = step.paths
      ? step.paths.map((path) => ({ kind: step.kind, path, content: step.content }))
      : [step.kind === "shell" ? { kind: "shell", command: step.command } : { kind: step.kind, path: step.path, content: step.content }];
    let decision = "allow";
    let rule = null;
    for (const call of calls) {
      const result = evaluateCall({
        policy: resolved,
        root,
        call,
        context: { linkedWorktree: step.linkedWorktree ?? linkedWorktree, onMainBranch: step.onMainBranch ?? false },
      });
      decision = result.decision;
      rule = result.rule ?? null;
      if (decision === "deny") {
        if (!result.fix) failures.push(`步骤 ${index + 1} 被拒绝但没有给出正确做法(fix)`);
        break;
      }
    }
    if (decision !== step.expect) {
      failures.push(`步骤 ${index + 1} 期望 ${step.expect}，实际 ${decision}${rule ? `(${rule})` : ""}`);
      continue;
    }
    if (step.expect === "deny" && step.rule && rule !== step.rule) {
      failures.push(`步骤 ${index + 1} 期望规则 ${step.rule}，实际 ${rule}`);
    }
  }
  return failures;
}

function checkVerifyPlan(task, project, root) {
  const failures = [];
  const { plan, notExecuted, advisory, docOnly } = planChecks({
    project,
    cwd: root,
    changed: task.changed,
    exists: (path) => !(task.deleted || (task.deletedPaths ?? []).includes(path)),
  });
  const ids = new Set(plan.map((item) => item.id));
  const skipped = new Set(notExecuted.map((item) => item.id));
  const hints = new Set(advisory.map((item) => item.id));
  for (const id of task.expectChecks ?? []) if (!ids.has(id)) failures.push(`应选中检查 ${id}，实际: ${[...ids].join(",") || "空"}`);
  for (const id of task.forbidChecks ?? []) if (ids.has(id)) failures.push(`不应选中检查 ${id}`);
  for (const id of task.expectNotExecuted ?? []) if (!skipped.has(id)) failures.push(`应记入未执行项 ${id}`);
  for (const id of task.expectAdvisory ?? []) if (!hints.has(id)) failures.push(`应记为 advisory ${id}`);
  if (task.expectDocOnly !== undefined && task.expectDocOnly !== docOnly) {
    failures.push(`docOnly 期望 ${task.expectDocOnly}，实际 ${docOnly}`);
  }
  return failures;
}

/**
 * 默认按主分支上的配置重放，回答“当前生效的门禁是否健康”。
 * source=worktree 时按工作区里的配置重放，供验证检查在任务分支的检出里确认改过的规则没有退化。
 */
export function runGolden({ cwd, source = "main" }) {
  const project = source === "worktree" ? loadProject(repoRoot(cwd)) : loadTrustedProject(cwd);
  const root = project.root;
  const resolved = resolvePolicy(project.policy);
  const linkedWorktree = isLinkedWorktree(root);
  const tasks = project.golden.tasks ?? [];
  const results = tasks.map((task) => {
    const failures =
      task.kind === "policy"
        ? checkPolicy(task, resolved, root, linkedWorktree)
        : task.kind === "verify-plan"
          ? checkVerifyPlan(task, project, root)
          : [`未知的黄金任务类型 ${task.kind}`];
    return { id: task.id, title: task.title, kind: task.kind, passed: failures.length === 0, failures };
  });
  const passed = results.filter((item) => item.passed).length;
  const summary = { total: results.length, passed, failed: results.length - passed, passRate: results.length ? passed / results.length : 1 };
  appendLedger(root, { event: "golden", ...summary, failedIds: results.filter((item) => !item.passed).map((item) => item.id) });
  return { summary, results };
}
