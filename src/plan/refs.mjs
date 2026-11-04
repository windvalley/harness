import { posix } from "node:path";
import { git } from "../lib/git.mjs";

export const MAX_REFS = 30;
export const MAX_SNIPPET_CHARS = 6000;
export const MAX_TOTAL_CHARS = 80_000;
const CONTEXT_BEFORE = 15;
const CONTEXT_AFTER = 45;
const WHOLE_FILE_MAX_LINES = 150;

const REF_PATTERN =
  /(?<![\w./-])((?:[\w.-]+\/)*[\w.-]+\.(?:go|mjs|cjs|js|ts|tsx|jsx|vue|py|sql|ya?ml|json|toml|sh|java|rs|md))(?:(?:#L|:)(\d+)(?:-L?(\d+))?)?(?![\w/])/g;

// 与评审者工具层的 Read 屏蔽规则保持一致，预取不能绕过它。
export function isSecretPath(path) {
  const name = path.split("/").pop();
  return /^\.env(\..*)?$/.test(name) || /\.(pem|key)$/.test(name) || name.startsWith("id_rsa") || name.startsWith("credentials");
}

// ./ 与 ../ 开头的相对链接按引用所在文件的目录解析，指到仓库外的丢弃。
function normalizeRef(path, fromFile) {
  if (!path.startsWith("./") && !path.startsWith("../")) return path;
  const resolved = posix.normalize(posix.join(posix.dirname(fromFile), path));
  return resolved.startsWith("../") ? null : resolved;
}

/** 从方案文件里取出 `路径`、`路径#L12`、`路径#L12-L30`、`路径:12` 形式的引用，保持出现顺序并去重；sources 为 [{ path, text }]。 */
export function extractRefs(sources) {
  const seen = new Set();
  const refs = [];
  for (const source of sources) {
    for (const match of source.text.matchAll(REF_PATTERN)) {
      const [, rawPath, from, to] = match;
      const path = normalizeRef(rawPath, source.path);
      if (!path) continue;
      const start = from ? Number(from) : null;
      const end = to ? Number(to) : start;
      const key = `${path}#${start ?? ""}-${end ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ path, start, end });
    }
  }
  return refs;
}

function resolvePath(ref, files, byName) {
  if (files.has(ref)) return ref;
  const candidates = (byName.get(ref.split("/").pop()) ?? []).filter((path) => path.endsWith(`/${ref}`));
  return candidates.length === 1 ? candidates[0] : null;
}

function snippetOf(text, ref) {
  const lines = text.replace(/\n$/, "").split("\n");
  if (ref.start === null) return lines.length <= WHOLE_FILE_MAX_LINES ? { from: 1, to: lines.length, body: lines.join("\n") } : null;
  if (ref.start > lines.length) return null;
  const from = Math.max(1, ref.start - CONTEXT_BEFORE);
  const to = Math.min(lines.length, Math.max(ref.end ?? ref.start, ref.start) + CONTEXT_AFTER);
  const body = lines.slice(from - 1, to).join("\n");
  return { from, to, body: body.length > MAX_SNIPPET_CHARS ? `${body.slice(0, MAX_SNIPPET_CHARS)}\n...(已截断)` : body };
}

/**
 * 按方案里的引用从分支提交取出现有代码片段，让评审者不必自己在仓库里翻找。
 * 只读提交里的文件，跳过密钥类路径、方案自身、不存在或有歧义的引用，总量有上限。
 */
export function prefetchRefs({ root, commit, sources, excludePaths = [] }) {
  const listing = git(root, ["ls-tree", "-r", "--name-only", commit]);
  if (listing.status !== 0) return [];
  const files = new Set(listing.stdout.split("\n").filter(Boolean));
  const byName = new Map();
  for (const path of files) {
    const name = path.split("/").pop();
    byName.set(name, [...(byName.get(name) ?? []), path]);
  }
  const snippets = [];
  const cache = new Map();
  let total = 0;
  for (const ref of extractRefs(sources)) {
    if (snippets.length >= MAX_REFS) break;
    const path = resolvePath(ref.path, files, byName);
    if (!path || excludePaths.includes(path) || isSecretPath(path)) continue;
    if (!cache.has(path)) {
      const shown = git(root, ["show", `${commit}:${path}`]);
      cache.set(path, shown.status === 0 && !shown.stdout.includes("\0") ? shown.stdout : null);
    }
    const text = cache.get(path);
    if (text === null) continue;
    const snippet = snippetOf(text, ref);
    if (!snippet || total + snippet.body.length > MAX_TOTAL_CHARS) continue;
    total += snippet.body.length;
    snippets.push({ path, from: snippet.from, to: snippet.to, body: snippet.body });
  }
  return snippets;
}
