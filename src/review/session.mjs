import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 会话模型只用来调整评审者顺序：和实现同模型的评审者排到最后，减少评审与实现共用同一套盲点。
// 数据来自客户端自己写的会话记录，不用环境变量：环境变量是启动时的值，会话中途切换模型后不再更新。

// 只读记录尾部，够覆盖最后一轮对话即可，会话再长也不整份读进来。
const TAIL_BYTES = 512 * 1024;

/**
 * 模型名的归一化写法，用来比较“是不是同一个模型”。
 * 同一个模型在不同来源里的写法不一样：claude-opus-5-5、coding-anthropic/claude-opus-5.5、
 * anthropic/claude-opus-5.5-cpr[1M] 都是同一个。统一小写、去掉厂商前缀、方括号后缀与 -cpr 这类限定词，
 * 再把点换成短横线。这只是名字比较，不是可靠的模型身份核对；
 * 判断“不同”要求归一化后不相等，判断“相同”要求相等，识别不出时按未知处理。
 */
export function normalizeModel(name) {
  if (typeof name !== "string") return "";
  let text = name.trim().toLowerCase();
  text = text.replace(/\[[^\]]*\]/g, "");
  text = text.slice(text.lastIndexOf("/") + 1);
  text = text.replace(/[._]/g, "-");
  text = text.replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
  for (const suffix of ["-cpr", "-latest", "-preview"]) {
    if (text.endsWith(suffix)) text = text.slice(0, -suffix.length);
  }
  return text.replace(/-+$/, "");
}

export function sameModel(left, right) {
  const a = normalizeModel(left);
  const b = normalizeModel(right);
  return Boolean(a) && a === b;
}

function readTailLines(file) {
  const size = statSync(file).size;
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  // 从中间截断的第一行可能不完整，解析失败时跳过即可。
  return buffer.toString("utf8").split("\n").filter((line) => line.startsWith("{"));
}

function lastAssistantModel(file) {
  const lines = readTailLines(file);
  for (let index = lines.length - 1; index >= 0; index--) {
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") continue;
    const model = entry.message?.model;
    // 合成消息（例如被策略拦下的回合）不是真实模型，不能拿它判断。
    if (typeof model !== "string" || !model.trim() || model.startsWith("<")) continue;
    return model;
  }
  return null;
}

function transcript(fileName, projects) {
  if (!existsSync(projects)) return null;
  let newest = null;
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, fileName);
    if (!existsSync(file)) continue;
    const at = statSync(file).mtimeMs;
    if (!newest || at > newest.at) newest = { file, at };
  }
  return newest?.file ?? null;
}

/**
 * 当前任务会话用的模型。识别不出时返回 model=null 和原因，调用方按原顺序运行评审者。
 * 目前只识别 Claude Code：它的会话编号在环境变量里，记录文件按编号命名，能唯一定位。
 * Codex 的会话记录要用 rollout 文件反查，对应关系还没实测，先当作未知。
 */
export function detectSessionModel({ env = process.env, home = homedir() } = {}) {
  const configDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const id = env.CLAUDE_CODE_SESSION_ID;
  if (!id) return { model: null, client: null, reason: "当前环境没有会话编号" };
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return { model: null, client: null, reason: "会话编号不合法" };
  try {
    const file = transcript(`${id}.jsonl`, join(configDir, "projects"));
    if (!file) return { model: null, client: null, reason: "找不到当前会话的记录" };
    const model = lastAssistantModel(file);
    if (!model) return { model: null, client: null, reason: "会话记录里没有可用的模型信息" };
    return { model, client: "claude", reason: null };
  } catch (error) {
    return { model: null, client: null, reason: error.message };
  }
}
