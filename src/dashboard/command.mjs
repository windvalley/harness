import { spawn } from "node:child_process";
import { startDashboard } from "./server.mjs";

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

export async function runDashboard({ days = 30, port = 0, open = true, captureHealth = false, print = console.log, report = console.error } = {}) {
  const dashboard = await startDashboard({ days, port, captureHealth });
  print(`harness 本机只读 Dashboard: ${dashboard.url}`);
  print("仅统计已登记项目的关键流程事件；按 Ctrl-C 关闭服务。");
  if (open) openBrowser(dashboard.url);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await dashboard.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await new Promise((resolve) => dashboard.server.once("close", resolve));
  } finally {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
  }
  report("Dashboard 已关闭");
  return 0;
}
