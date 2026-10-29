import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sameModel } from "./session.mjs";

// 本机评审者文件：评审用哪个客户端、模型、推理强度和端点，是各机器自己的事，换模型不该走提交与门禁确认。
// 项目配置里只留判据（blockSeverities、maxDiffChars）。key 允许直接写在这个文件里，所以只由 harness reviewer 命令读写，
// 创建时权限收紧为 600，展示时只露末 4 位。

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const REVIEWER_CLIENTS = ["claude", "codex", "command"];
const TOP_KEYS = ["reviewers", "preferDifferentModel"];
const ENTRY_KEYS = ["name", "client", "model", "baseUrl", "apiKey", "effort", "timeoutMinutes", "maxBudgetUsd", "command"];
const MAX_TIMEOUT_MINUTES = 24 * 60;

export function reviewersFile(env = process.env, home = homedir()) {
  return env.HARNESS_REVIEWERS_FILE || join(home, ".config", "harness", "reviewers.json");
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// 错误信息里只写字段名和问题，不回显字段的值：apiKey 出错时也不能把 key 打进终端或会话记录。
function normalizeEntry(raw, index, fail, seen) {
  const at = `reviewers[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${at} 必须是对象`);
  for (const key of Object.keys(raw)) {
    if (!ENTRY_KEYS.includes(key)) fail(`${at} 里不认识的字段 ${key}，可用 ${ENTRY_KEYS.join("、")}`);
  }
  if (typeof raw.name !== "string" || !/^[A-Za-z0-9._-]+$/.test(raw.name)) fail(`${at}.name 必须是由字母、数字、点、下划线、短横线组成的名字`);
  if (seen.has(raw.name)) fail(`评审者名字 ${raw.name} 重复`);
  seen.add(raw.name);
  const label = `评审者 ${raw.name}`;
  if (!REVIEWER_CLIENTS.includes(raw.client)) fail(`${label} 的 client 必须是 ${REVIEWER_CLIENTS.join("、")} 之一`);
  const entry = { name: raw.name, client: raw.client };

  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || !raw.model.trim()) fail(`${label} 的 model 必须是非空字符串`);
    entry.model = raw.model.trim();
  }
  if (raw.client === "claude" && !entry.model) fail(`${label} 是 claude 客户端，必须写 model`);

  if (raw.effort !== undefined) {
    if (!EFFORTS.includes(raw.effort)) fail(`${label} 的 effort 必须是 ${EFFORTS.join("、")} 之一`);
    entry.effort = raw.effort;
  }
  if (raw.timeoutMinutes !== undefined) {
    if (!isPositiveNumber(raw.timeoutMinutes) || raw.timeoutMinutes > MAX_TIMEOUT_MINUTES) fail(`${label} 的 timeoutMinutes 必须是大于 0、不超过 ${MAX_TIMEOUT_MINUTES} 的数字`);
    entry.timeoutMinutes = raw.timeoutMinutes;
  }

  for (const field of ["baseUrl", "apiKey", "maxBudgetUsd"]) {
    if (raw[field] !== undefined && raw.client !== "claude") {
      fail(`${label} 的 ${field} 目前只对 claude 客户端有效；${raw.client} 接第三方端点的方式还没有实测`);
    }
  }
  if (raw.baseUrl !== undefined) {
    let url = null;
    try {
      url = new URL(raw.baseUrl);
    } catch {
      url = null;
    }
    if (typeof raw.baseUrl !== "string" || !url || !["http:", "https:"].includes(url.protocol)) fail(`${label} 的 baseUrl 必须是 http 或 https 地址`);
    entry.baseUrl = raw.baseUrl;
  }
  if (raw.apiKey !== undefined) {
    if (typeof raw.apiKey !== "string" || !raw.apiKey.trim()) fail(`${label} 的 apiKey 必须是非空字符串`);
    entry.apiKey = raw.apiKey.trim();
  }
  if (raw.maxBudgetUsd !== undefined) {
    if (!isPositiveNumber(raw.maxBudgetUsd)) fail(`${label} 的 maxBudgetUsd 必须是大于 0 的数字`);
    entry.maxBudgetUsd = raw.maxBudgetUsd;
  }

  if (raw.client === "command") {
    if (!Array.isArray(raw.command) || raw.command.length === 0 || raw.command.some((item) => typeof item !== "string" || !item)) {
      fail(`${label} 是 command 客户端，必须在 command 里给出命令数组`);
    }
    entry.command = raw.command;
  } else if (raw.command !== undefined) {
    fail(`${label} 的 command 只对 command 客户端有效`);
  }
  return entry;
}

/** 校验本机文件内容，返回规整后的结果；任何不认识的字段都报错，不悄悄忽略。 */
export function parseReviewers(data, file = "reviewers.json") {
  const fail = (message) => {
    throw new Error(`${file}: ${message}`);
  };
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("顶层必须是对象");
  for (const key of Object.keys(data)) {
    if (!TOP_KEYS.includes(key)) fail(`不认识的字段 ${key}，可用 ${TOP_KEYS.join("、")}`);
  }
  if (!Array.isArray(data.reviewers) || data.reviewers.length === 0) fail("reviewers 必须是非空数组");
  if (data.preferDifferentModel !== undefined && typeof data.preferDifferentModel !== "boolean") fail("preferDifferentModel 必须是 true 或 false");
  const seen = new Set();
  const reviewers = data.reviewers.map((raw, index) => normalizeEntry(raw, index, fail, seen));
  return { preferDifferentModel: data.preferDifferentModel !== false, reviewers };
}

/** 读本机文件；不存在返回 null（按项目旧字段运行），存在但读不出或不合法时抛错，不退回旧字段。 */
export function loadLocalReviewers({ file = reviewersFile() } = {}) {
  if (!existsSync(file)) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} 不是合法的 JSON: ${error.message}`);
  }
  return { file, ...parseReviewers(data, file), raw: data };
}

/** 原子写入，文件权限 600、目录权限 700。写之前先校验，不把不合法的内容落盘。 */
export function writeLocalReviewers(data, { file = reviewersFile() } = {}) {
  parseReviewers(data, file);
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  return file;
}

/**
 * 按任务会话的模型调整顺序：与会话同模型的评审者排到最后，其余保持原有先后。
 * 只调顺序、不删评审者；条目没写模型时无法判断，当作不同；会话模型未知时原样返回。
 */
export function orderReviewers(reviewers, sessionModel, prefer = true) {
  if (!prefer || !sessionModel) return { ordered: [...reviewers], reordered: false };
  const different = [];
  const same = [];
  for (const entry of reviewers) (entry.model && sameModel(entry.model, sessionModel) ? same : different).push(entry);
  const ordered = [...different, ...same];
  return { ordered, reordered: ordered.some((entry, index) => entry !== reviewers[index]) };
}

export function endpointHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

export function maskKey(key) {
  if (!key) return "";
  return key.length <= 8 ? "****" : `****${key.slice(-4)}`;
}
