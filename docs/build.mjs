import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const checkOnly = process.argv.includes("--check");
const repository = "https://github.com/windvalley/harness";
const reference = `${repository}/blob/main/docs/reference.md`;
const assetVersion = createHash("sha256")
  .update(readFileSync(join(root, "assets", "docs.css")))
  .update(readFileSync(join(root, "assets", "docs.js")))
  .digest("hex")
  .slice(0, 10);

const pages = [
  { slug: "index", file: "index.html", source: "overview.html", title: "概览", home: true, description: "了解 harness 如何帮助 Agent 完成可验证、可审计的研发交付。" },
  { slug: "quickstart", file: "quickstart.html", source: "quickstart.html", title: "快速开始", description: "从接入项目到完成第一次受控交付，按步骤检查每一项结果。" },
  { slug: "daily", file: "daily.html", source: "daily.html", title: "日常工作流", description: "用自然语言提出需求，了解 Agent 如何实施、验证、评审并交付。" },
  { slug: "blocked", file: "blocked.html", source: "blocked.html", title: "被拦截时怎么办", description: "理解常见拦截与拒绝原因，按提示恢复任务。" },
  { slug: "architecture", file: "architecture.html", source: "architecture.html", title: "架构总览", description: "了解三层防线、组件关系，以及门禁数据存放的位置。" },
  { slug: "principles", file: "principles.html", source: "principles.html", title: "核心原理", description: "了解证据绑定、独立评审、实施授权与版本锁定等核心机制。" },
  { slug: "limits", file: "limits.html", source: "limits.html", title: "信任模型与限制", description: "明确本机门禁的保护边界、使用前提和已知限制。" },
  { slug: "customize", file: "customize.html", source: "customize.html", title: "按项目定制", description: "按项目实际情况调整配置、验证检查和拦截规则。" },
  { slug: "team", file: "team.html", source: "team.html", title: "团队与多机", description: "在新机器接入项目，完成升级、同步与多会话协作。" },
  { slug: "cheatsheet", file: "cheatsheet.html", source: "cheatsheet.html", title: "命令速查", description: "查阅验证、评审、交付、同步与维护命令。" },
];

const groups = [
  { title: "开始使用", slugs: ["index", "quickstart", "daily", "blocked"] },
  { title: "核心概念", slugs: ["architecture", "principles", "limits"] },
  { title: "配置与维护", slugs: ["customize", "team"] },
  { title: "参考", slugs: ["cheatsheet"], reference: true },
];

const groupOf = new Map(groups.flatMap((group) => group.slugs.map((slug) => [slug, group.title])));
for (const page of pages) {
  if (!groupOf.has(page.slug)) throw new Error(`页面 ${page.slug} 未加入任何导航分组`);
  page.group = groupOf.get(page.slug);
}
const orderedPages = groups.flatMap((group) => group.slugs.map((slug) => pages.find((page) => page.slug === slug)));
if (orderedPages.length !== pages.length) throw new Error("导航分组与页面列表的数量不一致");

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function textOf(html) {
  return html
    .replace(/<svg\b[\s\S]*?<\/svg>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();
}

const anchorTargets = {};
for (const page of orderedPages) {
  const source = readFileSync(join(root, "content", page.source), "utf8");
  const firstHeading = source.match(/<h2\b[^>]*\bid="([^"]+)"/g)?.[0];
  const pageAnchor = firstHeading?.match(/id="([^"]+)"/)?.[1];
  for (const match of source.matchAll(/<h[1-4]\b[^>]*\bid="([^"]+)"/g)) {
    anchorTargets[match[1]] = !page.home && match[1] === pageAnchor ? page.file : `${page.file}#${match[1]}`;
  }
}

const externalIcon = `<svg class="external" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></svg>`;

function navigation(currentSlug, mobile = false) {
  const sections = groups.map((group) => {
    const links = group.slugs.map((slug) => {
      const page = pages.find((item) => item.slug === slug);
      const current = slug === currentSlug;
      return `<li><a href="${page.file}"${current ? ' aria-current="page"' : ""}>${page.title}</a></li>`;
    }).join("");
    const referenceLink = group.reference ? `<li><a href="${reference}">参考手册${externalIcon}</a></li>` : "";
    return `<section class="nav-group"><h2>${group.title}</h2><ul>${links}${referenceLink}</ul></section>`;
  }).join("");
  return `<nav class="docs-nav" aria-label="${mobile ? "移动端文档导航" : "文档导航"}">${sections}</nav>`;
}

function changeHeadingLevels(content, page) {
  const stepsAsSections = page.slug === "quickstart" || page.slug === "customize";
  const levels = page.home ? { 3: 3, 4: 3 } : { 3: 2, 4: stepsAsSections ? 2 : 3 };
  return content.replace(/<(\/?)h([34])\b/g, (_, slash, level) => `<${slash}h${levels[level]}`);
}

const arrowDefs = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>${["", "accent", "deny", "allow"].map((kind) => `<marker id="${kind ? `ar-${kind}` : "ar"}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="mk${kind ? ` ${kind}` : ""}" d="M0,0 L10,5 L0,10 z"/></marker>`).join("")}</defs></svg>`;

function pageToc(content) {
  const items = [];
  for (const match of content.matchAll(/<h([23])\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)) {
    items.push({ level: Number(match[1]), id: match[2], title: textOf(match[3]) });
  }
  if (!items.length) return { html: "", items };
  const links = items.map((item) => `<li class="toc-level-${item.level}"><a href="#${item.id}">${escapeHtml(item.title)}</a></li>`).join("");
  return { html: `<div class="page-toc-title">本页内容</div><ol>${links}</ol>`, items };
}

function keepCommandArgsTogether(content) {
  return content.replace(/(<table class="t-cmd">[\s\S]*?<\/table>)/, (table) => table.replace(/<tr><td><code>([^<]*)<\/code>/g, (_, command) => {
    const parts = command.split(" ").map((part) => `<span class="arg">${part}</span>`);
    return `<tr><td><code>${parts.join(" ")}</code>`;
  }));
}

function prepareContent(page) {
  let content = readFileSync(join(root, "content", page.source), "utf8").trim();
  if (!page.home) {
    const firstHeading = /<h2 id="([^"]+)">([^<]+)<\/h2>/.exec(content);
    if (!firstHeading) throw new Error(`${page.source} 缺少页面标题`);
    const header = `<header class="page-header"><p class="eyebrow">${page.group}</p><h1 id="${firstHeading[1]}">${firstHeading[2]}</h1><p class="lead">${page.description}</p></header>`;
    content = content.replace(firstHeading[0], header);
  }
  content = changeHeadingLevels(content, page);
  if (page.slug === "cheatsheet") content = keepCommandArgsTogether(content);
  let generatedHeading = 0;
  content = content.replace(/<h2(?![^>]*\bid=)([^>]*)>/g, () => {
    generatedHeading += 1;
    const id = page.slug === "quickstart" ? `step-${generatedHeading}` : `${page.slug}-section-${generatedHeading}`;
    return `<h2 id="${id}">`;
  });
  content = content.replace(/<h([1-3])\b id="/g, '<h$1 tabindex="-1" id="');
  content = content.replace(/href="#([^"]+)"/g, (match, id) => anchorTargets[id] ? `href="${anchorTargets[id]}"` : match);
  return content;
}

function pagination(page) {
  const index = orderedPages.indexOf(page);
  const previous = orderedPages[index - 1];
  const next = orderedPages[index + 1];
  if (!previous && !next) return "";
  return `<nav class="pagination" aria-label="文档分页">${previous ? `<a class="previous" href="${previous.file}"><span>上一篇</span><strong>${previous.title}</strong></a>` : "<span></span>"}${next ? `<a class="next" href="${next.file}"><span>下一篇</span><strong>${next.title}</strong></a>` : ""}</nav>`;
}

const logo = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>`;

function renderPage(page, content, toc) {
  const legacyRedirect = page.home ? `<script>if(location.hash){const targets=${JSON.stringify(anchorTargets)};const target=targets[location.hash.slice(1)];if(target&&target!==${JSON.stringify("index.html")}+location.hash)location.replace(target);}</script>` : "";
  const mobileToc = toc.html ? `<details class="mobile-page-toc"><summary>本页内容</summary>${toc.html}</details>` : "";
  if (mobileToc) {
    const anchor = page.home ? "</section>" : "</header>";
    content = content.replace(anchor, `${anchor}${mobileToc}`);
  }
  return `<!doctype html>
<!-- 本文件由 node docs/build.mjs 生成，请勿直接编辑。 -->
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title} | harness 文档</title>
<meta name="description" content="${escapeHtml(page.description)}">
<meta name="color-scheme" content="light dark">
<script>try{const theme=localStorage.getItem("harness-theme");if(theme==="light"||theme==="dark")document.querySelector('meta[name="color-scheme"]').content=theme;}catch{}</script>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%230f766e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z'/%3E%3Cpath d='M8.5 12l2.5 2.5 4.5-5'/%3E%3C/svg%3E">
<link rel="stylesheet" href="assets/docs.css?v=${assetVersion}">
${legacyRedirect}
<script src="assets/docs.js?v=${assetVersion}" defer></script>
</head>
<body data-page="${page.slug}">
<a class="skip-link" href="#main-content">跳到主要内容</a>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="index.html" aria-label="harness 文档首页">${logo}<span>harness</span></a>
    <span class="brand-divider" aria-hidden="true"></span><span class="product-area">文档</span>
    <nav class="topnav" aria-label="主导航">
      <a class="wide" href="${reference}">参考手册</a>
      <a class="wide" href="${repository}">GitHub</a>
      <button class="search-open" id="search-open" type="button" aria-label="搜索文档" aria-keyshortcuts="Meta+K Control+K"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><span class="wide">搜索文档</span><kbd class="wide" aria-hidden="true">⌘K</kbd></button>
      <button class="theme-toggle" id="theme-toggle" type="button" data-theme="auto" aria-label="颜色主题：跟随系统，点击切换" title="颜色主题：跟随系统，点击切换"><svg class="i-auto" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg><svg class="i-light" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><svg class="i-dark" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg></button>
      <button class="drawer-open" id="drawer-open" type="button" aria-label="打开文档目录" aria-expanded="false" aria-controls="docs-drawer"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg><span>目录</span></button>
    </nav>
  </div>
</header>
<div class="layout">
  <aside class="sidebar">${navigation(page.slug)}</aside>
  <main id="main-content">${content.includes("url(#ar") ? arrowDefs : ""}${content}${pagination(page)}</main>
  <aside class="page-toc">${toc.html ? `<nav aria-label="本页内容">${toc.html}</nav>` : ""}<div class="related-links"><h2>相关链接</h2><a href="${reference}">参考手册</a><a href="${repository}">GitHub 仓库</a></div></aside>
</div>
<footer>harness · MIT 许可 · <a href="${repository}">GitHub</a> · <a href="${reference}">参考手册</a></footer>
<dialog class="drawer" id="docs-drawer" aria-label="文档导航">
  <div class="drawer-scroller">
    <div class="drawer-sheet">
      <div class="drawer-header"><strong>文档导航</strong><button id="drawer-close" type="button" aria-label="关闭文档目录" autofocus>关闭</button></div>
      ${navigation(page.slug, true)}
    </div>
  </div>
</dialog>
<dialog class="search-dialog" id="search-dialog" aria-labelledby="search-title">
  <div class="search-header"><h2 id="search-title">搜索文档</h2><button id="search-close" type="button" aria-label="关闭搜索">关闭</button></div>
  <label class="search-field"><span class="visually-hidden">搜索关键词</span><input id="search-input" type="search" placeholder="搜索标题、正文或命令" autocomplete="off"></label>
  <p class="search-status" id="search-status" role="status">输入关键词开始搜索</p>
  <ul class="search-results" id="search-results"></ul>
</dialog>
</body>
</html>
`;
}

const outputs = new Map();
const searchIndex = [];
for (const page of orderedPages) {
  const content = prepareContent(page);
  const toc = pageToc(content);
  outputs.set(page.file, renderPage(page, content, toc));
  searchIndex.push({ title: page.title, group: page.group, description: page.description, url: page.file, text: textOf(content) });
}
outputs.set("assets/search-index.json", `${JSON.stringify(searchIndex)}\n`);

let stale = [];
for (const [file, content] of outputs) {
  const path = join(root, file);
  if (checkOnly) {
    let current = "";
    try { current = readFileSync(path, "utf8"); } catch {}
    if (current !== content) stale.push(file);
  } else {
    writeFileSync(path, content);
  }
}
if (stale.length) {
  console.error(`生成结果已过期: ${stale.join(", ")}\n请运行 node docs/build.mjs`);
  process.exitCode = 1;
} else {
  console.log(`${checkOnly ? "已核对" : "已生成"} ${pages.length} 个文档页面和搜索索引`);
}
