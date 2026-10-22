import { readLedger } from "../lib/store.mjs";

function weekKey(iso) {
  const date = new Date(iso);
  const day = (date.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

function emptyBucket() {
  return {
    merges: 0,
    verifyRuns: 0,
    verifyReused: 0,
    reviews: 0,
    reviewRejected: 0,
    policyDenials: 0,
    escalationsOpened: 0,
    escalationsAnswered: 0,
    postMergeFailures: 0,
    confirmations: 0,
    goldenRuns: 0,
    goldenLastPassRate: null,
    reviewCostUsd: 0,
    verifyTrees: 0,
    verifyFirstPass: 0,
  };
}

export function computeMetrics(events, { sinceDays } = {}) {
  const cutoff = sinceDays ? Date.now() - sinceDays * 86_400_000 : 0;
  const scoped = events.filter((event) => new Date(event.at).getTime() >= cutoff);
  const weeks = new Map();
  const total = emptyBucket();
  const seenTrees = new Set();

  for (const event of scoped) {
    const week = weekKey(event.at);
    if (!weeks.has(week)) weeks.set(week, emptyBucket());
    const buckets = [weeks.get(week), total];
    for (const bucket of buckets) {
      switch (event.event) {
        case "merge":
          bucket.merges += 1;
          break;
        case "verify":
          bucket.verifyRuns += 1;
          bucket.verifyReused += event.reused ?? 0;
          break;
        case "review":
          bucket.reviews += 1;
          if (event.verdict === "reject") bucket.reviewRejected += 1;
          bucket.reviewCostUsd += event.costUsd ?? 0;
          break;
        case "policy.deny":
          bucket.policyDenials += 1;
          break;
        case "escalate.open":
          bucket.escalationsOpened += 1;
          break;
        case "escalate.answer":
          bucket.escalationsAnswered += 1;
          break;
        case "merge.post_failed":
          bucket.postMergeFailures += 1;
          break;
        case "confirm.approve":
          bucket.confirmations += 1;
          break;
        case "golden":
          bucket.goldenRuns += 1;
          bucket.goldenLastPassRate = event.passRate;
          break;
        default:
          break;
      }
    }
    if (event.event === "verify" && event.tree && !seenTrees.has(event.tree)) {
      seenTrees.add(event.tree);
      for (const bucket of buckets) {
        bucket.verifyTrees += 1;
        if (event.status === "passed") bucket.verifyFirstPass += 1;
      }
    }
  }

  const rate = (num, den) => (den === 0 ? null : Number((num / den).toFixed(3)));
  const finish = (bucket) => ({
    ...bucket,
    reviewCostUsd: Number(bucket.reviewCostUsd.toFixed(4)),
    verifyFirstPassRate: rate(bucket.verifyFirstPass, bucket.verifyTrees),
    reviewRejectRate: rate(bucket.reviewRejected, bucket.reviews),
  });
  return {
    total: finish(total),
    weeks: [...weeks.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, bucket]) => ({ week, ...finish(bucket) })),
  };
}

export function metrics(root, options) {
  return computeMetrics(readLedger(root), options);
}

export function formatMetrics(result) {
  const pct = (value) => (value === null ? "-" : `${(value * 100).toFixed(0)}%`);
  const lines = ["周起始      合并 验证首过率 复用检查 评审拒绝率 策略拦截 门禁确认 黄金通过率"];
  for (const week of result.weeks) {
    lines.push(
      [
        week.week.padEnd(11),
        String(week.merges).padStart(4),
        pct(week.verifyFirstPassRate).padStart(9),
        String(week.verifyReused).padStart(8),
        pct(week.reviewRejectRate).padStart(9),
        String(week.policyDenials).padStart(8),
        String(week.confirmations).padStart(8),
        pct(week.goldenLastPassRate).padStart(9),
      ].join(" "),
    );
  }
  const t = result.total;
  lines.push(
    `合计: 合并 ${t.merges}，验证 ${t.verifyRuns} 次(复用检查 ${t.verifyReused} 项)，评审拒绝率 ${pct(t.reviewRejectRate)}，` +
      `策略拦截 ${t.policyDenials}，上报 ${t.escalationsOpened}(已答复 ${t.escalationsAnswered})，` +
      `门禁确认 ${t.confirmations}，评审花费 $${t.reviewCostUsd}`,
  );
  return lines.join("\n");
}
