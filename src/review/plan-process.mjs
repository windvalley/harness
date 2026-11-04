import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const REPO_TOOLS = new Set(["Read", "Grep", "Glob", "Bash"]);
const STOP_GRACE_MS = 200;

const DELTA_FIELDS = { thinking_delta: "thinking", text_delta: "text", input_json_delta: "partial_json" };

// 区分思考、正文、工具参数和结构化结论，只报累计字符数，不输出内容；阶段切换时才播报，同阶段只更新状态。
function streamPhase(report) {
  const sizes = {};
  let toolName = "";
  let lastKind = "";
  return (event) => {
    if (event.type === "content_block_start") toolName = event.content_block?.type === "tool_use" ? event.content_block.name : "";
    if (event.type !== "content_block_delta") return;
    const field = DELTA_FIELDS[event.delta?.type];
    const text = field ? event.delta[field] : undefined;
    if (typeof text !== "string") return;
    const kind = field === "partial_json" ? (toolName === "StructuredOutput" ? "结论" : "工具参数") : field === "thinking" ? "思考" : "正文";
    sizes[kind] = (sizes[kind] ?? 0) + text.length;
    report(`模型输出${kind}（累计 ${sizes[kind]} 字符）`, kind !== lastKind);
    lastKind = kind;
  };
}

function claudeProgress(report, onQuery) {
  const tools = new Map();
  const phase = streamPhase(report);
  let sawResponse = false;
  return (message) => {
    if (message.type === "stream_event") phase(message.event ?? {});
    if (message.type === "system" && message.subtype === "init") report("评审会话已初始化");
    if (message.type === "system" && message.subtype === "api_retry") report("模型请求重试");
    if (message.type === "assistant" || (message.type === "stream_event" && message.event?.type === "message_start")) {
      if (!sawResponse) report("收到首个模型响应");
      else if (message.type === "stream_event") report("收到模型响应");
      sawResponse = true;
    }
    const blocks = message.message?.content;
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (message.type === "assistant" && block?.type === "tool_use" && REPO_TOOLS.has(block.name)) {
        tools.set(block.id, block.name);
        report("仓库查询开始（" + block.name + "）");
        onQuery();
      }
      if (message.type === "user" && block?.type === "tool_result" && tools.has(block.tool_use_id)) {
        report("仓库查询结束（" + tools.get(block.tool_use_id) + "）");
        tools.delete(block.tool_use_id);
      }
    }
  };
}

function codexProgress(message, report, onQuery) {
  if (message.type === "thread.started") report("评审会话已初始化");
  if (message.type === "turn.started") report("评审回合已开始");
  if (message.type === "item.started" && message.item?.type === "command_execution") {
    report("评审命令开始");
    onQuery();
  }
  if (message.type === "item.completed" && message.item?.type === "command_execution") report("评审命令结束");
  if (message.type === "turn.completed") report("评审回合已结束");
}

function readJsonLine(line, receive) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message && typeof message.type === "string") receive(message);
}

// 方案评审独立管理子进程组，取消或超时时把普通后代一起收掉，避免它们继续占用管道。
export function runPlanProcess(cmd, args, { cwd, env, input, client, deadline, signal, report, maxQueries }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const processGroup = process.platform !== "win32";
    const child = spawn(cmd, args, { cwd, env, detached: processGroup, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let payload;
    let bytes = 0;
    let processError;
    let stopped;
    let stopping;
    let queries = 0;
    const onQuery = () => {
      if (maxQueries && ++queries > maxQueries) {
        stop(Object.assign(new Error(`仓库查询超过 ${maxQueries} 次，已终止`), { code: "QUERY_LIMIT", maxQueries }));
      }
    };
    const reportClaude = client === "claude" ? claudeProgress(report, onQuery) : null;

    const receive = (message) => {
      if (client === "codex") {
        codexProgress(message, report, onQuery);
        let failure;
        if (message.type === "turn.failed") failure = message.error?.message;
        if (message.type === "error") failure = message.message;
        if (typeof failure === "string") stdout = failure.slice(-4096);
        return;
      }
      if (message.type === "result") {
        payload = message;
        report("收到最终评审事件");
      } else reportClaude(message);
    };
    const sendSignal = (name) => {
      if (!child.pid) return;
      try {
        if (processGroup) process.kill(-child.pid, name);
        else child.kill(name);
      } catch (error) {
        if (error.code !== "ESRCH") processError ??= error;
      }
    };
    const stop = (error) => {
      if (stopped) return;
      stopped = error;
      child.stdin.destroy();
      sendSignal("SIGTERM");
      stopping = new Promise((done) => setTimeout(() => {
        sendSignal("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        done();
      }, STOP_GRACE_MS));
    };
    const abort = () => stop(signal.reason);
    const timedOut = () => stop(Object.assign(new Error("评审进程超时"), { code: "ETIMEDOUT" }));
    const timer = setTimeout(timedOut, Math.max(0, deadline - performance.now()));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

    const acceptChunk = (chunk) => {
      if (stopped) return false;
      bytes += Buffer.byteLength(chunk);
      if (bytes <= MAX_OUTPUT_BYTES) return true;
      stop(new Error("评审进程输出超过大小上限"));
      return false;
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      if (!acceptChunk(chunk)) return;
      if (client === "command") {
        stdout += chunk;
        report("收到评审进程输出", false);
        return;
      }
      const lines = chunk.split("\n");
      if (lines.length === 1) {
        pending += chunk;
        return;
      }
      lines[0] = pending + lines[0];
      pending = lines.pop();
      for (const line of lines) readJsonLine(line, receive);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      if (!acceptChunk(chunk)) return;
      stderr = (stderr + chunk).slice(-4096);
      if (client !== "claude") report("收到评审进程诊断输出", false);
    });
    child.on("error", (error) => { processError ??= error; });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") stop(error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (!stopped && performance.now() >= deadline) timedOut();
      if (stopped) {
        stopping.then(() => reject(stopped));
        return;
      }
      if (pending) readJsonLine(pending, receive);
      resolve({ status: status ?? (processError ? 127 : 1), stdout, stderr, error: processError, payload });
    });
    if (!stopped) child.stdin.end(input, "utf8");
  });
}
