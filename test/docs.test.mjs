import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const docs = join(root, "docs");
const pages = readdirSync(docs).filter((file) => file.endsWith(".html"));

test("文档站生成结果与内容源一致", () => {
  const result = spawnSync(process.execPath, ["docs/build.mjs", "--check"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("文档页面保留唯一标题、导航状态和内部链接目标", () => {
  assert.ok(pages.length >= 10);
  for (const file of pages) {
    const html = readFileSync(join(docs, file), "utf8");
    const main = html.match(/<main\b[\s\S]*?<\/main>/)?.[0];
    assert.ok(main, `${file} 缺少 main`);
    assert.equal((main.match(/<h1\b/g) || []).length, 1, `${file} 应只有一个 h1`);
    assert.equal((html.match(/aria-current="page"/g) || []).length, 2, `${file} 的桌面和移动导航应标记当前页`);
    const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), (match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${file} 存在重复 id`);
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      const href = match[1];
      if (/^(?:https?:|data:)/.test(href)) continue;
      const [path, hash] = href.split("#");
      const targetFile = (path || file).split("?")[0];
      const targetPath = join(docs, targetFile);
      assert.ok(existsSync(targetPath), `${file} 的链接目标不存在: ${href}`);
      if (hash) {
        const target = readFileSync(targetPath, "utf8");
        assert.ok(target.includes(`id="${hash}"`), `${file} 的锚点不存在: ${href}`);
      }
    }
  }
});

test("SVG 的 url(#id) 引用都能在同页找到定义", () => {
  for (const file of pages) {
    const html = readFileSync(join(docs, file), "utf8");
    const ids = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (match) => match[1]));
    for (const match of html.matchAll(/url\(#([^)]+)\)/g)) {
      assert.ok(ids.has(match[1]), `${file} 引用了不存在的 ${match[1]}`);
    }
  }
});

test("正文标题层级不跳级，目录只含二三级标题", () => {
  for (const file of pages) {
    const html = readFileSync(join(docs, file), "utf8");
    const main = html.match(/<main\b[\s\S]*?<\/main>/)[0];
    let previous = 1;
    for (const match of main.matchAll(/<h([1-6])\b/g)) {
      const level = Number(match[1]);
      assert.ok(level <= previous + 1, `${file} 标题从 h${previous} 跳到 h${level}`);
      previous = level;
    }
  }
});

test("上一篇和下一篇与侧栏顺序一致", () => {
  const read = (file) => readFileSync(join(docs, file), "utf8");
  const order = Array.from(read("index.html").matchAll(/<nav class="docs-nav" aria-label="文档导航">([\s\S]*?)<\/nav>/g))
    .flatMap((nav) => Array.from(nav[1].matchAll(/<a href="([a-z]+\.html)"/g), (match) => match[1]));
  assert.equal(order.length, pages.length);
  order.forEach((file, index) => {
    const html = read(file);
    const previous = html.match(/<a class="previous" href="([^"]+)"/)?.[1];
    const next = html.match(/<a class="next" href="([^"]+)"/)?.[1];
    assert.equal(previous, order[index - 1], `${file} 的上一篇不符合侧栏顺序`);
    assert.equal(next, order[index + 1], `${file} 的下一篇不符合侧栏顺序`);
  });
});

test("相关链接不继承页内目录的负边距", () => {
  const css = readFileSync(join(docs, "assets", "docs.css"), "utf8");
  const relatedRule = css.match(/\.related-links a \{([^}]+)\}/)?.[1];
  assert.ok(relatedRule, "缺少相关链接样式");
  assert.match(relatedRule, /margin: 0/);
  assert.doesNotMatch(relatedRule, /margin-left: -/);
});
