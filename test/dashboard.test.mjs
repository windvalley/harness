import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../src/dashboard/server.mjs";

const running = [];
afterEach(async () => {
  while (running.length) await running.pop().close();
});

async function setup(snapshotFactory = ({ days }) => {
  if (![7, 30, 90].includes(days)) throw new Error("时间范围只支持 7、30、90 天");
  return { schemaVersion: 1, timeRange: { days }, projects: [], metrics: { total: {}, weeks: [] }, coverage: {}, warnings: [] };
}) {
  const dashboard = await startDashboard({ days: 30, snapshotFactory, now: Date.parse("2026-11-30T00:00:00.000Z") });
  running.push(dashboard);
  return dashboard;
}

const base = (dashboard) => `http://127.0.0.1:${dashboard.port}`;
const auth = (dashboard) => ({ "X-Harness-Token": dashboard.token });

function rawRequest(dashboard, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port: dashboard.port, path: "/api/v1/snapshot", headers }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
}

describe("本机 Dashboard HTTP 边界", () => {
  test("快照只接受有效令牌和允许的时间窗，响应不缓存且不开跨域", async () => {
    const dashboard = await setup();
    const response = await fetch(`${base(dashboard)}/api/v1/snapshot?days=7`, { headers: auth(dashboard) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).timeRange.days, 7);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal((await fetch(`${base(dashboard)}/api/v1/snapshot`, { headers: auth(dashboard) })).status, 200);
    assert.equal((await fetch(`${base(dashboard)}/api/v1/snapshot?days=8`, { headers: auth(dashboard) })).status, 400);
    assert.equal((await fetch(`${base(dashboard)}/api/v1/snapshot?days=7`, { headers: { Authorization: `Bearer ${dashboard.token}` } })).status, 200);
  });

  test("缺失令牌、伪造来源、跨站请求和写方法均被拒绝", async () => {
    const dashboard = await setup();
    const url = `${base(dashboard)}/api/v1/snapshot`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { "X-Harness-Token": "wrong" } })).status, 401);
    assert.equal((await fetch(url, { headers: { ...auth(dashboard), Origin: "https://evil.example" } })).status, 403);
    assert.equal(await rawRequest(dashboard, { ...auth(dashboard), Host: "evil.example" }), 403);
    assert.equal((await fetch(url, { headers: { ...auth(dashboard), "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await fetch(url, { method: "POST", headers: auth(dashboard) })).status, 405);
  });

  test("静态资源使用固定映射，路径与查询参数不能读任意文件", async () => {
    const dashboard = await setup();
    const index = await fetch(`${base(dashboard)}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /<html lang="zh-CN">/);
    for (const path of ["/%2e%2e/%2e%2e/package.json", "/..%2f..%2fpackage.json", "/api/v1/file?path=%2Fetc%2Fpasswd", "/dashboard.js?raw=1"]) {
      const response = await fetch(`${base(dashboard)}${path}`, { headers: auth(dashboard) });
      assert.equal(response.status, 404, path);
    }
    const css = await fetch(`${base(dashboard)}/dashboard.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);
  });

  test("真实 CLI 启动后可访问，SIGTERM 正常退出并关闭端口", async () => {
    const isolated = mkdtempSync(join(tmpdir(), "harness-dashboard-cli-"));
    const child = spawn(process.execPath, [new URL("../bin/harness.mjs", import.meta.url).pathname, "dashboard", "--no-open"], {
      env: { ...process.env, HARNESS_OBSERVABILITY_DIR: isolated },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待 Dashboard 启动超时: ${stderr}`)), 10000);
        child.stdout.on("data", () => {
          if (/Dashboard: http:\/\/127\.0\.0\.1:\d+\/#token=/.test(stdout)) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`Dashboard 提前退出 ${code}: ${stderr}`)));
      });
      const url = stdout.match(/Dashboard: (http:\/\/127\.0\.0\.1:\d+\/#token=[^\s]+)/)[1];
      const target = new URL(url);
      const token = new URLSearchParams(target.hash.slice(1)).get("token");
      const response = await fetch(`${target.origin}/api/v1/snapshot`, { headers: { "X-Harness-Token": token } });
      assert.equal(response.status, 200);
      const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
      child.kill("SIGTERM");
      const outcome = await exited;
      assert.deepEqual(outcome, { code: 0, signal: null });
      await assert.rejects(fetch(`${target.origin}/api/v1/snapshot`, { headers: { "X-Harness-Token": token } }));
      assert.match(stderr, /Dashboard 已关闭/);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("每次启动生成新令牌，关闭后端口不再响应", async () => {
    const first = await setup();
    const second = await setup();
    assert.notEqual(first.token, second.token);
    const url = `${base(first)}/api/v1/snapshot`;
    await first.close();
    running.splice(running.indexOf(first), 1);
    await assert.rejects(fetch(url, { headers: auth(first) }));
    assert.equal((await fetch(`${base(second)}/api/v1/snapshot`, { headers: auth(second) })).status, 200);
  });
});

describe("Dashboard 静态安全与可访问性契约", () => {
  test("页面不使用内联脚本、动态 HTML 注入或外部资源", () => {
    const html = readFileSync(new URL("../assets/dashboard/index.html", import.meta.url), "utf8");
    const js = readFileSync(new URL("../assets/dashboard/dashboard.js", import.meta.url), "utf8");
    const css = readFileSync(new URL("../assets/dashboard/dashboard.css", import.meta.url), "utf8");
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(html, /https?:\/\//i);
    assert.doesNotMatch(js, /innerHTML|outerHTML|document\.write|eval\(|new Function/);
    assert.doesNotMatch(js, /fetch\(["'`](?:https?:)?\/\//);
    assert.match(html, /<html lang="zh-CN">/);
    assert.match(html, /id="status"[^>]*role="status"/);
    assert.match(css, /:focus-visible/);
    assert.match(css, /@media \(pointer: coarse\)/);
    assert.match(css, /@media \(forced-colors: active\)/);
  });
});
