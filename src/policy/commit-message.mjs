import { mainBranch } from "../lib/config.mjs";
import { gitOk, showBlob } from "../lib/git.mjs";
import { resolvePolicy } from "./resolve.mjs";

// 提交信息规范只在 policy.json 的 commit-message 规则里定义；钩子、verify 与 review 的前置检查、status 和合并都调用这里的判定。
export const COMMIT_MESSAGE_KIND = "commit-message";

// 没写 forbidPatterns 时的默认禁用内容：智能体署名不进提交信息。
const DEFAULT_FORBID = ["^Co-Authored-By:", "^Co-authored-by:"];
// git revert 生成的标题是 Revert "<原标题>"，不是人写的；fixup!、squash! 会随分支原样进入主分支，照常检查。
const DEFAULT_IGNORE = ['^Revert "'];
const DEFAULT_MAX_HEADER = 72;
const HAN = /\p{Script=Han}/u;
const LATIN = /[A-Za-z]/;
const CODE_SPAN = /`[^`]*`/g;
const URL = /[a-z][a-z0-9+.-]*:\/\/\S/i;
const CONVENTIONAL = /^([A-Za-z]+)(?:\(([^)]*)\))?!?: (.+)$/;

// 规则里出现任一结构化字段就按结构化判定，没写的字段取默认值；只写 pattern 与 forbidPatterns 时按旧写法判定。
const STRUCTURED_FIELDS = ["lang", "langScope", "allowLatinTerms", "types", "header", "body", "ignore", "ignoreAuthors", "example"];

export function findCommitRule(resolved) {
  return (resolved?.rules ?? []).find((rule) => rule.kind === COMMIT_MESSAGE_KIND) ?? null;
}

export function isStructuredRule(rule) {
  return Boolean(rule) && STRUCTURED_FIELDS.some((field) => rule[field] !== undefined);
}

/** config.json 里还留着的旧字段；结构化规则与它们并存时判定会有两份来源。 */
export function legacyConfigFields(config) {
  const merge = config?.merge ?? {};
  return ["commitMessagePattern", "forbidMessagePatterns"].filter((name) => merge[name] !== undefined).map((name) => `merge.${name}`);
}

/** 规范化提交信息：统一换行、去掉行尾空白、合并连续空行、去掉首尾空行。 */
export function normalizeMessage(text) {
  const out = [];
  for (const line of String(text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const cleaned = line.replace(/\s+$/, "");
    if (cleaned === "" && (out.length === 0 || out.at(-1) === "")) continue;
    out.push(cleaned);
  }
  while (out.length > 0 && out.at(-1) === "") out.pop();
  return out.join("\n");
}

function nonNegativeInt(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负整数，当前是 ${JSON.stringify(value)}`);
  return value;
}

function stringList(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} 必须是字符串数组`);
  return value;
}

// 正则在得出判定时就编译一遍：写错的规则在 doctor 与 status 里就能看到，不等到提交时才报。
function regexList(list, label, flags = "") {
  for (const pattern of list) {
    if (typeof pattern !== "string") throw new Error(`${label} 里的正则必须是字符串，当前是 ${JSON.stringify(pattern)}`);
    try {
      new RegExp(pattern, flags);
    } catch (error) {
      throw new Error(`${label} 里的正则无效 ${JSON.stringify(pattern)}: ${error.message}`);
    }
  }
  return list;
}

function optionalRegex(value, label) {
  if (value === undefined || value === null) return null;
  return regexList([value], label)[0];
}

function section(value, label) {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value;
}

function oneOf(value, fallback, allowed, label) {
  const result = value ?? fallback;
  if (!allowed.includes(result)) throw new Error(`${label} 只能是 ${allowed.join("、")}，当前是 ${JSON.stringify(value)}`);
  return result;
}

function legacySpec(rule, patterns, forbid) {
  const label = "提交信息规则";
  return {
    mode: "legacy",
    rule,
    patterns: regexList(patterns, label),
    forbid: regexList([...new Set(forbid)], label, "im"),
    ignore: [],
    ignoreAuthors: [],
    example: null,
  };
}

/**
 * 得出这个项目实际生效的一份提交信息判定；没有任何要求时返回 null。
 * 旧写法里钩子只看 policy 规则、合并只看 config 字段，这里两处取并集：交付结果不变，只是拒绝提前到提交当场。
 */
export function resolveCommitRule({ resolved, config = {} } = {}) {
  const rule = findCommitRule(resolved);
  const merge = config?.merge ?? {};
  // 合并原来在 forbidMessagePatterns 没写时也禁用署名行，保持这个默认。
  const legacyForbid = merge.forbidMessagePatterns ?? DEFAULT_FORBID;
  if (!rule) {
    const patterns = merge.commitMessagePattern ? [merge.commitMessagePattern] : [];
    if (patterns.length === 0 && legacyForbid.length === 0) return null;
    return legacySpec({ id: COMMIT_MESSAGE_KIND, reason: "提交信息必须符合项目提交规范", fix: "按项目提交规范改写提交信息" }, patterns, legacyForbid);
  }
  if (!isStructuredRule(rule)) {
    return legacySpec(rule, [rule.pattern, merge.commitMessagePattern].filter(Boolean), [...(rule.forbidPatterns ?? []), ...legacyForbid]);
  }

  // 两份定义不能并存：结构化规则与 config.json 的旧字段同时存在时直接报错，不替人挑其中一份。
  const legacy = legacyConfigFields(config);
  if (legacy.length > 0) {
    throw new Error(
      `提交信息规范同时写在两处：.harness/policy.json 的 ${rule.id} 用了结构化字段，.harness/config.json 还留着 ${legacy.join("、")}。` +
        "删掉 config.json 里的旧字段，只在 policy.json 里维护这一条规则",
    );
  }
  const label = (field) => `.harness/policy.json 的 ${rule.id}.${field}`;
  const header = section(rule.header, label("header"));
  const body = section(rule.body, label("body"));
  return {
    mode: "structured",
    rule,
    patterns: rule.pattern ? regexList([rule.pattern], label("pattern")) : [],
    forbid: regexList(stringList(rule.forbidPatterns, DEFAULT_FORBID, label("forbidPatterns")), label("forbidPatterns"), "im"),
    ignore: regexList(stringList(rule.ignore, DEFAULT_IGNORE, label("ignore")), label("ignore")),
    ignoreAuthors: regexList(stringList(rule.ignoreAuthors, [], label("ignoreAuthors")), label("ignoreAuthors")),
    example: typeof rule.example === "string" && rule.example ? rule.example : null,
    lang: oneOf(rule.lang, "any", ["any", "zh", "en"], label("lang")),
    langScope: oneOf(rule.langScope, "subject", ["subject", "all"], label("langScope")),
    allowLatinTerms: rule.allowLatinTerms !== false,
    types: stringList(rule.types, [], label("types")),
    headerPattern: optionalRegex(header.pattern, label("header.pattern")),
    maxHeader: nonNegativeInt(header.maxLength, DEFAULT_MAX_HEADER, label("header.maxLength")),
    headerFullStop: header.noTrailingPeriod !== false,
    bodyRequired: body.required === true,
    bodyLeadingBlank: body.leadingBlank !== false,
    bodyBullets: body.bullets === true,
    bodyPattern: optionalRegex(body.pattern, label("body.pattern")),
    bodyMaxLine: nonNegativeInt(body.maxLineLength, 0, label("body.maxLineLength")),
  };
}

function matches(pattern, text, flags = "") {
  return new RegExp(pattern, flags).test(text);
}

// 按 Unicode 字符计数，一个汉字算一个字符。
function charCount(text) {
  return [...text].length;
}

/** 标题匹配 ignore、作者（姓名 <邮箱>）匹配 ignoreAuthors 的提交不检查格式。真正的合并提交由调用方排除。 */
export function isIgnored({ spec, message, author = "" }) {
  const header = normalizeMessage(message).split("\n")[0] ?? "";
  return spec.ignore.some((pattern) => matches(pattern, header)) || (author !== "" && spec.ignoreAuthors.some((pattern) => matches(pattern, author)));
}

// 语言只看描述（类型前缀天然是英文），langScope 为 all 时正文也看；反引号里的代码、路径与命令不参与判定。
function languageProblems(spec, description, body) {
  if (spec.lang === "any") return [];
  const parts = [["描述", description.replace(CODE_SPAN, "")]];
  if (spec.langScope === "all" && body.length > 0) parts.push(["正文", body.join("\n").replace(CODE_SPAN, "")]);
  const problems = [];
  for (const [part, text] of parts) {
    if (spec.lang === "zh" && !HAN.test(text)) problems.push(`${part}要用中文：没有找到汉字`);
    if (spec.lang === "en" && HAN.test(text)) problems.push(`${part}要用英文：出现了汉字`);
  }
  if (spec.lang === "zh" && !spec.allowLatinTerms && LATIN.test(parts[0][1])) {
    problems.push("描述要用纯中文：出现了英文字母；允许夹杂英文术语时把 allowLatinTerms 设为 true");
  }
  return problems;
}

function structuredProblems(spec, header, rest) {
  const problems = [];
  const conventional = CONVENTIONAL.exec(header);
  if (spec.types.length > 0) {
    if (!conventional) problems.push(`标题要写成“类型(范围): 描述”或“类型: 描述”，类型取 ${spec.types.join("、")}`);
    else if (!spec.types.includes(conventional[1])) problems.push(`类型 ${conventional[1]} 不在允许的范围内（${spec.types.join("、")}）`);
  }
  if (spec.headerPattern && !matches(spec.headerPattern, header)) problems.push(`标题不符合格式 ${spec.headerPattern}`);
  if (spec.maxHeader > 0 && charCount(header) > spec.maxHeader) problems.push(`标题超过 ${spec.maxHeader} 个字符（实际 ${charCount(header)} 个）`);
  if (spec.headerFullStop && /[.。]$/.test(header)) problems.push("标题结尾不要用句号");

  // normalizeMessage 已去掉末尾空行，rest 不为空就说明有正文。
  const body = rest[0] === "" ? rest.slice(1) : rest;
  problems.push(...languageProblems(spec, conventional ? conventional[3] : header, body));
  if (body.length === 0) {
    if (spec.bodyRequired) problems.push("要有正文：空一行后写清改了什么");
    return problems;
  }
  if (spec.bodyLeadingBlank && rest[0] !== "") problems.push("标题与正文之间要空一行");
  if (spec.bodyBullets && body.some((line) => !/^- .+/.test(line))) problems.push("正文每行都要是“- ”开头的要点，要点之间不空行");
  if (spec.bodyPattern && !matches(spec.bodyPattern, body.join("\n"))) problems.push(`正文不符合格式 ${spec.bodyPattern}`);
  if (spec.bodyMaxLine > 0) {
    // 网址常常放不进一行，含网址的行不计。
    const long = body.filter((line) => !URL.test(line) && charCount(line) > spec.bodyMaxLine);
    if (long.length > 0) problems.push(`正文有 ${long.length} 行超过 ${spec.bodyMaxLine} 个字符，第一行是：${[...long[0]].slice(0, 30).join("")}…`);
  }
  return problems;
}

/** 判定一条提交信息，返回问题列表；空数组表示通过。 */
export function messageProblems({ spec, message, author = "" }) {
  if (!spec) return [];
  const text = normalizeMessage(message);
  const problems = [];
  // ignore 只豁免格式要求；禁用内容（例如署名行）对所有提交都适用。
  if (!isIgnored({ spec, message: text, author })) {
    const [header = "", ...rest] = text.split("\n");
    for (const pattern of spec.patterns) {
      if (!matches(pattern, text)) problems.push(`不符合格式 ${pattern}`);
    }
    if (spec.mode === "structured") problems.push(...structuredProblems(spec, header, rest));
  }
  for (const pattern of spec.forbid) {
    if (matches(pattern, text, "im")) problems.push(`包含不允许的内容 ${pattern}`);
  }
  return [...new Set(problems)];
}

/** 被拒时展示的说明：逐条列出问题，有示例时附上示例。 */
export function describeProblems(spec, problems) {
  const lines = problems.map((item) => `  - ${item}`);
  if (spec?.example) lines.push("  示例:", ...spec.example.split("\n").map((line) => `    ${line}`));
  return lines;
}

/**
 * 分支上每个非合并提交的问题，每个有问题的提交一行。
 * 一次 git log 取出全部提交，不逐个起进程。
 */
export function commitRangeProblems({ root, resolved, config, baseCommit, branchCommit }) {
  const spec = resolveCommitRule({ resolved, config });
  if (!spec) return [];
  const END = "\x1e";
  const raw = gitOk(root, ["log", "--reverse", "--no-merges", `--format=%h%n%an <%ae>%n%B${END}`, `${baseCommit}..${branchCommit}`]);
  const bad = [];
  for (const entry of raw.split(END)) {
    const text = entry.replace(/^\n+/, "").trimEnd();
    if (!text) continue;
    const [sha, author, ...rest] = text.split("\n");
    const message = rest.join("\n");
    const problems = messageProblems({ spec, message, author });
    if (problems.length > 0) bad.push(`${sha.trim()} ${normalizeMessage(message).split("\n")[0] ?? ""}：${problems.join("；")}`);
  }
  return bad;
}

/**
 * 某个提交里的提交信息规则能不能用：返回错误说明，能用或没有配置时返回 null。
 * 写错或与旧字段并存的规则一旦进了主分支，钩子会拒绝所有提交，连修复它的分支也合不进来，所以在它进主分支之前就拦下。
 */
export function commitRuleErrorAt(root, ref) {
  const read = (name) => {
    const blob = showBlob(root, ref, `.harness/${name}`);
    if (blob === null) return null;
    try {
      return JSON.parse(blob);
    } catch (error) {
      throw new Error(`.harness/${name} 不是合法的 JSON: ${error.message}`);
    }
  };
  try {
    const policy = read("policy.json");
    if (!policy) return null;
    resolveCommitRule({ resolved: resolvePolicy(policy), config: read("config.json") ?? {} });
    return null;
  } catch (error) {
    return error.message;
  }
}

/** verify、review 动手之前用：按项目配置判定分支相对主分支的全部提交。 */
export function branchMessageProblems({ project, root, branch }) {
  const head = gitOk(root, ["rev-parse", "--verify", `${branch}^{commit}`]);
  const base = gitOk(root, ["merge-base", mainBranch(project), head]);
  return commitRangeProblems({ root, resolved: resolvePolicy(project.policy), config: project.config, baseCommit: base, branchCommit: head });
}
