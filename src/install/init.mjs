import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, gitOk, hooksPlacement, refExists, repoRoot } from "../lib/git.mjs";
import { PACKAGE_ROOT } from "../policy/resolve.mjs";
import { HOOK_NAMES, installAll, publishVersion, storeEntry, versionDir, worktreeHooksConfig } from "./install.mjs";
import { pruneBuiltinCopies } from "../golden/builtin.mjs";
import { managedBlockBody, packageVersion, writeManagedBlock, writeRules } from "./managed.mjs";
import { survey } from "./survey.mjs";
import { RISK_DEFAULTS, planSettings } from "../plan/plan.mjs";

function defaultConfig({ mainBranch }) {
  return {
    version: 1,
    mainBranch,
    verify: { timeoutSeconds: 1800, failFast: true },
    merge: {
      subjectPrefix: "Merge: ",
      postMergeCommand: null,
      requireEvidence: true,
      requireReview: true,
    },
    // 只放判据：哪些级别的发现阻断合并、单次评审能接受的 diff 字符数（超过时拒绝评审并给出拆分建议）。
    // 用哪个评审客户端、模型、推理强度和端点是各机器自己的事，放在本机 ~/.config/harness/reviewers.json，用 harness reviewer 管理。
    review: {
      blockSeverities: ["high", "critical"],
      maxDiffChars: 300000,
    },
    // plan：任务分级的机械判定，plan-first 预设据此要求先有实施授权；exclude 里的文件不计入代码改动行数。
    intent: { mode: "checklist", dir: "acceptance", plan: planSettings({}) },
    governance: { confirmOnGateChange: true, gatePaths: [] },
    // risk：机械风险信号。paths 命中的改动合并前要人确认，exclude 豁免其中的文档与测试夹具；deps 命中的改动要实施授权（plan-first 预设生效时）。按项目补充路径。
    risk: { paths: [...RISK_DEFAULTS.paths], deps: [...RISK_DEFAULTS.deps], exclude: [...RISK_DEFAULTS.exclude] },
    escalate: {
      triggers: ["需求有歧义且会改变行为或权限", "必要验证被既有问题阻塞", "涉及推送、远程 MR、部署或生产操作", "同一个问题连续三轮没有解决"],
    },
    env: {},
    // 清理任务 Worktree 前在里面依次运行的命令，例如停服务、删隔离数据库；见 harness worktree clean。
    worktree: { cleanup: [] },
    // 交付方式：local 用 harness merge 合入本地主分支；remote 用 harness submit 推送任务分支并创建 PR/MR，由平台合并。
    delivery: { mode: "local" },
  };
}

function starterPolicy({ mainBranch }) {
  const hooks = git(process.cwd(), ["config", "--get", "core.hooksPath"]).stdout.trim();
  return {
    version: 1,
    presets: ["secrets", "git-safety", "gate-self", "plan-first"],
    disabled: [],
    rules: [
      {
        id: "commit-message",
        kind: "commit-message",
        // 提交信息规范只在这一条里定义：钩子、verify 与 review 的前置检查、status 和合并共用同一份判定。
        // 中文为主的项目把 lang 改成 "zh"，纯英文项目改成 "en"；字段说明见参考手册的“提交信息”。
        lang: "any",
        types: ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"],
        header: { maxLength: 72, noTrailingPeriod: true },
        body: { required: true, leadingBlank: true, bullets: true },
        forbidPatterns: ["^Co-Authored-By:", "^Co-authored-by:"],
        example: "feat(login): 支持短信验证码登录\n\n- 新增验证码发送与校验接口\n- 登录页增加验证码输入",
        reason: "提交信息必须符合项目提交规范",
        fix: "按示例改写：标题是“类型(范围): 描述”，空一行后每行一个“- ”开头的要点；已经提交的用 git commit --amend 或变基改写",
      },
    ],
  };
}

/**
 * 起始检查只按项目自己声明过的东西生成，探测根目录与一级子目录。
 * 推断不出真实命令的一律不生成，由 Agent 接入时对照项目补上：猜错的 gate 检查必然失败，会挡住之后每一个相关任务。
 */
export function starterVerify({ cwd = process.cwd() } = {}) {
  const dirs = projectDirs(cwd);
  const checks = [...goChecks(cwd, dirs), ...nodeChecks(cwd, dirs), ...rustChecks(cwd, dirs), ...pytestChecks(cwd, dirs)];
  // 通用起始检查：只匹配常见源码扩展名，避免文档改动也触发，从而保留仅文档的轻量路径。
  checks.push({
    id: "lint",
    // 起始占位：没有配置真实命令前记入未执行项，不能让证据显示“lint 通过”。
    tier: "extended",
    reason: "起始占位，尚未配置项目的 lint 命令",
    howToVerify: "在 .harness/verify.json 把 lint 的 cmd 改成项目实际的 lint 命令，tier 改为 gate",
    when: ["**/*.js", "**/*.ts", "**/*.tsx", "**/*.go", "**/*.py", "**/*.rs", "**/*.java", "src/**", "lib/**", "app/**"],
  });
  // 改了规则或用例的分支，在它自己的检出里按它自己的配置重放黄金任务，退化当场暴露。
  checks.push({ id: "harness-golden", tier: "gate", when: [".harness/**"], cmd: [".harness/bin/harness", "golden", "--worktree"] });
  return {
    version: 1,
    docOnly: { match: ["docs/**", "**/*.md"], exclude: [] },
    checks,
    fullSuiteTriggers: { doc: "影响范围无法限定时扩大到全量", paths: [] },
  };
}

/**
 * 参与探测的位置：根目录（""）与一级子目录。
 * 跳过隐藏目录、node_modules、被 .gitignore 忽略的目录（构建产物里常带 package.json），以及名字里有 glob 字符、写不进 when 的目录。
 */
function projectDirs(root) {
  const names = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && !/[*?{},\\]/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) return [""];
  const probe = git(root, ["check-ignore", "-z", "--stdin"], { input: names.map((name) => `${name}/`).join("\0") });
  const ignored = new Set(probe.stdout.split("\0").filter(Boolean).map((rel) => rel.replace(/\/$/, "")));
  return ["", ...names.filter((name) => !ignored.has(name))];
}

const under = (dir, rel) => (dir ? `${dir}/${rel}` : rel);

/** 位于 dir 的一项 gate 检查：子目录的检查名带目录前缀，when 按 dir 改写成相对仓库根的路径；requires 由调用方给出相对仓库根的路径。 */
function located(dir, name, { when, cmd, requires }) {
  return {
    id: dir ? `${dir}-${name}` : name,
    tier: "gate",
    when: when.map((rel) => under(dir, rel)),
    ...(dir ? { cwd: dir } : {}),
    cmd,
    ...(requires ? { requires } : {}),
  };
}

/** 每个 go.mod 是一个独立模块，根目录的 ./... 不会进入子目录里的模块，所以各自生成。 */
function goChecks(root, dirs) {
  const when = ["**/*.go", "go.mod", "go.sum"];
  return dirs
    .filter((dir) => existsSync(join(root, dir, "go.mod")))
    .flatMap((dir) => [
      located(dir, "go-test", { when, cmd: ["go", "test", "-count=1", "./..."] }),
      located(dir, "go-build", { when, cmd: ["go", "build", "./..."] }),
    ]);
}

// 常见的类型检查脚本名：typecheck、create-vue 的 type-check、Turborepo 的 check-types，以及带冒号的写法。
const TYPECHECK_SCRIPTS = ["typecheck", "type-check", "check-types", "check:types", "types:check"];
const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];
const NODE_SOURCES = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue,svelte}";

/** 只为 scripts 里声明了类型检查脚本的 package.json 生成，命令用项目自己的包管理器执行这个脚本。 */
function nodeChecks(root, dirs) {
  const rootManifest = readPackageJson(join(root, "package.json"));
  const workspace = Boolean(rootManifest?.workspaces) || existsSync(join(root, "pnpm-workspace.yaml"));
  // 工作区根目录有类型检查脚本时由它统管各个成员，再为成员生成会把同一批代码查两遍。
  const rootCovers = workspace && Boolean(typecheckScript(rootManifest));
  const checks = [];
  for (const dir of dirs) {
    // 工作区成员不会有自己的锁文件；自带锁文件的子目录是独立项目。
    const member = workspace && dir !== "" && !LOCKFILES.some(([file]) => existsSync(join(root, dir, file)));
    if (member && rootCovers) continue;
    const manifest = dir ? readPackageJson(join(root, dir, "package.json")) : rootManifest;
    const script = typecheckScript(manifest);
    if (!script) continue;
    const scopes = dir ? [[dir, manifest], ["", rootManifest]] : [["", manifest]];
    const manager = packageManager(root, scopes);
    // Yarn PnP 没有 node_modules，按依赖目录判定的检查会一直记为未执行，不如不生成。
    if (manager.name === "yarn" && yarnPnp(root, scopes)) continue;
    const own = under(dir, "node_modules");
    // 成员的依赖装在根目录：npm、yarn、bun 提升到根目录的 node_modules，
    // pnpm 的成员目录里只有指向根目录 .pnpm 的链接，两处都要有，除非把 node-linker 改成了 hoisted。
    const requires = !member ? [own] : manager.name === "pnpm" && !pnpmHoisted(root) ? ["node_modules", own] : ["node_modules"];
    const check = located(dir, "typecheck", {
      when: [NODE_SOURCES, "**/package.json", "**/tsconfig*.json"],
      cmd: [manager.name, "run", script],
      requires,
    });
    if (manager.lockfile) check.when.push(manager.lockfile);
    checks.push(check);
  }
  return checks;
}

const typecheckScript = (manifest) => TYPECHECK_SCRIPTS.find((name) => typeof manifest?.scripts?.[name] === "string");

/** pnpm 的 node-linker 可以写在 .npmrc，新版本也可以写在 pnpm-workspace.yaml。 */
function pnpmHoisted(root) {
  const read = (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "");
  return /^\s*node-linker\s*=\s*hoisted\b/m.test(read(".npmrc")) || /^\s*nodeLinker:\s*["']?hoisted\b/m.test(read("pnpm-workspace.yaml"));
}

function readPackageJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const declaredManager = (manifest) => /^(npm|pnpm|yarn|bun)@/.exec(String(manifest?.packageManager ?? ""))?.[1];

/**
 * 依次看包自己、再看根目录：packageManager 字段优先，其次是锁文件；都没有时用 npm。
 * lockfile 是相对仓库根的锁文件路径，依赖变化时也要触发检查。
 */
function packageManager(root, scopes) {
  for (const [dir, manifest] of scopes) {
    const declared = declaredManager(manifest);
    const lock = LOCKFILES.map(([file, name]) => ({ rel: dir ? `${dir}/${file}` : file, name }))
      .filter((item) => !declared || item.name === declared)
      .find((item) => existsSync(join(root, item.rel)));
    if (declared) return { name: declared, lockfile: lock?.rel ?? null };
    if (lock) return { name: lock.name, lockfile: lock.rel };
  }
  return { name: "npm", lockfile: null };
}

/** Yarn 2 起默认 Plug'n'Play：有 .pnp.cjs，或者 .yarnrc.yml 没把 nodeLinker 改成别的；没有 .yarnrc.yml 时看声明的版本。 */
function yarnPnp(root, scopes) {
  for (const [dir] of scopes) {
    if (existsSync(join(root, dir, ".pnp.cjs")) || existsSync(join(root, dir, ".pnp.js"))) return true;
    const rc = join(root, dir, ".yarnrc.yml");
    if (existsSync(rc)) return (/^\s*nodeLinker:\s*["']?([\w-]+)/m.exec(readFileSync(rc, "utf8"))?.[1] ?? "pnp") === "pnp";
  }
  const major = scopes.map(([, manifest]) => /^yarn@(\d+)/.exec(String(manifest?.packageManager ?? ""))?.[1]).find(Boolean);
  return Number(major) >= 2;
}

/** 根目录是 Cargo workspace 时成员由根目录的 cargo test 统一测试；否则每个 Cargo.toml 各自生成。 */
function rustChecks(root, dirs) {
  const manifest = join(root, "Cargo.toml");
  const workspace = existsSync(manifest) && /^\s*\[workspace[\].]/m.test(readFileSync(manifest, "utf8"));
  // 不写 requires: cargo 自己会创建 target，要求它先存在会让全新克隆永远跳过这项检查。
  return (workspace ? [""] : dirs)
    .filter((dir) => existsSync(join(root, dir, "Cargo.toml")))
    .map((dir) => located(dir, "cargo-test", { when: ["**/*.rs", "**/Cargo.toml", "Cargo.lock"], cmd: ["cargo", "test", "--all-targets"] }));
}

/** 根目录的 pytest 会递归收集子目录里的测试，根目录有配置时不再为子目录单独生成。 */
function pytestChecks(root, dirs) {
  const found = hasPytestConfig(root) ? [""] : dirs.filter((dir) => dir && hasPytestConfig(join(root, dir)));
  return found.map((dir) => located(dir, "pytest", { when: ["**/*.py"], cmd: ["python3", "-m", "pytest", "-q"] }));
}

/**
 * 只认 pytest 自己会读的配置，避免在没装 pytest 的仓库里凭空失败。
 * setup.cfg 与 tox.ini 常常只给别的工具用，里面有 pytest 的段落才算。
 */
function hasPytestConfig(dir) {
  for (const rel of ["pytest.ini", ".pytest.ini", "pytest.toml", ".pytest.toml", "conftest.py", "tests/conftest.py"]) {
    if (existsSync(join(dir, rel))) return true;
  }
  const sections = [
    ["pyproject.toml", /^\s*\[tool\.pytest/m],
    ["setup.cfg", /^\s*\[tool:pytest\]/m],
    ["tox.ini", /^\s*\[pytest\]/m],
  ];
  return sections.some(([rel, pattern]) => existsSync(join(dir, rel)) && pattern.test(readFileSync(join(dir, rel), "utf8")));
}

/**
 * 判断主分支名。
 * 刚 git init 的仓库还没有任何提交，refs/heads 下两个分支都不存在，只能看 HEAD 指向谁；
 * 这时如果一律回落 master，就会把 main 仓库的配置写错。
 */
export function detectMainBranch(root) {
  for (const name of ["main", "master"]) {
    if (refExists(root, `refs/heads/${name}`)) return name;
  }
  const head = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const name = head.status === 0 ? head.stdout.trim() : "";
  if (name) return name;
  // 分离头指针且没有 main/master，只能按最通用的约定起名。
  return "main";
}

/** 计算 init 会写哪些文件，用于预览；与真正执行共用同一份判断。 */
function plannedWrites(root, { force }) {
  const items = [];
  const consider = (rel) => items.push({ rel, action: existsSync(join(root, rel)) ? "modify" : "create" });
  for (const name of ["config.json", "policy.json", "verify.json", "golden/tasks.json"]) {
    const rel = `.harness/${name}`;
    if (force || !existsSync(join(root, rel))) consider(rel);
  }
  for (const rel of [".harness/bin/harness", ".harness/rules/", ".harness/templates/", ".claude/settings.json", ".codex/hooks.json", ".gitignore", "AGENTS.md"]) {
    consider(rel);
  }
  const { rel: hooksRel, tracked } = hooksPlacement(root, { hooksDir: worktreeHooksConfig(root)?.hooksDir });
  if (tracked) for (const name of HOOK_NAMES) consider(`${hooksRel}/${name}`);
  return items;
}

function stackOf(verify) {
  const generic = new Set(["lint", "harness-golden"]);
  return verify.checks.map((check) => check.id).filter((id) => !generic.has(id));
}

/**
 * 接入或升级一个项目。
 * dryRun 只调查与预览，不写任何文件；takeOver 时由 harness 接管其他工具的主分支保护与 Agent 拦截钩子。
 */
export function initProject({ cwd = process.cwd(), force = false, dryRun = false, takeOver = false } = {}) {
  const root = repoRoot(cwd);
  const report = survey({ root });
  const stack = stackOf(starterVerify({ cwd: root }));
  const planned = plannedWrites(root, { force });
  if (dryRun) return { root, dryRun: true, report, stack, planned };

  const mainBranch = detectMainBranch(root);
  const dir = join(root, ".harness");
  mkdirSync(dir, { recursive: true });
  const written = [];

  const create = (rel, value) => {
    const file = join(root, ".harness", rel);
    if (existsSync(file) && !force) return false;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    written.push(`.harness/${rel}`);
    return true;
  };

  const version = packageVersion();
  create("config.json", defaultConfig({ mainBranch }));
  create("policy.json", starterPolicy({ mainBranch }));
  create("verify.json", starterVerify({ cwd: root }));
  if (!existsSync(join(dir, "golden", "tasks.json"))) {
    mkdirSync(join(dir, "golden"), { recursive: true });
    // 规则回归用例由 harness 内置并随版本更新；这里只放项目自己的用例。
    const body = { version: 1, doc: "项目自己的黄金任务。内置用例随 harness 版本更新，同 id 的用例覆盖内置，disableBuiltin 列出要停用的内置用例 id。", tasks: [] };
    writeFileSync(join(dir, "golden", "tasks.json"), `${JSON.stringify(body, null, 2)}\n`);
    written.push(".harness/golden/tasks.json");
  }
  mkdirSync(join(dir, "acceptance"), { recursive: true });

  writeRules({ root, version });
  writeManagedBlock({ root, body: managedBlockBody() });
  const install = installAll({ cwd: root, takeOver });
  return { root, version, written, install, report, stack, planned, takeOver };
}

export function upgradeProject({ cwd = process.cwd() } = {}) {
  const root = repoRoot(cwd);
  const version = packageVersion();
  publishVersion({ version });
  writeRules({ root, version });
  // 托管块随版本更新：Agent 每次都会加载 AGENTS.md，任务分级等硬性要求写在这里才不会被跳过。
  writeManagedBlock({ root, body: managedBlockBody() });
  const shim = installAll({ cwd: root });
  const golden = pruneBuiltinCopies(root);
  return { root, version, shim, golden };
}
