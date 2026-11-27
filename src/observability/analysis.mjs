import { isAncestor as gitIsAncestor } from "../lib/git.mjs";

const LINKED_EVENTS = new Set(["verify", "review", "merge", "submit.ready", "sync"]);

function firstAt(events) {
  return events.map((event) => event.at).sort()[0] ?? null;
}

export function buildTaskFunnel(project, { isAncestor = gitIsAncestor } = {}) {
  const events = project._events ?? [];
  const syncEvents = events.filter((event) => event.event === "sync");
  const groups = new Map();
  let unlinkedEvents = 0;
  for (const event of events) {
    if (!LINKED_EVENTS.has(event.event)) continue;
    if (!event.taskId && event.event !== "sync") {
      unlinkedEvents += 1;
      continue;
    }
    if (!event.taskId) continue;
    if (!groups.has(event.taskId)) groups.set(event.taskId, []);
    groups.get(event.taskId).push(event);
  }
  const tasks = [];
  for (const [taskId, items] of groups) {
    const verify = items.filter((event) => event.event === "verify");
    const review = items.filter((event) => event.event === "review" && event.outcome !== "exploratory");
    const deliveries = items.filter((event) => event.event === "merge" || event.event === "submit.ready");
    const remote = deliveries.find((event) => event.event === "submit.ready");
    const linkedSync = [];
    if (remote?.head) {
      for (const event of syncEvents) {
        try {
          if (event.to && isAncestor(project.mainWorktree, remote.head, event.to) && (!event.from || !isAncestor(project.mainWorktree, remote.head, event.from))) linkedSync.push(event);
        } catch {
          // 历史提交不可读时保留为未关联同步，不推断任务已完成。
        }
      }
    }
    const latestAt = items.map((event) => event.at).sort().at(-1);
    tasks.push({
      taskId,
      projectId: project.projectId,
      displayName: project.displayName,
      branch: items.find((event) => event.branch)?.branch ?? taskId.split("@")[0],
      verifyRuns: verify.length,
      reviewRuns: review.length,
      firstVerifyAt: firstAt(verify),
      firstReviewAt: firstAt(review),
      delivery: deliveries.length ? { kind: deliveries.at(-1).event, at: deliveries.at(-1).at, head: deliveries.at(-1).head ?? null } : null,
      syncAt: firstAt(linkedSync),
      latestAt,
      stages: {
        verify: verify.length > 0,
        review: review.length > 0,
        delivery: deliveries.length > 0,
        sync: linkedSync.length > 0,
      },
    });
  }
  tasks.sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  return { tasks, unlinkedEvents };
}
