import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { matchAny } from "../lib/glob.mjs";

const WRAPPERS = new Set([
  "sudo",
  "xargs",
  "env",
  "time",
  "nohup",
  "command",
  "exec",
  "nice",
  "ionice",
  "timeout",
]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const MAX_NESTING = 3;

export function toRelative(root, filePath) {
  if (!filePath) return "";
  const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  const rel = relative(root, abs);
  return rel.startsWith("..") ? abs : rel.split("\\").join("/");
}

export function readGeneratedHeader(root, rel, patterns) {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) return null;
  let head = "";
  try {
    head = readFileSync(abs, "utf8").slice(0, 1024);
  } catch {
    return null;
  }
  return patterns.find((pattern) => new RegExp(pattern).test(head)) ?? null;
}

function deny(rule, detail) {
  return {
    decision: "deny",
    rule: rule.id,
    reason: rule.reason,
    fix: rule.fix,
    detail,
  };
}

function rulesOfKind(policy, kind) {
  return (policy.rules ?? []).filter((rule) => rule.kind === kind);
}

export function evaluatePath({ policy, root, relPath, access, content, existingHeader, context = {}, viaShell = false }) {
  for (const rule of rulesOfKind(policy, access === "read" ? "read-protect" : "write-protect")) {
    // 命令写文件只适用声明了 includeShell 的规则，其余写保护规则的语义仍只针对写文件类工具。
    if (viaShell && !rule.includeShell) continue;
    if (!ruleApplies(rule, context)) continue;
    // 主 Worktree 是否洁净只看 git 能看到的文件；被忽略的本机文件不影响合并，按规则声明放行。
    if (rule.allowIgnored && context.ignored) continue;
    if (matchAny(relPath, rule.paths ?? []) && !matchAny(relPath, rule.allow ?? [])) {
      return deny(rule, relPath);
    }
  }
  if (access === "write" && !viaShell) {
    for (const rule of rulesOfKind(policy, "generated-header")) {
      if (!matchAny(relPath, rule.paths ?? [])) continue;
      const header = existingHeader ?? readGeneratedHeader(root, relPath, rule.headerPatterns ?? []);
      if (header) return deny(rule, relPath);
    }
    if (typeof content === "string") {
      for (const rule of rulesOfKind(policy, "content-forbid")) {
        if (!matchAny(relPath, rule.paths ?? [])) continue;
        for (const pattern of rule.patterns ?? []) {
          if (new RegExp(pattern, "i").test(content)) return deny(rule, `${relPath}: ${pattern}`);
        }
      }
    }
  }
  return { decision: "allow" };
}

/** 按 shell 分隔符切开命令，命令段与分隔符按出现顺序交替给出：{ seg } 或 { op }。 */
function tokenizeCommand(command) {
  const items = [];
  let current = "";
  let quote = "";
  const flush = (op) => {
    if (current.trim()) items.push({ seg: current.trim() });
    current = "";
    if (op) items.push({ op });
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote && command[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "&" || ch === "|") {
      const doubled = command[i + 1] === ch;
      if (doubled) i += 1;
      flush(doubled ? ch + ch : ch);
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "(" || ch === ")" || ch === "`") {
      flush(ch);
      continue;
    }
    if (ch === "{" && (i === 0 || /\s/.test(command[i - 1])) && /\s/.test(command[i + 1] ?? " ")) {
      flush(ch);
      continue;
    }
    if (ch === "}" && /\s|;/.test(command[i - 1] ?? " ") && (i === command.length - 1 || /[\s;]/.test(command[i + 1]))) {
      flush(ch);
      continue;
    }
    current += ch;
  }
  flush();
  return items;
}

function splitCommands(command) {
  return tokenizeCommand(command)
    .filter((item) => item.seg)
    .map((item) => item.seg);
}

function stripEnvAssignments(segment) {
  return segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
}

function stripGitGlobalOptions(segment) {
  return segment.replace(
    /\bgit\s+(?:(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+|--git-dir(?:=|\s+)\S+|--work-tree(?:=|\s+)\S+|--no-pager|-P|--no-optional-locks|--literal-pathspecs)\s+)+/g,
    "git ",
  );
}

function normalizeRm(segment) {
  const tokens = segment.split(/\s+/);
  let index = -1;
  if (tokens[0] === "rm") index = 0;
  else if (WRAPPERS.has(tokens[0])) index = tokens.slice(0, 12).indexOf("rm");
  if (index < 0) return segment;
  const rest = tokens.slice(index + 1);
  for (const arg of rest) {
    if (arg === "--") break;
    if (arg === "--recursive" || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(arg)) return `rm -r ${rest.join(" ")}`;
  }
  return segment;
}

export function normalizeSegment(segment) {
  return normalizeRm(stripGitGlobalOptions(stripEnvAssignments(segment.trim())));
}

function verbOf(normalized) {
  const tokens = normalized.split(/\s+/);
  let i = 0;
  while (i < tokens.length && (WRAPPERS.has(tokens[i]) || tokens[i].startsWith("-"))) i += 1;
  const first = (tokens[i] ?? "").split("/").pop();
  return first === "git" && tokens[i + 1] ? `git ${tokens[i + 1]}` : first;
}

function nestedCommands(segment) {
  const out = [];
  const shell = segment.match(/^(?:[A-Za-z_]\w*=\S*\s+)*(\S+)\s+(?:-\S+\s+)*-\w*c\w*\s+(["'])([\s\S]*)\2\s*$/);
  if (shell && SHELLS.has(shell[1].split("/").pop())) out.push(shell[3]);
  const evaluated = segment.match(/^eval\s+(["'])([\s\S]*)\1\s*$/);
  if (evaluated) out.push(evaluated[2]);
  for (const sub of segment.matchAll(/\$\(([^()]*)\)/g)) out.push(sub[1]);
  return out;
}

export function expandSegments(command, depth = 0) {
  const result = [];
  for (const raw of splitCommands(command)) {
    result.push({ raw, norm: normalizeSegment(raw) });
    if (depth < MAX_NESTING) {
      for (const inner of nestedCommands(raw)) result.push(...expandSegments(inner, depth + 1));
    }
  }
  return result;
}

// 一个词能否静态确定成路径：变量、命令替换、通配符、cd - 与 ~user 都不能，返回 null。
function literalWord(word) {
  if (/^'[^']*'$/.test(word)) return word.slice(1, -1);
  if (/^"(?:[^"\\]|\\.)*"$/.test(word)) {
    const inner = word.slice(1, -1);
    return /[$`\\]/.test(inner) ? null : inner;
  }
  if (/[$`\\*?[\]{}"'!]/.test(word) || word === "-" || /^~[^/]/.test(word)) return null;
  return word.replace(/^~(?=\/|$)/, homedir());
}

function resolveDir(base, word) {
  const text = literalWord(word);
  if (text === null) return null;
  if (isAbsolute(text)) return resolve(text);
  return base === null ? null : resolve(base, text);
}

const WORD = /"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g;
const CONTROL_PREFIX = /^(?:(?:if|then|else|elif|do|while|until|!|time|builtin|command)\s+)+/;

/** cd 类命令改到哪个目录：不是 cd 返回 undefined，目录无法确定返回 null。 */
function cdTarget(norm, dir) {
  const match = norm.replace(CONTROL_PREFIX, "").match(/^(cd|pushd|popd)(?:\s+(.*))?$/);
  if (!match) return undefined;
  if (match[1] === "popd") return null;
  const words = (match[2] ?? "").match(WORD) ?? [];
  while (/^-[LPe@]+$|^--$/.test(words[0] ?? "")) words.shift();
  if (words.length === 0) return match[1] === "cd" ? homedir() : null;
  if (words.length > 1) return null;
  return resolveDir(dir, words[0]);
}

const GIT_GLOBAL_OPTIONS =
  /\bgit\s+((?:(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+|--git-dir(?:=|\s+)\S+|--work-tree(?:=|\s+)\S+|--no-pager|-P|--no-optional-locks|--literal-pathspecs)\s+)+)/;

/** git 命令实际作用的目录：-C 依次叠加；--git-dir、--work-tree 与 GIT_DIR 之类的环境变量让目录无法确定。 */
function gitDirOf(raw, dir) {
  if (/(?:^|\s)GIT_(?:DIR|WORK_TREE)=/.test(raw)) return null;
  const options = raw.match(GIT_GLOBAL_OPTIONS);
  if (!options) return dir;
  if (/--git-dir|--work-tree/.test(options[1])) return null;
  let current = dir;
  for (const option of options[1].matchAll(/-C\s+("[^"]*"|'[^']*'|\S+)/g)) current = resolveDir(current, option[1]);
  return current;
}

/**
 * 逐段标出命令实际在哪个目录执行（null 表示无法静态确定）。
 * cd 改变同一 shell 里后续段的目录；括号子 shell、反引号、bash -c、eval 与 $() 里的 cd 不外溢；
 * 管道或后台执行的 cd 是否生效取决于 shell，之后的目录记为无法确定。
 */
export function locateSegments(command, start, depth = 0) {
  const items = tokenizeCommand(command);
  const result = [];
  const stack = [];
  let dir = start;
  let inBacktick = false;
  for (let i = 0; i < items.length; i++) {
    const { seg, op } = items[i];
    if (op === "(" || (op === "`" && !inBacktick)) stack.push(dir);
    if ((op === ")" || (op === "`" && inBacktick)) && stack.length) dir = stack.pop();
    if (op === "`") inBacktick = !inBacktick;
    if (!seg) continue;
    const norm = normalizeSegment(seg);
    const at = gitDirOf(seg, dir);
    result.push({ raw: seg, norm, dir: at });
    if (depth < MAX_NESTING) {
      for (const inner of nestedCommands(seg)) result.push(...locateSegments(inner, at, depth + 1));
    }
    const target = cdTarget(norm, dir);
    if (target === undefined) continue;
    const detached = ["|", "&"].includes(items[i - 1]?.op) || ["|", "&"].includes(items[i + 1]?.op);
    dir = detached ? null : target;
  }
  return result;
}

export function ruleApplies(rule, context) {
  if (!rule.when) return true;
  // 无法确定在哪个 Worktree 执行时按最严格处理：所有带条件的规则都适用。
  if (context.unknownPlace) return true;
  // 落在本仓库所有 Worktree 之外（用户目录、/tmp、别的仓库）时，按 Worktree 与分支区分的规则都不适用。
  if (context.outsideRepo) return false;
  if (rule.when === "linked-worktree") return Boolean(context.linkedWorktree);
  if (rule.when === "main-worktree") return !context.linkedWorktree;
  if (rule.when === "on-main") return Boolean(context.onMainBranch);
  if (rule.when === "not-on-main") return !context.onMainBranch;
  if (rule.when === "plan-pending") return Boolean(context.planPending);
  return true;
}

function maskQuoted(text) {
  return text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
}

const UNKNOWN_PLACE_NOTE =
  "无法确定这段命令在哪个目录执行，按最严格处理；cd 写成绝对路径，或用 git -C <绝对路径>";

/**
 * 给每段配上它执行时的上下文。没有 locate 时整条命令共用 context（黄金任务、check 按声明的位置判定）；
 * 有 locate 时从 cwd 出发推算每段的目录，交给 locate 换成那里的上下文，换不出来按无法确定处理。
 */
function segmentsWithContext(command, { context, cwd, locate }) {
  if (!locate || !cwd) return expandSegments(command).map((segment) => ({ ...segment, context }));
  const unknown = { ...context, unknownPlace: true };
  return locateSegments(command, cwd).map(({ dir, ...segment }) => ({
    ...segment,
    context: dir === cwd ? context : dir === null ? unknown : (locate(dir) ?? unknown),
  }));
}

export function evaluateShell({ policy, command, context = {}, cwd, locate }) {
  const segments = segmentsWithContext(command, { context, cwd, locate });
  const whole = [{ raw: command, norm: command, context }];

  for (const rule of rulesOfKind(policy, "shell-forbid")) {
    const applies = (target) => ruleApplies(rule, target.context);
    // 整串规则带条件时，只要有一段落在条件成立的位置就适用。
    const targets =
      rule.scope === "whole" ? (applies(whole[0]) || segments.some(applies) ? whole : []) : segments.filter(applies);
    // 规则只因为无法确定目录才适用时，说明原因，免得提示与实际所在的 Worktree 对不上。
    const known = (target) => !target.context.unknownPlace && applies(target);
    const unsure = (target) =>
      Boolean(rule.when) && (rule.scope === "whole" ? !known(whole[0]) && !segments.some(known) : target.context.unknownPlace);
    for (const target of targets) {
      for (const pattern of rule.patterns ?? []) {
        const re = new RegExp(pattern);
        // 整串规则看原文；逐段规则忽略引号内文字，避免提交信息提到被禁命令时误拦。
        const hit =
          rule.scope === "whole"
            ? re.test(target.raw)
            : re.test(maskQuoted(target.raw)) || re.test(maskQuoted(target.norm));
        if (hit) return deny(rule, unsure(target) ? `${target.raw}（${UNKNOWN_PLACE_NOTE}）` : target.raw);
      }
    }
  }

  for (const rule of rulesOfKind(policy, "shell-secret-access")) {
    const allowed = new Set(rule.allowVerbs ?? []);
    for (const target of segments) {
      if (!ruleApplies(rule, target.context)) continue;
      const verb = verbOf(target.norm);
      if (allowed.has(verb) || allowed.has(verb.split(" ")[0])) continue;
      for (const pattern of rule.patterns ?? []) {
        if (new RegExp(pattern).test(target.raw)) return deny(rule, target.raw);
      }
    }
  }
  return { decision: "allow" };
}

const INTERPRETERS = /^(?:python[\d.]*|pypy\d*|node(?:js)?|ruby|perl|php|deno|bun)$/;
const INLINE_FLAGS = /^(?:-[A-Za-z]*[ceEpr]|--eval|--print)$/;
// 复制、移动、建删文件一类命令的写入目标。
const WRITE_ALL_ARGS = new Set(["touch", "mkdir", "rmdir", "rm", "unlink", "truncate", "tee", "shred", "mkfifo", "mv"]);
const WRITE_LAST_ARG = new Set(["cp", "install", "ln", "rsync"]);
const WRITE_AFTER_MODE = new Set(["chmod", "chown", "chgrp"]);
const PATH_TOKEN = /(?:^|[\s"'=(,[])((?:~|\/)[^\s"'`;|&<>(),[\]]*)/g;
const MAX_PATH_TOKENS = 16;

/** 去掉 here-document 正文：正文是别的程序的输入，不是命令，里面的 > 与换行不能当成重定向或命令段。 */
function stripHeredocs(command) {
  const out = [];
  let tag = null;
  let dash = false;
  for (const line of command.split("\n")) {
    if (tag !== null) {
      if ((dash ? line.replace(/^\t+/, "") : line) === tag) tag = null;
      continue;
    }
    out.push(line);
    const match = line.match(/(?<!<)<<(?!<)(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_]\w*))/);
    if (match) {
      dash = match[1] === "-";
      tag = match[2] ?? match[3] ?? match[4];
    }
  }
  return out.join("\n");
}

/**
 * 一段命令里能静态认出的写入：重定向、常见写文件命令的目标，以及目标无法确定的解释器行内脚本。
 * 这只覆盖认得出来的写法，不是对任意程序写入的完整限制。
 */
function shellWrites(norm, wholeCommand) {
  const targets = [];
  const words = norm.match(WORD) ?? [];
  const argv = [];
  for (let i = 0; i < words.length; i++) {
    const redirect = words[i].match(/^(?:\d*|&)(>>|>\||>)(.*)$/);
    if (!redirect) {
      argv.push(words[i]);
      continue;
    }
    // >&2、2>&1 是复制文件描述符，不写文件。
    if (redirect[2].startsWith("&")) continue;
    if (redirect[2]) targets.push(redirect[2]);
    else if (words[i + 1] !== undefined) targets.push(words[++i]);
  }
  let i = 0;
  while (i < argv.length && (WRAPPERS.has(argv[i]) || argv[i].startsWith("-"))) i += 1;
  const verb = (argv[i] ?? "").split("/").pop();
  let args = argv.slice(i + 1);
  const options = (list) => list.filter((word) => word.startsWith("-") && word !== "-");
  const plain = (list) => list.filter((word) => !word.startsWith("-") || word === "-");
  const targetDir = args.findIndex((word) => word === "-t" || word.startsWith("--target-directory"));
  if (WRITE_ALL_ARGS.has(verb)) targets.push(...plain(args));
  else if (WRITE_AFTER_MODE.has(verb)) targets.push(...plain(args).slice(1));
  else if (WRITE_LAST_ARG.has(verb)) {
    if (targetDir >= 0) {
      const flag = args[targetDir];
      targets.push(flag.includes("=") ? flag.split("=").slice(1).join("=") : (args[targetDir + 1] ?? ""));
    } else targets.push(...plain(args).slice(-1));
  } else if (verb === "dd") {
    for (const arg of args) if (arg.startsWith("of=")) targets.push(arg.slice(3));
  } else if (verb === "sed" && options(args).some((arg) => /^-[A-Za-z]*i|^--in-place/.test(arg))) {
    let scripted = false;
    const files = [];
    for (let k = 0; k < args.length; k++) {
      if (["-e", "-f", "--expression", "--file"].includes(args[k])) {
        scripted = true;
        k += 1;
      } else if (/^--(?:expression|file)=/.test(args[k])) scripted = true;
      else if (!args[k].startsWith("-")) files.push(args[k]);
    }
    targets.push(...(scripted ? files : files.slice(1)));
  } else if (verb === "find" && args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(arg))) {
    const starts = [];
    for (const arg of args) {
      if (arg.startsWith("-") || arg === "(" || arg === "!") break;
      starts.push(arg);
    }
    targets.push(...(starts.length ? starts : ["."]));
  } else if (verb === "patch" || (verb === "git" && args[0] === "apply" && !args.some((arg) => /^--(?:check|stat|numstat|summary)$/.test(arg)))) {
    targets.push(".");
  }
  // 解释器带行内脚本（-c、-e、-、heredoc、管道喂入）：写到哪里取决于脚本内容，静态看不出来。
  let opaque = false;
  if (INTERPRETERS.test(verb)) {
    args = args.filter((word) => !word.startsWith("<"));
    const script = plain(args).filter((word) => word !== "-");
    const stdin = /<<|<<<|<\s*\S/.test(norm) || /\|/.test(wholeCommand);
    opaque =
      args.some((arg) => INLINE_FLAGS.test(arg) || arg === "-") ||
      /<<|<<</.test(norm) ||
      (script.length === 0 && stdin && !args.some((arg) => /^-(?:V|h|v|-version|-help)$/.test(arg)));
  }
  return { targets, opaque };
}

function absolutePathTokens(command) {
  const found = new Set();
  for (const match of command.matchAll(PATH_TOKEN)) {
    const text = match[1].replace(/^~(?=\/|$)/, homedir());
    if (text.length > 1) found.add(resolve(text));
    if (found.size >= MAX_PATH_TOKENS) break;
  }
  return [...found];
}

/**
 * 命令实际写到哪里：按写入目标所在的 Worktree 与路径判定，不看当前目录，也不看分支名。
 * 目标静态确定不了的写入，在会落进受保护位置的目录里按最严格处理；其余位置放行，这是静态检查的边界。
 * 解释器行内脚本在条件成立的目录里一律拒；在别处执行时，命令文本引用了受保护位置的绝对路径也拒。
 */
function evaluateShellWrites({ policy, command, context, cwd, locate, locateTarget }) {
  if (!locate || !locateTarget || !cwd) return { decision: "allow" };
  const rules = rulesOfKind(policy, "write-protect").filter((rule) => rule.includeShell);
  if (rules.length === 0) return { decision: "allow" };
  const unknown = { ...context, unknownPlace: true };
  const placeOf = (dir) => (dir === null ? unknown : dir === cwd ? context : (locate(dir) ?? unknown));
  let tokensChecked = null;
  for (const { raw, norm, dir } of locateSegments(stripHeredocs(command), cwd)) {
    const { targets, opaque } = shellWrites(norm, command);
    const here = placeOf(dir);
    const unsure = here.unknownPlace ? `（${UNKNOWN_PLACE_NOTE}）` : "";
    for (const rule of rules) {
      if (opaque) {
        if (ruleApplies(rule, here)) return deny(rule, `${raw}（解释器执行行内脚本，无法确定写入目标${unsure ? "，也" + UNKNOWN_PLACE_NOTE : ""}）`);
        tokensChecked ??= absolutePathTokens(command);
        for (const abs of tokensChecked) {
          const placed = locateTarget(abs);
          if (placed.outsideRepo) continue;
          const result = evaluatePath({ policy: { rules: [rule] }, root: placed.root, relPath: toRelative(placed.root, placed.path), access: "write", context: placed.context, viaShell: true });
          if (result.decision === "deny") return deny(rule, `${raw}（行内脚本无法确定写入目标，又引用了 ${abs}）`);
        }
      }
    }
    for (const word of targets) {
      const abs = dir === null ? (isAbsolute(literalWord(word) ?? "") ? resolve(literalWord(word)) : null) : resolveDir(dir, word);
      if (abs === null) {
        // 目标是变量、通配符或命令替换：只在会落进受保护位置的目录里拦。
        for (const rule of rules) {
          if (ruleApplies(rule, here)) return deny(rule, `${raw}（写入目标无法静态确定${unsure ? "，也" + UNKNOWN_PLACE_NOTE : ""}）`);
        }
        continue;
      }
      const placed = locateTarget(abs);
      if (placed.outsideRepo) continue;
      const result = evaluatePath({ policy, root: placed.root, relPath: toRelative(placed.root, placed.path), access: "write", context: placed.context, viaShell: true });
      if (result.decision === "deny") return { ...result, detail: `${raw}（写入 ${abs}）` };
    }
  }
  return { decision: "allow" };
}

/** 提交本身是否允许：由 git 的 pre-commit 调用，对所有客户端与人都生效。 */
export function evaluateCommit({ policy, context = {} }) {
  for (const rule of rulesOfKind(policy, "commit-forbid")) {
    if (!ruleApplies(rule, context)) continue;
    return deny(rule, context.branch ? `当前分支 ${context.branch}` : "");
  }
  return { decision: "allow" };
}

function evaluateSearch({ policy, root, call, context }) {
  if (call.path) {
    const byPath = evaluatePath({ policy, root, relPath: toRelative(root, call.path), access: "read", context });
    if (byPath.decision === "deny") return byPath;
  }
  // 搜索工具没给具体路径时按文件名特征认：只有私钥与凭据算密钥，开发环境的环境文件不拦。
  const glob = String(call.glob ?? "");
  if (glob && /\.pem\b|\.key\b|id_rsa|credentials/.test(glob)) {
    const rule = rulesOfKind(policy, "read-protect")[0];
    if (rule) return deny(rule, `glob=${glob}`);
  }
  return { decision: "allow" };
}

/**
 * 统一入口：所有客户端先把调用归一为 call，再交给这里判定。
 * call.kind 取 shell / write / read / search / commit，客户端差异只留在适配器里；commit 由 git 的 pre-commit 产生。
 */
export function evaluateCall({ policy, root, call, context = {}, cwd, locate, locateTarget }) {
  switch (call.kind) {
    case "shell": {
      const command = String(call.command ?? "");
      const forbidden = evaluateShell({ policy, command, context, cwd, locate });
      if (forbidden.decision === "deny") return forbidden;
      return evaluateShellWrites({ policy, command, context, cwd, locate, locateTarget });
    }
    case "write":
      return evaluatePath({
        policy,
        root,
        relPath: toRelative(root, call.path),
        access: "write",
        content: typeof call.content === "string" ? call.content : undefined,
        context,
      });
    case "read":
      return evaluatePath({ policy, root, relPath: toRelative(root, call.path), access: "read", context });
    case "search":
      return evaluateSearch({ policy, root, call, context });
    case "commit":
      return evaluateCommit({ policy, context });
    default:
      return { decision: "allow" };
  }
}

export function formatDenial(result, { client } = {}) {
  const lines = [`[harness] 已拦截: ${result.reason}`];
  if (result.detail) lines.push(`对象: ${result.detail}`);
  if (result.fix) lines.push(`正确做法: ${result.fix}`);
  lines.push(`规则: ${result.rule}`);
  if (client) lines.push(`客户端: ${client}`);
  return lines.join("\n");
}
