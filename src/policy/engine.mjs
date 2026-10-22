import { existsSync, readFileSync } from "node:fs";
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

export function evaluatePath({ policy, root, relPath, access, content, existingHeader }) {
  for (const rule of rulesOfKind(policy, access === "read" ? "read-protect" : "write-protect")) {
    if (matchAny(relPath, rule.paths ?? []) && !matchAny(relPath, rule.allow ?? [])) {
      return deny(rule, relPath);
    }
  }
  if (access === "write") {
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

function splitCommands(command) {
  const parts = [];
  let current = "";
  let quote = "";
  const flush = () => {
    if (current.trim()) parts.push(current.trim());
    current = "";
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
      if (command[i + 1] === ch) i += 1;
      flush();
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "(" || ch === ")" || ch === "`") {
      flush();
      continue;
    }
    if (ch === "{" && (i === 0 || /\s/.test(command[i - 1])) && /\s/.test(command[i + 1] ?? " ")) {
      flush();
      continue;
    }
    if (ch === "}" && /\s|;/.test(command[i - 1] ?? " ") && (i === command.length - 1 || /[\s;]/.test(command[i + 1]))) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return parts;
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

function ruleApplies(rule, context) {
  if (rule.when === "linked-worktree") return Boolean(context.linkedWorktree);
  if (rule.when === "main-worktree") return !context.linkedWorktree;
  if (rule.when === "on-main") return Boolean(context.onMainBranch);
  if (rule.when === "not-on-main") return !context.onMainBranch;
  return true;
}

function maskQuoted(text) {
  return text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
}

export function evaluateShell({ policy, command, context = {} }) {
  const segments = expandSegments(command);
  const whole = [{ raw: command, norm: command }];

  for (const rule of rulesOfKind(policy, "shell-forbid")) {
    if (!ruleApplies(rule, context)) continue;
    const targets = rule.scope === "whole" ? whole : segments;
    for (const target of targets) {
      for (const pattern of rule.patterns ?? []) {
        const re = new RegExp(pattern);
        // 整串规则看原文；逐段规则忽略引号内文字，避免提交信息提到被禁命令时误拦。
        const hit =
          rule.scope === "whole"
            ? re.test(target.raw)
            : re.test(maskQuoted(target.raw)) || re.test(maskQuoted(target.norm));
        if (hit) return deny(rule, target.raw);
      }
    }
  }

  for (const rule of rulesOfKind(policy, "shell-secret-access")) {
    if (!ruleApplies(rule, context)) continue;
    const allowed = new Set(rule.allowVerbs ?? []);
    for (const target of segments) {
      const verb = verbOf(target.norm);
      if (allowed.has(verb) || allowed.has(verb.split(" ")[0])) continue;
      for (const pattern of rule.patterns ?? []) {
        if (new RegExp(pattern).test(target.raw)) return deny(rule, target.raw);
      }
    }
  }
  return { decision: "allow" };
}

function evaluateSearch({ policy, root, call }) {
  if (call.path) {
    const byPath = evaluatePath({ policy, root, relPath: toRelative(root, call.path), access: "read" });
    if (byPath.decision === "deny") return byPath;
  }
  const glob = String(call.glob ?? "");
  if (glob && /(^|[/*])\.env(?![\w.-]*example)|\.pem\b|\.key\b|id_rsa|credentials/.test(glob)) {
    const rule = rulesOfKind(policy, "read-protect")[0];
    if (rule) return deny(rule, `glob=${glob}`);
  }
  return { decision: "allow" };
}

/**
 * 统一入口：所有客户端先把调用归一为 call，再交给这里判定。
 * call.kind 取 shell / write / read / search，客户端差异只留在适配器里。
 */
export function evaluateCall({ policy, root, call, context = {} }) {
  switch (call.kind) {
    case "shell":
      return evaluateShell({ policy, command: String(call.command ?? ""), context });
    case "write":
      return evaluatePath({
        policy,
        root,
        relPath: toRelative(root, call.path),
        access: "write",
        content: typeof call.content === "string" ? call.content : undefined,
      });
    case "read":
      return evaluatePath({ policy, root, relPath: toRelative(root, call.path), access: "read" });
    case "search":
      return evaluateSearch({ policy, root, call });
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
