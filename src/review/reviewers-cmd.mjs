import { existsSync, readFileSync, rmSync } from "node:fs";
import { parseArgs } from "node:util";
import { planReviewers, probeReviewer } from "./review.mjs";
import { EFFORTS, endpointHost, loadLocalReviewers, maskKey, reviewersFile, writeLocalReviewers } from "./reviewers.mjs";

const USAGE = `用法:
  harness reviewer list                               列出本机评审者与是否可用
  harness reviewer set <名称> [选项]                  新增或修改一个评审者
      --client <claude|codex|command>   新增时必填
      --model <模型>                     claude 必填
      --base-url <地址>                  第三方端点（只对 claude 有效）
      --api-key-stdin                    从标准输入读 key，不经过命令行参数
      --effort <${EFFORTS.join("|")}>    推理强度
      --timeout-minutes <分钟>           单次评审的超时，默认 20
      --max-budget-usd <美元>            单次评审的花费上限（只对 claude 有效），不配就不限
      --command-json <JSON 数组>         command 客户端的命令
      --clear <字段>                     清掉一个字段，可重复；可清 model、baseUrl、apiKey、effort、timeoutMinutes、maxBudgetUsd
      --first                            放到列表最前面
  harness reviewer remove <名称>                      删除一个评审者
  harness reviewer prefer <on|off>                    是否优先使用与会话模型不同的评审者，默认开
  harness reviewer test <名称>                        用极小的材料实际跑一次，确认能用（会产生少量费用）
`;

const CLEARABLE = ["model", "baseUrl", "apiKey", "effort", "timeoutMinutes", "maxBudgetUsd"];

function readRaw(file) {
  if (!existsSync(file)) return { reviewers: [] };
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} 不是合法的 JSON，先修好或删掉它: ${error.message}`);
  }
}

function describe(entry) {
  const parts = [
    entry.client,
    entry.model,
    entry.effort && `effort ${entry.effort}`,
    entry.baseUrl && `端点 ${endpointHost(entry.baseUrl)}`,
    entry.apiKey && `key ${maskKey(entry.apiKey)}`,
    entry.timeoutMinutes && `超时 ${entry.timeoutMinutes} 分钟`,
    entry.maxBudgetUsd && `预算 ${entry.maxBudgetUsd} 美元`,
    entry.command && `命令 ${entry.command[0]}`,
  ];
  return parts.filter(Boolean).join("，");
}

function list({ file, print }) {
  const local = loadLocalReviewers({ file });
  if (!local) {
    const plan = planReviewers({}, { local: null });
    print(`本机评审者文件: ${file}（不存在）`);
    print(`当前按项目配置里的旧字段运行: ${plan.candidates.map((entry) => `${entry.client}${entry.model ? `（${entry.model}）` : ""}`).join("、")}`);
    print("要指定模型、推理强度或第三方端点，例如:");
    print("  harness reviewer set flash --client claude --model <模型> --base-url <地址> --api-key-stdin --effort high");
    return 0;
  }
  const plan = planReviewers({}, { local });
  const byName = new Map(plan.candidates.map((entry) => [entry.name, entry]));
  print(`本机评审者文件: ${file}`);
  print(`优先使用与会话模型不同的评审者: ${local.preferDifferentModel ? "开" : "关"}`);
  let usable = 0;
  local.reviewers.forEach((entry, index) => {
    const candidate = byName.get(entry.name);
    if (!candidate.skip) usable += 1;
    print(`  ${index + 1}. ${entry.name}  ${describe(entry)}  ${candidate.skip ? `[不可用: ${candidate.skip}]` : "[可用]"}`);
  });
  if (local.preferDifferentModel) {
    print(plan.sessionModel ? `当前会话模型: ${plan.sessionModel}${plan.reordered ? `；本会话实际尝试顺序: ${plan.candidates.map((entry) => entry.name).join(" -> ")}` : "；顺序无需调整"}` : `${plan.sessionNote}`);
  }
  if (usable === 0) print("没有可用的评审者：补全上面标出的问题，或用 harness reviewer set 新增");
  return usable > 0 ? 0 : 1;
}

function set({ file, print, readStdin, args }) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      client: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "api-key-stdin": { type: "boolean", default: false },
      effort: { type: "string" },
      "timeout-minutes": { type: "string" },
      "max-budget-usd": { type: "string" },
      "command-json": { type: "string" },
      clear: { type: "string", multiple: true },
      first: { type: "boolean", default: false },
    },
  });
  const [name, ...extra] = positionals;
  if (!name || extra.length > 0) throw new Error(`需要给出一个评审者名称\n${USAGE}`);

  const data = readRaw(file);
  const reviewers = Array.isArray(data.reviewers) ? data.reviewers : [];
  const index = reviewers.findIndex((item) => item?.name === name);
  const entry = index >= 0 ? { ...reviewers[index] } : { name };
  if (index < 0 && !values.client) throw new Error(`${name} 是新的评审者，必须用 --client 指明客户端\n${USAGE}`);

  for (const field of values.clear ?? []) {
    if (!CLEARABLE.includes(field)) throw new Error(`--clear 只能清 ${CLEARABLE.join("、")}，不认识 ${field}`);
    delete entry[field];
  }
  if (values.client !== undefined) entry.client = values.client;
  if (values.model !== undefined) entry.model = values.model;
  if (values["base-url"] !== undefined) entry.baseUrl = values["base-url"];
  if (values.effort !== undefined) entry.effort = values.effort;
  if (values["timeout-minutes"] !== undefined) entry.timeoutMinutes = Number(values["timeout-minutes"]);
  if (values["max-budget-usd"] !== undefined) entry.maxBudgetUsd = Number(values["max-budget-usd"]);
  if (values["command-json"] !== undefined) {
    try {
      entry.command = JSON.parse(values["command-json"]);
    } catch {
      throw new Error("--command-json 必须是 JSON 数组，例如 '[\"my-reviewer\",\"--json\"]'");
    }
  }
  if (values["api-key-stdin"]) {
    const key = readStdin().trim();
    if (!key) throw new Error("--api-key-stdin 没有从标准输入读到内容");
    entry.apiKey = key;
  }

  const next = reviewers.filter((_, at) => at !== index);
  if (values.first) next.unshift(entry);
  else next.splice(index >= 0 ? index : next.length, 0, entry);
  writeLocalReviewers({ ...data, reviewers: next }, { file });
  print(`${index >= 0 ? "已更新" : "已新增"}评审者 ${name}: ${describe(entry)}`);
  print(`文件: ${file}`);
  return 0;
}

function remove({ file, print, args }) {
  const [name] = args;
  if (!name) throw new Error(`需要给出要删除的评审者名称\n${USAGE}`);
  const data = readRaw(file);
  const reviewers = Array.isArray(data.reviewers) ? data.reviewers : [];
  if (!reviewers.some((item) => item?.name === name)) throw new Error(`本机文件里没有评审者 ${name}`);
  const next = reviewers.filter((item) => item?.name !== name);
  if (next.length === 0) {
    rmSync(file, { force: true });
    print(`已删除评审者 ${name}。它是最后一个，本机文件已移除，之后按项目配置里的旧字段运行`);
    return 0;
  }
  writeLocalReviewers({ ...data, reviewers: next }, { file });
  print(`已删除评审者 ${name}，还剩 ${next.map((item) => item.name).join("、")}`);
  return 0;
}

function prefer({ file, print, args }) {
  const [value] = args;
  if (!["on", "off"].includes(value)) throw new Error(`prefer 的参数是 on 或 off\n${USAGE}`);
  const data = readRaw(file);
  if (!existsSync(file)) throw new Error("本机评审者文件还不存在，先用 harness reviewer set 新增评审者");
  writeLocalReviewers({ ...data, preferDifferentModel: value === "on" }, { file });
  print(`已${value === "on" ? "开启" : "关闭"}优先使用与会话模型不同的评审者`);
  return 0;
}

function test({ file, print, args }) {
  const [name] = args;
  if (!name) throw new Error(`需要给出要测试的评审者名称\n${USAGE}`);
  const local = loadLocalReviewers({ file });
  const entry = local?.reviewers.find((item) => item.name === name);
  if (!entry) throw new Error(`本机文件里没有评审者 ${name}，harness reviewer list 可以查看`);
  print(`测试评审者 ${name}（${describe(entry)}），会产生少量费用……`);
  try {
    const result = probeReviewer(entry);
    print(`可用。耗时 ${(result.durationMs / 1000).toFixed(1)} 秒${result.models.length ? `，实际模型 ${result.models.join("、")}` : ""}${result.costUsd != null ? `，客户端估算花费 ${result.costUsd} 美元（第三方端点的花费以平台账单为准）` : ""}`);
    return 0;
  } catch (error) {
    print(`不可用: ${error.message}`);
    return 1;
  }
}

/** harness reviewer 命令。返回退出码；出错时抛 Error，由调用方打印。 */
export function reviewerCommand(argv, { print = console.log, readStdin = () => readFileSync(0, "utf8"), file = reviewersFile() } = {}) {
  const [action, ...args] = argv;
  switch (action) {
    case "list":
      return list({ file, print });
    case "set":
      return set({ file, print, readStdin, args });
    case "remove":
      return remove({ file, print, args });
    case "prefer":
      return prefer({ file, print, args });
    case "test":
      return test({ file, print, args });
    default:
      throw new Error(USAGE.trimEnd());
  }
}
