import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { assetPath } from "../install/managed.mjs";
import { buildSnapshot } from "../observability/snapshot.mjs";

const ASSETS = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/dashboard.css": ["dashboard.css", "text/css; charset=utf-8"],
  "/dashboard.js": ["dashboard.js", "text/javascript; charset=utf-8"],
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

function headers(extra = {}) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": CSP,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  };
}

function respond(response, status, body, type) {
  response.writeHead(status, headers({ "Content-Type": type }));
  response.end(body);
}

function tokenMatches(actual, expected) {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function startDashboard({ days = 30, port = 0, snapshotFactory = buildSnapshot, now, captureHealth = false } = {}) {
  const token = randomBytes(32).toString("base64url");
  let healthCaptured = !captureHealth;
  const server = createServer((request, response) => {
    const address = server.address();
    const expectedOrigin = `http://127.0.0.1:${address.port}`;
    if (request.method !== "GET") {
      respond(response, 405, "Method not allowed\n", "text/plain; charset=utf-8");
      return;
    }
    if (request.headers.host !== `127.0.0.1:${address.port}` || (request.headers.origin && request.headers.origin !== expectedOrigin) || request.headers["sec-fetch-site"] === "cross-site") {
      respond(response, 403, "Forbidden\n", "text/plain; charset=utf-8");
      return;
    }
    let url;
    try {
      url = new URL(request.url, expectedOrigin);
    } catch {
      respond(response, 400, "Bad request\n", "text/plain; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/v1/snapshot") {
      const supplied = request.headers["x-harness-token"] ?? (request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : null);
      if (!tokenMatches(supplied, token)) {
        respond(response, 401, "Unauthorized\n", "text/plain; charset=utf-8");
        return;
      }
      try {
        const requestedDays = Number(url.searchParams.get("days") ?? days);
        const snapshot = snapshotFactory({ days: requestedDays, captureHealth: !healthCaptured, ...(now === undefined ? {} : { now }) });
        healthCaptured = true;
        respond(response, 200, JSON.stringify(snapshot), "application/json; charset=utf-8");
      } catch (error) {
        const clientError = /时间范围|采集时间/.test(error.message);
        respond(response, clientError ? 400 : 500, JSON.stringify({ error: clientError ? error.message : "无法生成本机观测快照" }), "application/json; charset=utf-8");
      }
      return;
    }
    const asset = ASSETS[url.pathname];
    if (!asset || url.search) {
      respond(response, 404, "Not found\n", "text/plain; charset=utf-8");
      return;
    }
    try {
      respond(response, 200, readFileSync(assetPath(`dashboard/${asset[0]}`)), asset[1]);
    } catch {
      respond(response, 500, "Dashboard assets unavailable\n", "text/plain; charset=utf-8");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const actualPort = server.address().port;
  return {
    server,
    token,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}/#token=${token}`,
    async close() {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}
