(() => {
  const themeToggle = document.getElementById("theme-toggle");
  const colorScheme = document.querySelector('meta[name="color-scheme"]');
  const themeOrder = ["auto", "light", "dark"];
  const themeNames = { auto: "跟随系统", light: "浅色", dark: "深色" };
  const validThemes = new Set(themeOrder);

  function storedTheme() {
    try {
      const value = localStorage.getItem("harness-theme");
      return validThemes.has(value) ? value : "auto";
    } catch {
      return "auto";
    }
  }

  function applyTheme(theme) {
    const value = validThemes.has(theme) ? theme : "auto";
    colorScheme.content = value === "auto" ? "light dark" : value;
    const label = `颜色主题：${themeNames[value]}，点击切换`;
    themeToggle.dataset.theme = value;
    themeToggle.setAttribute("aria-label", label);
    themeToggle.title = label;
  }

  applyTheme(storedTheme());
  themeToggle.addEventListener("click", () => {
    const theme = themeOrder[(themeOrder.indexOf(themeToggle.dataset.theme) + 1) % themeOrder.length];
    applyTheme(theme);
    try {
      if (theme === "auto") localStorage.removeItem("harness-theme");
      else localStorage.setItem("harness-theme", theme);
    } catch {}
  });
  window.addEventListener("storage", (event) => {
    if (event.key === "harness-theme") applyTheme(storedTheme());
  });

  const drawer = document.getElementById("docs-drawer");
  const drawerOpen = document.getElementById("drawer-open");
  const drawerClose = document.getElementById("drawer-close");
  const drawerScroller = drawer.querySelector(".drawer-scroller");
  const drawerSheet = drawer.querySelector(".drawer-sheet");
  const visibleThreshold = 1 / window.innerWidth;

  function onDrawerOpened() {
    drawerOpen.setAttribute("aria-expanded", "true");
  }

  function onDrawerClosed() {
    if (drawer.open) drawer.close();
    drawerOpen.setAttribute("aria-expanded", "false");
  }

  const drawerObserver = new IntersectionObserver((entries) => {
    const entry = entries.at(-1);
    if (!drawer.open) return;
    if (entry.intersectionRatio < visibleThreshold) onDrawerClosed();
    if (entry.intersectionRatio === 1) onDrawerOpened();
  }, { root: drawer, threshold: [visibleThreshold, 1] });
  drawerObserver.observe(drawerSheet);

  async function openDrawer() {
    drawer.showModal();
    if (!CSS.supports("scroll-initial-target", "nearest")) {
      drawerScroller.scrollTo({ left: drawerScroller.offsetWidth, behavior: "instant" });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    drawerScroller.scrollTo({ left: 0, behavior: "auto" });
  }

  function closeDrawer() {
    drawerScroller.scrollTo({ left: drawerScroller.offsetWidth, behavior: "auto" });
  }

  drawerOpen.addEventListener("click", openDrawer);
  drawerClose.addEventListener("click", closeDrawer);
  drawer.addEventListener("click", (event) => {
    if (!drawerSheet.contains(event.target)) closeDrawer();
  });
  drawer.addEventListener("cancel", (event) => {
    if (event.cancelable) {
      event.preventDefault();
      closeDrawer();
    }
  });
  drawer.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => {
    if (drawer.open) closeDrawer();
  }));

  if (!CSS.supports("animation-timeline: scroll()")) {
    drawerScroller.addEventListener("scroll", () => {
      const ratio = 1 - drawerScroller.scrollLeft / drawerSheet.offsetWidth;
      drawer.style.setProperty("--drawer-backdrop", ratio);
    }, { passive: true });
  }

  const searchDialog = document.getElementById("search-dialog");
  const searchOpen = document.getElementById("search-open");
  const searchClose = document.getElementById("search-close");
  const searchInput = document.getElementById("search-input");
  const searchStatus = document.getElementById("search-status");
  const searchResults = document.getElementById("search-results");
  let searchIndexPromise;

  function loadSearchIndex() {
    if (!searchIndexPromise) {
      searchIndexPromise = fetch(`assets/search-index.json?v=${document.body.dataset.index || ""}`).then((response) => {
        if (!response.ok) throw new Error(`搜索索引请求失败: ${response.status}`);
        return response.json();
      }).catch((error) => {
        searchIndexPromise = undefined;
        throw error;
      });
    }
    return searchIndexPromise;
  }

  function resultSnippet(item, terms) {
    const text = item.text;
    const lower = text.toLowerCase();
    const position = Math.min(...terms.map((term) => lower.indexOf(term)).filter((value) => value >= 0), Infinity);
    if (!Number.isFinite(position)) return text.slice(0, 110) + (text.length > 110 ? "…" : "");
    const start = Math.max(0, position - 42);
    const end = Math.min(text.length, position + 90);
    return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
  }

  function scoreItem(item, terms) {
    const title = item.title.toLowerCase();
    const section = item.section.toLowerCase();
    const group = item.group.toLowerCase();
    const text = item.text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      let hit = 0;
      if (section === term || title === term) hit += 120;
      else if (section.includes(term)) hit += 80;
      else if (title.includes(term)) hit += 60;
      if (group.includes(term)) hit += 10;
      if (text.includes(term)) hit += 10;
      if (!hit) return 0;
      score += hit;
    }
    return score;
  }

  function renderSearchResults(index) {
    const terms = searchInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    searchResults.replaceChildren();
    if (!terms.length) {
      searchStatus.textContent = "输入关键词开始搜索";
      return;
    }
    const all = index.map((item) => ({ item, score: scoreItem(item, terms) })).filter((match) => match.score > 0).sort((a, b) => b.score - a.score);
    const matches = all.slice(0, 8);

    if (!all.length) searchStatus.textContent = "没有找到相关内容";
    else searchStatus.textContent = all.length > matches.length ? `找到 ${all.length} 处相关内容，显示前 ${matches.length} 处` : `找到 ${all.length} 处相关内容`;
    for (const { item } of matches) {
      const li = document.createElement("li");
      const link = document.createElement("a");
      const title = document.createElement("strong");
      const group = document.createElement("small");
      const snippet = document.createElement("p");
      link.href = item.url;
      title.textContent = item.section || item.title;
      group.textContent = item.section ? `${item.group} / ${item.title}` : item.group;
      snippet.textContent = resultSnippet(item, terms);
      link.append(title, group, snippet);
      link.addEventListener("click", () => searchDialog.close());
      li.append(link);
      searchResults.append(li);
    }
  }

  async function openSearch() {
    if (!searchDialog.open) searchDialog.showModal();
    searchInput.focus();
    searchStatus.textContent = "正在加载搜索索引…";
    try {
      const index = await loadSearchIndex();
      renderSearchResults(index);
    } catch {
      searchStatus.textContent = "搜索索引加载失败，请稍后重试";
    }
  }

  searchOpen.addEventListener("click", openSearch);
  searchClose.addEventListener("click", () => searchDialog.close());
  searchInput.addEventListener("input", async () => {
    try {
      renderSearchResults(await loadSearchIndex());
    } catch {
      searchStatus.textContent = "搜索索引加载失败，请稍后重试";
    }
  });
  searchDialog.addEventListener("click", (event) => {
    if (event.target === searchDialog) searchDialog.close();
  });
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openSearch();
    } else if (event.key === "/" && !typing && !searchDialog.open && !drawer.open) {
      event.preventDefault();
      openSearch();
    }
  });

  document.querySelectorAll(".code").forEach((box) => {
    const pre = box.querySelector("pre");
    if (!pre) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy";
    button.textContent = "复制";
    button.setAttribute("aria-label", "复制代码");
    const live = document.createElement("span");
    live.className = "visually-hidden";
    live.setAttribute("role", "status");
    let resetTimer;
    button.addEventListener("click", async () => {
      const text = pre.innerText.replace(/\n$/, "");
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.className = "visually-hidden";
        textarea.setAttribute("aria-hidden", "true");
        box.append(textarea);
        textarea.focus({ preventScroll: true });
        textarea.select();
        copied = document.execCommand("copy");
        textarea.remove();
        button.focus({ preventScroll: true });
      }
      clearTimeout(resetTimer);
      button.textContent = copied ? "已复制" : "复制失败";
      live.textContent = copied ? "已复制到剪贴板" : "复制失败";
      button.dataset.state = copied ? "done" : "failed";
      resetTimer = setTimeout(() => {
        button.textContent = "复制";
        live.textContent = "";
        delete button.dataset.state;
      }, 1500);
    });
    box.append(button, live);
  });

  requestAnimationFrame(() => document.documentElement.classList.add("page-ready"));

  const tocLinks = Array.from(document.querySelectorAll(".page-toc a[href^='#']"));
  const headings = tocLinks.map((link) => document.getElementById(link.getAttribute("href").slice(1))).filter(Boolean);

  function setCurrent(id) {
    tocLinks.forEach((link) => {
      const current = link.getAttribute("href") === `#${id}`;
      link.classList.toggle("target-current", current);
      if (current) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }

  if (headings.length) {
    if (CSS.supports("scroll-target-group: auto")) {
      document.querySelector(".page-toc nav").style.scrollTargetGroup = "auto";
      const syncNative = () => {
        const current = document.querySelector(".page-toc a:target-current");
        if (current) setCurrent(current.getAttribute("href").slice(1));
      };
      document.addEventListener("scrollend", syncNative);
      syncNative();
    } else {
      const visible = new Set();
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) visible.add(entry.target);
          else visible.delete(entry.target);
        });
        const current = headings.filter((heading) => visible.has(heading)).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]
          || headings.filter((heading) => heading.getBoundingClientRect().top <= 120).at(-1);
        if (current) setCurrent(current.id);
      }, { rootMargin: "-88px 0px -55% 0px", threshold: [0, 1] });
      headings.forEach((heading) => observer.observe(heading));
    }
    if (location.hash && headings.some((heading) => heading.id === location.hash.slice(1))) {
      setCurrent(location.hash.slice(1));
    }
  }
})();
