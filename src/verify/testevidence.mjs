import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { matches } from "../lib/glob.mjs";
import { git, gitOk } from "../lib/git.mjs";

export const TDD_ID = "harness:tdd-red";
export const COVERAGE_ID = "harness:changed-line-coverage";
const MODES = ["enforce", "observe"];
const DEFAULT_THRESHOLD = 80;

const isGlobList = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
const isRule = (rule) => Boolean(rule) && typeof rule === "object" && !Array.isArray(rule) && isGlobList(rule.match) && (rule.exclude === undefined || isGlobList(rule.exclude));
const isCmd = (cmd) => Array.isArray(cmd) && cmd.length > 0 && cmd.every((part) => typeof part === "string" && part !== "");
const posix = (path) => path.split(sep).join("/");

function sectionProblem(id, name, section, { rules, example, extra }) {
  if (section === undefined || section === null) return null;
  const bad = (reason) => ({ id, reason: `${name}：${reason}`, fix: example });
  if (typeof section !== "object" || Array.isArray(section)) return bad("必须是对象");
  if (section.mode !== undefined && !MODES.includes(section.mode)) return bad('mode 只能是 "enforce" 或 "observe"');
  for (const key of rules) {
    if (!isRule(section[key])) return bad(`${key} 必须是 { match: [glob...], exclude: [glob...] } 形式`);
  }
  if (!isCmd(section.cmd)) return bad("cmd 必须是非空的参数数组");
  if (section.cwd !== undefined && typeof section.cwd !== "string") return bad("cwd 必须是字符串");
  if (section.requires !== undefined && !isGlobList(section.requires)) return bad("requires 必须是字符串数组");
  return extra?.(section, bad) ?? null;
}

const TDD_EXAMPLE =
  '写成 "testFirst": { "source": { "match": ["src/**"], "exclude": [] }, "tests": { "match": ["**/*.test.ts"], "exclude": [] }, "cmd": ["pnpm", "exec", "vitest", "run", "{tests}"] }';
const COVERAGE_EXAMPLE =
  '写成 "coverage": { "include": { "match": ["src/**"], "exclude": [] }, "cmd": ["pnpm", "exec", "vitest", "run", "--coverage"], "report": "coverage/lcov.info", "threshold": 80 }';

/** testFirst 与 coverage 写错时按配置错误处理，不能因为“没配置”而静默失效。 */
export function testEvidenceProblems(verify) {
  return [
    sectionProblem(TDD_ID, "testFirst", verify?.testFirst, { rules: ["source", "tests"], example: TDD_EXAMPLE }),
    sectionProblem(COVERAGE_ID, "coverage", verify?.coverage, {
      rules: ["include"],
      example: COVERAGE_EXAMPLE,
      extra: (section, bad) => {
        if (typeof section.report !== "string" || section.report === "") return bad("report 必须是覆盖率报告相对 cwd 的路径");
        if (section.threshold !== undefined && !(typeof section.threshold === "number" && section.threshold >= 0 && section.threshold <= 100)) {
          return bad("threshold 必须是 0 到 100 的数字");
        }
        if (section.when !== undefined && !isGlobList(section.when)) return bad("when 必须是 glob 数组");
        return null;
      },
    }),
  ].filter(Boolean);
}

/**
 * 配置好的测试证据项，形状与普通检查一致（id、when、cmd、requires），
 * 这样证据复用与合并前的环境判断沿用检查的同一套逻辑。配置写错的不在其中，由 testEvidenceProblems 报告。
 */
export function testEvidenceChecks(verify) {
  const items = [];
  const bad = new Set(testEvidenceProblems(verify).map((problem) => problem.id));
  const tdd = verify?.testFirst;
  if (tdd && !bad.has(TDD_ID)) {
    items.push({ id: TDD_ID, kind: "tdd", config: tdd, when: [...tdd.source.match, ...tdd.tests.match], cmd: tdd.cmd, cwd: tdd.cwd ?? ".", requires: tdd.requires ?? [] });
  }
  const cov = verify?.coverage;
  if (cov && !bad.has(COVERAGE_ID)) {
    items.push({ id: COVERAGE_ID, kind: "coverage", config: cov, when: cov.when ?? cov.include.match, cmd: cov.cmd, cwd: cov.cwd ?? ".", requires: cov.requires ?? [] });
  }
  return items;
}

/** 提交信息里的 `Tdd-Waiver: 原因`（可带 "- " 前缀以符合列表式正文），返回原因，没有则 null。 */
export function tddWaiver(root, base, head) {
  const log = git(root, ["log", "--format=%B%x00", `${base}..${head}`]);
  if (log.status !== 0) return null;
  const reasons = [];
  for (const message of log.stdout.split("\0")) {
    for (const line of message.split("\n")) {
      const found = /^(?:-\s+)?Tdd-Waiver:\s*(\S.*)$/i.exec(line.trim());
      if (found) reasons.push(found[1].trim());
    }
  }
  return reasons.length > 0 ? reasons.join("；") : null;
}

/** 相对 base 在 head 一侧新增或修改的行号，按文件分组；只含 paths 里的文件。 */
export function addedLines(root, base, head, paths) {
  const out = new Map();
  if (paths.length === 0) return out;
  const diff = git(root, ["-c", "core.quotepath=false", "diff", "-U0", "--no-renames", "--no-color", base, head, "--", ...paths]);
  if (diff.status !== 0) throw new Error(`git diff 失败: ${diff.stderr.trim()}`);
  let file = null;
  let inHunks = false;
  for (const line of diff.stdout.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
      inHunks = false;
    } else if (!inHunks && line.startsWith("+++ ")) {
      const name = line.slice(4).replace(/\t.*$/, "");
      file = name === "/dev/null" ? null : name.replace(/^b\//, "");
      if (file) out.set(file, new Set());
    } else {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hunk) continue;
      inHunks = true;
      if (!file) continue;
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let i = 0; i < count; i += 1) out.get(file).add(start + i);
    }
  }
  return out;
}

function bump(files, name, line, hits) {
  const lines = files.get(name) ?? new Map();
  lines.set(line, Math.max(lines.get(line) ?? 0, hits));
  files.set(name, lines);
}

/** 解析 lcov（js、python、rust 等工具都能产出）或 Go 的 coverprofile，得到 文件名 -> (行号 -> 命中次数)。 */
export function parseCoverage(text) {
  const files = new Map();
  if (/^mode:\s*\w+/.test(text)) {
    for (const line of text.split("\n")) {
      const block = /^(.+):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/.exec(line.trim());
      if (!block) continue;
      for (let at = Number(block[2]); at <= Number(block[3]); at += 1) bump(files, block[1], at, Number(block[4]));
    }
    return { format: "go", files };
  }
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) current = line.slice(3);
    else if (line === "end_of_record") current = null;
    else if (current && line.startsWith("DA:")) {
      const [at, hits] = line.slice(3).split(",");
      if (Number.isInteger(Number(at)) && Number.isFinite(Number(hits))) bump(files, current, Number(at), Number(hits));
    }
  }
  return { format: "lcov", files };
}

function goModuleAbove(dir, stop) {
  for (let current = dir; ; current = dirname(current)) {
    const mod = join(current, "go.mod");
    if (existsSync(mod)) {
      const found = /^module\s+(\S+)/m.exec(readFileSync(mod, "utf8"));
      if (found) return { dir: current, module: found[1] };
    }
    if (current === stop || current === dirname(current)) return null;
  }
}

/** 把报告里的文件名换成相对仓库根的路径：lcov 的相对路径相对命令的 cwd，Go 的相对 go.mod 所在目录。 */
export function normalizeCoverage(parsed, { checkout, cwdAbs }) {
  const roots = [...new Set([checkout, realpathSync(checkout)])];
  const goModule = parsed.format === "go" ? goModuleAbove(cwdAbs, checkout) : null;
  const out = new Map();
  for (const [name, lines] of parsed.files) {
    let abs = null;
    if (isAbsolute(name)) abs = name;
    else if (parsed.format === "go") {
      if (goModule && name.startsWith(`${goModule.module}/`)) abs = join(goModule.dir, name.slice(goModule.module.length + 1));
    } else abs = resolve(cwdAbs, name);
    if (!abs) continue;
    const base = roots.find((root) => abs === root || abs.startsWith(`${root}${sep}`));
    if (!base) continue;
    const rel = posix(relative(base, abs));
    const merged = out.get(rel) ?? new Map();
    for (const [line, hits] of lines) merged.set(line, Math.max(merged.get(line) ?? 0, hits));
    out.set(rel, merged);
  }
  return out;
}

function ranges(lines) {
  const out = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && line === last[1] + 1) last[1] = line;
    else out.push([line, line]);
  }
  return out.map(([from, to]) => (from === to ? String(from) : `${from}-${to}`)).join(",");
}

/** 改动行（added）与覆盖率报告求交：只统计报告里算可执行的改动行；整个文件不在报告里时，它的改动行全部算未覆盖。 */
export function changedLineCoverage({ added, report, files }) {
  let total = 0;
  let covered = 0;
  const gaps = [];
  for (const file of files) {
    const lines = added.get(file);
    if (!lines || lines.size === 0) continue;
    const measured = report.get(file);
    if (!measured) {
      total += lines.size;
      gaps.push({ file, lines: [...lines], missingFromReport: true });
      continue;
    }
    const miss = [];
    for (const line of lines) {
      if (!measured.has(line)) continue;
      total += 1;
      if (measured.get(line) > 0) covered += 1;
      else miss.push(line);
    }
    if (miss.length > 0) gaps.push({ file, lines: miss });
  }
  return { covered, total, percent: total === 0 ? 100 : (covered * 100) / total, gaps };
}

const expandCmd = (cmd, { tests, testDirs }) => cmd.flatMap((part) => (part === "{tests}" ? tests : part === "{testDirs}" ? testDirs : [part]));
const firstFive = (paths) => `${paths.slice(0, 5).join(", ")}${paths.length > 5 ? " 等" : ""}`;

/**
 * 先红后绿：在检出里把实现文件还原成基线版本、保留新增或修改的测试，这些测试必须失败；
 * 在当前实现上同一条命令必须通过。这样“测试先于实现失败过”由 harness 自己复算，不靠 Agent 自述。
 * 返回 null 表示这次改动不涉及（没有实现文件改动）；否则 { pass, note, tail }。
 */
export async function evaluateTdd({ item, changed, root, checkout, baseCommit, headCommit, env, timeoutMs, execute, link }) {
  const cfg = item.config;
  const src = changed.filter((path) => matches(path, cfg.source) && !matches(path, cfg.tests));
  if (src.length === 0) return null;
  const waiver = tddWaiver(root, baseCommit, headCommit);
  if (waiver) return { pass: true, note: `豁免: ${waiver}`, waived: true };

  const local = changed
    .filter((path) => matches(path, cfg.tests) && existsSync(join(checkout, path)))
    .map((path) => ({ path, rel: posix(relative(item.cwd, path)) }))
    .filter(({ rel }) => rel !== "" && !rel.startsWith(".."));
  if (local.length === 0) {
    return { pass: false, note: `改了 ${src.length} 个实现文件（${firstFive(src)}），没有新增或修改测试（命令的 cwd 之外的测试不算）` };
  }
  const args = expandCmd(cfg.cmd, {
    tests: local.map(({ rel }) => rel),
    testDirs: [...new Set(local.map(({ rel }) => (dirname(rel) === "." ? "." : `./${dirname(rel)}`)))],
  });
  const cwd = join(checkout, item.cwd);
  link();

  const green = await execute(args[0], args.slice(1), { cwd, env, timeoutMs });
  if (green.exit !== 0) {
    return { pass: false, note: "新增或修改的测试在当前实现上就不通过，无法判断红灯是否有效", tail: green.tail };
  }

  try {
    for (const path of src) {
      if (git(root, ["cat-file", "-e", `${baseCommit}:${path}`]).status === 0) gitOk(root, ["-C", checkout, "checkout", baseCommit, "--", path]);
      else rmSync(join(checkout, path), { force: true });
    }
    const red = await execute(args[0], args.slice(1), { cwd, env, timeoutMs });
    if (red.exit === 0) {
      return { pass: false, note: `新增或修改的测试（${firstFive(local.map(({ path }) => path))}）在还原实现后仍然通过，不能证明测试先于实现失败过` };
    }
    return { pass: true, note: `${local.length} 个测试文件在还原 ${src.length} 个实现文件后失败，在当前实现上通过`, tail: red.tail };
  } finally {
    git(root, ["-C", checkout, "checkout", "--force", "--detach", headCommit]);
    git(root, ["-C", checkout, "reset", "--hard", "-q"]);
    git(root, ["-C", checkout, "clean", "-fdq"]);
  }
}

/** 改动行覆盖率：在检出里跑覆盖率命令，读报告，只看这次改动的行。返回 null 表示没有可统计的改动文件。 */
export async function evaluateCoverage({ item, changed, root, checkout, baseCommit, headCommit, env, timeoutMs, execute, link }) {
  const cfg = item.config;
  const files = changed.filter((path) => matches(path, cfg.include) && existsSync(join(checkout, path)));
  if (files.length === 0) return null;
  const threshold = cfg.threshold ?? DEFAULT_THRESHOLD;
  const cwdAbs = join(checkout, item.cwd);
  link();
  const outcome = await execute(item.cmd[0], item.cmd.slice(1), { cwd: cwdAbs, env, timeoutMs });
  if (outcome.exit !== 0) return { pass: false, note: `覆盖率命令失败(exit=${outcome.exit})`, tail: outcome.tail };
  const reportFile = join(cwdAbs, cfg.report);
  if (!existsSync(reportFile)) return { pass: false, note: `没有生成覆盖率报告 ${cfg.report}（相对 ${item.cwd}）` };

  const report = normalizeCoverage(parseCoverage(readFileSync(reportFile, "utf8")), { checkout, cwdAbs });
  const result = changedLineCoverage({ added: addedLines(root, baseCommit, headCommit, files), report, files });
  const shown = result.percent.toFixed(1).replace(/\.0$/, "");
  const gaps = result.gaps
    .slice(0, 15)
    .map((gap) => (gap.missingFromReport ? `${gap.file}（不在覆盖率报告里，改动行 ${ranges(gap.lines)} 按未覆盖算）` : `${gap.file}:${ranges(gap.lines)}`));
  return {
    pass: result.percent >= threshold,
    note: result.total === 0 ? "改动行里没有可执行的行" : `改动行覆盖 ${result.covered}/${result.total}（${shown}%），阈值 ${threshold}%`,
    tail: gaps.length > 0 ? `未覆盖的改动行:\n${gaps.join("\n")}${result.gaps.length > 15 ? "\n..." : ""}` : undefined,
    coverage: { covered: result.covered, total: result.total, percent: Number(result.percent.toFixed(1)), threshold },
  };
}
