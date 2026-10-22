const cache = new Map();

export function globToRegExp(glob) {
  if (cache.has(glob)) return cache.get(glob);
  let out = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "{") {
      depth += 1;
      out += "(?:";
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      out += ")";
    } else if (ch === "," && depth > 0) {
      out += "|";
    } else if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (".+^$()|[]\\{}".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  if (depth !== 0) throw new Error(`glob 花括号不匹配: ${glob}`);
  const re = new RegExp(`^${out}$`);
  cache.set(glob, re);
  return re;
}

export function matchAny(path, globs = []) {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

export function matches(path, { match = [], exclude = [] } = {}) {
  return matchAny(path, match) && !matchAny(path, exclude);
}
