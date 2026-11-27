"use strict";

const initialParams = new URLSearchParams(location.hash.slice(1));
const initialToken = initialParams.get("token");
if (initialToken) sessionStorage.setItem("harness-dashboard-token", initialToken);
const accessToken = initialToken ?? sessionStorage.getItem("harness-dashboard-token");
const state = { snapshot: null, days: 30, request: 0 };
const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("zh-CN");
const percent = (value) => value === null || value === undefined ? "暂无样本" : `${(value * 100).toFixed(1)}%`;
const duration = (value) => value === null || value === undefined ? "未记录" : `${(value / 1000).toFixed(1)} 秒`;
const money = (value) => `$${Number(value ?? 0).toFixed(4)}`;
const costNote = (total) => total.reviewCostSamples === 0 && total.reviewCostMissing === 0 ? "没有评审事件" : total.reviewCostMissing ? `${total.reviewCostMissing} 次未记录成本` : "均有成本记录";
const dateTime = (value) => value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "无记录";
const day = (value) => value ? value.slice(0, 10) : "无记录";

function el(tag, { text, className, attrs = {} } = {}, children = []) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) item.setAttribute(key, String(value));
  }
  item.append(...children);
  return item;
}

function definitionList(entries) {
  const list = el("dl", { className: "metric-list" });
  for (const [label, value] of entries) {
    list.append(el("dt", { text: label }), el("dd", { text: String(value) }));
  }
  return list;
}

function empty(text) {
  return el("p", { className: "empty", text });
}

function badge(project) {
  const labels = { active: "有活动", no_activity: "窗口内无活动", no_data: "无账本", read_failed: "读取失败" };
  return el("span", { className: `badge ${project.state === "active" ? "ok" : project.state === "read_failed" ? "fail" : "warn"}`, text: labels[project.state] ?? project.status });
}

function renderSummary(snapshot) {
  const total = snapshot.metrics.total;
  const active = snapshot.projects.filter((project) => project.activeDays > 0).length;
  const cards = [
    ["已登记项目", snapshot.coverage.registeredProjects, `${active} 个窗口内活跃`],
    ["流程事件", number.format(snapshot.projects.reduce((sum, project) => sum + project.activityCount, 0)), "验证、评审、交付与策略等"],
    ["正式验证", total.verifyRuns, `首过 ${total.verifyFirstPass}/${total.verifyTrees}`],
    ["验证首过率", percent(total.verifyFirstPassRate), `${total.verifyFirstPass}/${total.verifyTrees}`],
    ["正式评审", total.reviews, `探索性 ${total.exploratoryReviews}`],
    ["评审拒绝率", percent(total.reviewRejectRate), `${total.reviewRejected}/${total.reviews}`],
    ["本地合并 / PR 就绪", `${total.merges} / ${total.submits}`, `同步 ${total.syncs}，不合并计数`],
    ["策略拒绝", total.policyDenials, "没有全部调用分母"],
    ["验证耗时", total.verifyDurationAverageMs === null ? "未记录" : duration(total.verifyDurationMs), `中位数 ${duration(total.verifyDurationMedianMs)}`],
    ["已记录评审成本", total.reviewCostSamples === 0 ? "未记录" : money(total.reviewCostUsd), costNote(total)],
  ];
  $("summary-cards").replaceChildren(...cards.map(([label, value, note]) => el("dl", { className: "card" }, [
    el("dt", { text: label }),
    el("dd", { text: String(value) }, [el("small", { text: note })]),
  ])));
  const coverage = snapshot.coverage;
  $("coverage").replaceChildren(definitionList([
    ["成功读取", coverage.readSucceededProjects],
    ["读取失败", coverage.readFailedProjects],
    ["无账本", coverage.noDataProjects],
    ["窗口内无活动", coverage.noActivityProjects],
    ["失联 / 不可读 / 无效", `${coverage.missingProjects} / ${coverage.unreadableProjects} / ${coverage.invalidProjects}`],
    ["旧事件（无法可靠去重）", coverage.legacyEvents],
    ["重复 / 坏行 / 未知事件", `${coverage.duplicateEvents} / ${coverage.invalidLines} / ${coverage.unknownEvents}`],
    ["事件时间范围", `${day(coverage.firstEventAt)} 至 ${day(coverage.lastEventAt)}`],
  ]));
  const attention = snapshot.insights.slice(0, 6).map((insight) => el("li", {}, [
    el("a", { text: insight.summary, attrs: { href: `#project=${insight.projectId}` } }),
  ]));
  $("attention").replaceChildren(attention.length ? el("ul", { className: "clean" }, attention) : empty("当前没有由确定性规则产生的改进提示。"));
}

function cell(text, label, value, className = "") {
  return el("td", { text: String(text), className, attrs: { "data-label": label, "data-value": value ?? (typeof text === "number" ? text : "") } });
}

function projectRow(project) {
  const row = el("tr");
  const name = el("th", { attrs: { scope: "row", "data-value": project.displayName } }, [
    el("a", { text: project.displayName, attrs: { href: `#project=${project.projectId}` } }),
  ]);
  row.append(
    name,
    cell(project.status, "登记状态", project.status),
    cell(project.activeDays, "活跃天数", project.activeDays, "number"),
    cell(project.activityCount, "流程事件", project.activityCount, "number"),
    cell(project.taskRates.verifyPerDeliveredTask === null ? "暂无交付" : project.taskRates.verifyPerDeliveredTask.toFixed(2), "验证/交付任务", project.taskRates.verifyPerDeliveredTask ?? "", "number"),
    cell(percent(project.metrics.total.verifyFirstPassRate), "验证首过率", project.metrics.total.verifyFirstPassRate ?? "", "number"),
    cell(percent(project.metrics.total.reviewRejectRate), "评审拒绝率", project.metrics.total.reviewRejectRate ?? "", "number"),
    cell(project.metrics.total.policyDenials, "策略拒绝", project.metrics.total.policyDenials, "number"),
    cell(project.lastHarnessVersion ?? project.latestEventHarnessVersion ?? "未记录", "harness 版本", project.lastHarnessVersion ?? ""),
    cell(project.config?.delivery.mode ?? "未知", "交付模式", project.config?.delivery.mode ?? ""),
  );
  return row;
}

function makeSortable(table) {
  const sort = (button) => {
    const header = button.closest("th");
    const direction = header.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
    for (const cell of table.tHead.rows[0].cells) cell.removeAttribute("aria-sort");
    header.setAttribute("aria-sort", direction);
    const index = header.cellIndex;
    const type = header.dataset.type;
    const factor = direction === "ascending" ? 1 : -1;
    const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
    const value = (row) => row.cells[index].dataset.value ?? row.cells[index].textContent.trim();
    const rows = [...table.tBodies[0].rows].sort((a, b) => {
      const left = value(a);
      const right = value(b);
      if (left === "" && right !== "") return 1;
      if (right === "" && left !== "") return -1;
      return factor * (type === "number" ? Number(left) - Number(right) : collator.compare(left, right));
    });
    for (const row of rows) table.tBodies[0].append(row);
    $("status").textContent = `已按${button.textContent.trim()}${direction === "ascending" ? "升序" : "降序"}排列，共 ${rows.length} 个项目`;
  };
  table.addEventListener("command", (event) => {
    if (event.command === "--sort") sort(event.source);
  });
  if (!("commandForElement" in HTMLButtonElement.prototype)) {
    for (const button of table.tHead.querySelectorAll("button[command='--sort']")) button.addEventListener("click", () => sort(button));
  }
}

function renderProjects(snapshot) {
  if (snapshot.projects.length === 0) {
    $("project-table").replaceChildren(empty("还没有登记项目。先在项目目录运行 harness projects add <路径>。"));
    return;
  }
  const columns = [
    ["项目", "text"], ["登记状态", "text"], ["活跃天数", "number"], ["流程事件", "number"], ["验证/交付任务", "number"], ["验证首过率", "number"],
    ["评审拒绝率", "number"], ["策略拒绝", "number"], ["harness 版本", "text"], ["交付模式", "text"],
  ];
  const table = el("table", { attrs: { id: "projects-data" } });
  table.append(el("caption", { attrs: { id: "projects-caption" }, text: `${snapshot.projects.length} 个已登记项目，可逐列排序` }));
  const head = el("tr");
  for (const [label, type] of columns) {
    head.append(el("th", { attrs: { scope: "col", "data-type": type } }, [
      el("button", { text: label, attrs: { type: "button", commandfor: "projects-data", command: "--sort" } }),
    ]));
  }
  table.append(el("thead", {}, [head]), el("tbody", {}, snapshot.projects.map(projectRow)));
  const wrapper = el("div", { className: "table-wrapper", attrs: { tabindex: "0", role: "region", "aria-labelledby": "projects-caption" } }, [table]);
  $("project-table").replaceChildren(wrapper);
  makeSortable(table);
}

function svgChart(weeks) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 800 260");
  svg.setAttribute("class", "chart");
  svg.setAttribute("role", "img");
  const make = (tag, attrs, text) => {
    const item = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, String(value));
    if (text !== undefined) item.textContent = text;
    return item;
  };
  svg.append(make("title", {}, "每周验证首过率与评审拒绝率"));
  for (let step = 0; step <= 4; step += 1) {
    const y = 25 + step * 45;
    svg.append(make("line", { x1: 55, x2: 780, y1: y, y2: y, class: "grid" }), make("text", { x: 45, y: y + 4, "text-anchor": "end" }, `${100 - step * 25}%`));
  }
  const x = (index) => 70 + index * (690 / Math.max(1, weeks.length - 1));
  weeks.forEach((week, index) => svg.append(make("text", { x: x(index), y: 245, "text-anchor": "middle" }, week.week.slice(5))));
  for (const [field, className] of [["verifyFirstPassRate", "verify"], ["reviewRejectRate", "review"]]) {
    const points = weeks.map((week, index) => ({ x: x(index), y: 205 - (week[field] ?? 0) * 180, value: week[field] })).filter((point) => point.value !== null);
    if (points.length > 1) svg.append(make("polyline", { class: className, points: points.map((point) => `${point.x},${point.y}`).join(" ") }));
    for (const point of points) svg.append(make("circle", { cx: point.x, cy: point.y, r: 4, class: className }));
  }
  return svg;
}

function renderTrends(snapshot) {
  const weeks = snapshot.metrics.weeks;
  const funnel = detailPanel("任务关联覆盖", definitionList([
    ["可关联任务", snapshot.taskFunnel.tasks.length],
    ["已交付任务", snapshot.taskFunnel.tasks.filter((task) => task.delivery).length],
    ["无法关联事件", snapshot.taskFunnel.unlinkedEvents],
  ]));
  if (weeks.length === 0) {
    $("trend-content").replaceChildren(funnel, empty("当前时间范围内没有可形成趋势的事件。"));
    return;
  }
  const figure = el("figure", {}, [
    svgChart(weeks),
    el("figcaption", { text: "实线仅连接已有样本点；绿色为验证首过率，黄色为评审拒绝率。下方表格提供相同数据。" }),
  ]);
  const table = el("table");
  table.append(el("caption", { attrs: { id: "trend-caption" }, text: "每周核心指标" }));
  table.append(el("thead", {}, [el("tr", {}, ["周起始", "验证", "首过率", "评审", "拒绝率", "本地合并", "PR 就绪", "策略拒绝"].map((label) => el("th", { text: label, attrs: { scope: "col" } })))]));
  table.append(el("tbody", {}, weeks.map((week) => el("tr", {}, [
    el("th", { text: week.week, attrs: { scope: "row" } }),
    cell(week.verifyRuns, "验证", week.verifyRuns),
    cell(percent(week.verifyFirstPassRate), "首过率", week.verifyFirstPassRate ?? ""),
    cell(week.reviews, "评审", week.reviews),
    cell(percent(week.reviewRejectRate), "拒绝率", week.reviewRejectRate ?? ""),
    cell(week.merges, "本地合并", week.merges),
    cell(week.submits, "PR 就绪", week.submits),
    cell(week.policyDenials, "策略拒绝", week.policyDenials),
  ]))));
  const wrapper = el("div", { className: "table-wrapper", attrs: { tabindex: "0", role: "region", "aria-labelledby": "trend-caption" } }, [table]);
  $("trend-content").replaceChildren(el("div", { className: "trend-grid" }, [funnel, figure, wrapper]));
}

function renderInsights(snapshot) {
  if (snapshot.insights.length === 0) {
    $("insight-list").replaceChildren(empty("当前没有改进提示。无提示不代表数据完整或项目已达到稳定状态。"));
    return;
  }
  const items = snapshot.insights.map((insight) => {
    const project = snapshot.projects.find((item) => item.projectId === insight.projectId);
    return el("article", { className: "insight" }, [
      el("h3", { text: insight.summary }),
      el("a", { text: project?.displayName ?? insight.projectId, attrs: { href: `#project=${insight.projectId}` } }),
      el("dl", {}, [
        el("dt", { text: "证据" }), el("dd", { text: insight.evidence }),
        el("dt", { text: "不确定性" }), el("dd", { text: insight.uncertainty }),
        el("dt", { text: "建议命令" }), el("dd", {}, [el("code", { className: "command", text: insight.command })]),
      ]),
    ]);
  });
  $("insight-list").replaceChildren(el("div", { className: "insight-list" }, items));
}

function detailPanel(title, content) {
  return el("section", { className: "detail-section" }, [el("h3", { text: title }), content]);
}

function healthHistoryContent(project) {
  if (project.healthHistory.length === 0) return empty("还没有健康历史。运行 harness metrics --all --capture-health，或启动 Dashboard 时加 --capture-health，显式记录一次采样。");
  return el("ol", { className: "clean" }, project.healthHistory.map((sample) => el("li", { text: `${dateTime(sample.capturedAt)} · ${sample.doctorOk ? "doctor 通过" : `doctor ${sample.failedChecks.length} 项未通过`} · 配置 ${sample.config.sourceCommit?.slice(0, 12) ?? "未知"} · ${sample.config.delivery.mode}` })));
}

function taskFunnelContent(project) {
  const tasks = project.taskFunnel.tasks;
  const list = tasks.map((task) => {
    const stages = [
      `验证 ${task.verifyRuns} 次`,
      `评审 ${task.reviewRuns} 次`,
      task.delivery ? `${task.delivery.kind} ${dateTime(task.delivery.at)}` : "尚未交付",
      task.syncAt ? `同步 ${dateTime(task.syncAt)}` : "未关联同步",
    ];
    return el("li", { text: `${task.branch} · ${stages.join(" → ")}` });
  });
  const content = tasks.length ? el("ol", { className: "clean" }, list) : empty("没有带稳定 taskId 的任务记录。");
  if (project.taskFunnel.unlinkedEvents > 0) return el("div", {}, [el("p", { className: "muted", text: `${project.taskFunnel.unlinkedEvents} 条事件无法可靠关联，未纳入任务漏斗。` }), content]);
  return content;
}

function renderDetail(snapshot, projectId) {
  const project = snapshot.projects.find((item) => item.projectId === projectId);
  if (!project) {
    $("detail-content").replaceChildren(empty("该项目不在当前登记范围或快照中。"));
    return;
  }
  const total = project.metrics.total;
  const sections = [el("h2", { attrs: { id: "detail-heading" }, text: project.displayName }), el("p", {}, [badge(project)])];
  sections.push(detailPanel("项目与配置", definitionList([
    ["主 Worktree", project.mainWorktree],
    ["登记状态", project.status],
    ["配置来源", project.config ? `${project.config.sourceRef}@${project.config.sourceCommit?.slice(0, 12) ?? "未知"}` : "无法读取"],
    ["交付模式", project.config?.delivery.mode ?? "未知"],
    ["规则 / 检查", project.config ? `${project.config.rules} / ${project.config.checks}` : "未知"],
    ["harness 版本", project.lastHarnessVersion ?? project.latestEventHarnessVersion ?? "未记录"],
    ["活跃天数 / 流程事件", `${project.activeDays} / ${project.activityCount}`],
  ])));
  sections.push(detailPanel("当前指标", definitionList([
    ["正式验证 / 首过", `${total.verifyRuns} / ${total.verifyFirstPass}／${total.verifyTrees}`],
    ["首过率", percent(total.verifyFirstPassRate)],
    ["正式评审 / 拒绝", `${total.reviews} / ${total.reviewRejected}`],
    ["评审拒绝率", percent(total.reviewRejectRate)],
    ["本地合并 / PR 就绪 / 同步", `${total.merges} / ${total.submits} / ${total.syncs}`],
    ["验证总耗时 / 中位数", total.verifyDurationAverageMs === null ? "未记录" : `${duration(total.verifyDurationMs)} / ${duration(total.verifyDurationMedianMs)}`],
    ["评审成本", total.reviewCostSamples === 0 ? "未记录" : `${money(total.reviewCostUsd)}（${total.reviewCostMissing} 次未记录）`],
  ])));
  const healthChecks = (project.health?.doctor.checks ?? []).map((check) => el("li", { text: `${check.ok ? "通过" : "未通过"} · ${check.id} · ${check.detail}` }));
  sections.push(detailPanel("采集时点健康状态", project.health ? el("ul", { className: "clean" }, healthChecks) : empty("当前没有健康读取结果。")));
  sections.push(detailPanel("健康与配置演进", healthHistoryContent(project)));
  sections.push(detailPanel("任务流程漏斗", taskFunnelContent(project)));
  const obligations = project.postMerge.pending.map((item) => el("li", { text: `${item.branch} · ${item.checkId} · ${item.howToVerify}` }));
  sections.push(detailPanel("合并后验收待办", obligations.length ? el("ul", { className: "clean" }, obligations) : empty("没有已读取到的待办。")));
  const timeline = project.recentEvents.map((event) => el("li", {}, [
    el("time", { text: dateTime(event.at), attrs: { datetime: event.at } }),
    el("span", { text: event.event }),
    el("span", { text: [event.outcome, event.branch, event.checkId, event.failed?.join("、")].filter(Boolean).join(" · ") || "未记录结果" }),
  ]));
  sections.push(detailPanel("最近流程事件", timeline.length ? el("ol", { className: "timeline" }, timeline) : empty("当前没有流程事件。")));
  const warnings = project.warnings.map((warning) => el("li", { text: `${warning.code}${warning.line ? ` · 第 ${warning.line} 行` : ""}${warning.detail ? ` · ${warning.detail}` : ""}` }));
  sections.push(detailPanel("数据质量", warnings.length ? el("ul", { className: "clean" }, warnings) : empty("没有发现账本解析或读取警告。")));
  $("detail-content").replaceChildren(...sections);
}

function navigate() {
  const hash = location.hash.slice(1);
  const detail = hash.startsWith("project=") ? hash.slice(8) : null;
  const view = detail ? "project-detail" : ["overview", "projects", "trends", "insights"].includes(hash) ? hash : "overview";
  for (const section of document.querySelectorAll(".view")) section.hidden = section.id !== view;
  for (const link of document.querySelectorAll("[data-view]")) {
    if (link.dataset.view === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  const titles = { overview: "harness 使用概览", projects: "项目使用差异", trends: "整体流程趋势", insights: "问题与改进", "project-detail": "项目详情" };
  $("view-title").textContent = titles[view];
  document.title = `${titles[view]} | harness`;
  if (state.snapshot) {
    if (detail) renderDetail(state.snapshot, detail);
    else if (view === "overview") renderSummary(state.snapshot);
  }
}

async function loadSnapshot() {
  const request = ++state.request;
  $("loading").hidden = false;
  $("refresh").disabled = true;
  $("error").hidden = true;
  try {
    const response = await fetch(`/api/v1/snapshot?days=${state.days}`, { headers: { "X-Harness-Token": accessToken ?? "" }, cache: "no-store" });
    if (!response.ok) throw new Error(response.status === 401 ? "访问令牌无效，请使用启动命令输出的完整地址重新打开。" : `读取快照失败（HTTP ${response.status}）`);
    const snapshot = await response.json();
    if (request !== state.request) return;
    state.snapshot = snapshot;
    $("generated").textContent = `采集于 ${dateTime(snapshot.generatedAt)} · ${day(snapshot.timeRange.since)} 至 ${day(snapshot.timeRange.until)}`;
    renderSummary(snapshot);
    renderProjects(snapshot);
    renderTrends(snapshot);
    renderInsights(snapshot);
    navigate();
    $("status").textContent = `快照已更新，共 ${snapshot.projects.length} 个登记项目`;
  } catch (error) {
    if (request === state.request) {
      $("error").textContent = error.message;
      $("error").hidden = false;
    }
  } finally {
    if (request === state.request) {
      $("loading").hidden = true;
      $("refresh").disabled = false;
    }
  }
}

$("days").addEventListener("change", () => {
  state.days = Number($("days").value);
  loadSnapshot();
});
$("refresh").addEventListener("click", loadSnapshot);
window.addEventListener("hashchange", navigate);
if (!accessToken) {
  $("error").textContent = "缺少访问令牌，请使用 harness dashboard 启动命令输出的完整地址。";
  $("error").hidden = false;
} else {
  history.replaceState(null, "", "#overview");
  loadSnapshot();
}
navigate();
