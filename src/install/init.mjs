import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, gitOk, refExists, repoRoot } from "../lib/git.mjs";
import { PACKAGE_ROOT } from "../policy/resolve.mjs";
import { installAll, publishVersion, storeEntry, versionDir } from "./install.mjs";
import { assetPath, managedBlockBody, packageVersion, writeManagedBlock, writeRules } from "./managed.mjs";

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
      commitMessagePattern: "^[a-z]+(\\([^)]+\\))?: .+\\n\\n(- .+\\n?)+$",
      forbidMessagePatterns: ["^Co-Authored-By:", "^Co-authored-by:"],
    },
    // backend 取 auto 时按 claude、codex 顺序用本机第一个可用的；其他工具用 command 接入。
    review: { backend: "auto", model: "sonnet", maxBudgetUsd: 2, codexModel: null, command: null, blockSeverities: ["high", "critical"] },
    intent: { mode: "checklist", dir: "acceptance" },
    governance: { confirmOnGateChange: true, gatePaths: [] },
    escalate: {
      triggers: ["需求有歧义且会改变行为或权限", "必要验证被既有问题阻塞", "涉及推送、远程 MR、部署或生产操作", "同一方案连续失败两次"],
    },
    env: {},
  };
}

function starterPolicy({ mainBranch }) {
  const hooks = git(process.cwd(), ["config", "--get", "core.hooksPath"]).stdout.trim();
  return {
    version: 1,
    presets: ["secrets", "git-safety", "gate-self"],
    disabled: [],
    rules: [
      {
        id: "commit-message",
        kind: "commit-message",
        pattern: "^[a-z]+(\\([^)]+\\))?: .+",
        forbidPatterns: ["^Co-Authored-By:", "^Co-authored-by:"],
        reason: "提交信息必须符合项目提交规范",
        fix: "按项目提交规范改写提交信息",
      },
    ],
  };
}

export function starterVerify({ cwd = process.cwd() } = {}) {
  const hasGo = existsSync(join(cwd, "go.mod"));
  const hasFrontend = existsSync(join(cwd, "frontend/package.json"));
  const hasRust = existsSync(join(cwd, "Cargo.toml")) || existsSync(join(cwd, "rust/Cargo.toml"));
  const rustDir = existsSync(join(cwd, "Cargo.toml")) ? "" : "rust";
  const checks = [];
  if (hasGo) {
    checks.push(
      {
        id: "go-test",
        tier: "gate",
        when: ["**/*.go"],
        cmd: ["go", "test", "-count=1", "./..."],
      },
      { id: "go-build", tier: "gate", when: ["**/*.go", "go.mod"], cmd: ["go", "build", "./..."] },
    );
  }
  if (hasFrontend) {
    checks.push({
      id: "frontend-typecheck",
      tier: "gate",
      when: ["frontend/src/**", "frontend/*.ts", "frontend/package.json"],
      cwd: "frontend",
      cmd: ["pnpm", "typecheck"],
      requires: ["frontend/node_modules"],
    });
  }
  if (hasRust) {
    // 不写 requires: cargo 自己会创建 target，要求它先存在会让全新克隆永远跳过这项检查。
    checks.push({
      id: "cargo-test",
      tier: "gate",
      when: rustDir ? ["rust/**/*.rs", "rust/Cargo.toml", "rust/Cargo.lock"] : ["**/*.rs", "Cargo.toml", "Cargo.lock"],
      ...(rustDir ? { cwd: rustDir } : {}),
      cmd: ["cargo", "test", "--all-targets"],
    });
  }
  if (hasPytestConfig(cwd)) {
    checks.push({ id: "pytest", tier: "gate", when: ["**/*.py"], cmd: ["python3", "-m", "pytest", "-q"] });
  }
  // 通用起始检查：只匹配常见源码扩展名，避免文档改动也触发，从而保留仅文档的轻量路径。
  checks.push({
    id: "lint",
    tier: "gate",
    when: ["**/*.js", "**/*.ts", "**/*.tsx", "**/*.go", "**/*.py", "**/*.rs", "**/*.java", "src/**", "lib/**", "app/**"],
    cmd: ["true"],
  });
  // 改了规则或用例的分支，在它自己的检出里按它自己的配置重放黄金任务，退化当场暴露。
  checks.push({ id: "harness-golden", tier: "gate", when: [".harness/**"], cmd: [".harness/bin/harness", "golden", "--worktree"] });
  // 两个示例档位，接入后按项目实际替换：extended 记未执行并给补验方式，advisory 只提示。
  checks.push({ id: "manual-check", tier: "extended", when: ["src/**"], reason: "需要人工确认的检查，示例项", howToVerify: "按项目实际情况填写补验命令" });
  checks.push({ id: "visual-hint", tier: "advisory", when: ["src/**"], hint: "界面类改动建议人工过一眼，示例项" });
  return {
    version: 1,
    docOnly: { match: ["docs/**", "**/*.md"], exclude: [] },
    checks,
    fullSuiteTriggers: { doc: "影响范围无法限定时扩大到全量", paths: [] },
  };
}

/** 只有项目自己声明了 pytest 配置时才生成 pytest 检查，避免在没装 pytest 的仓库里凭空失败。 */
function hasPytestConfig(cwd = process.cwd()) {
  for (const rel of ["pytest.ini", "setup.cfg", "tests/conftest.py", "conftest.py"]) {
    if (existsSync(join(cwd, rel))) return true;
  }
  const pyproject = join(cwd, "pyproject.toml");
  if (!existsSync(pyproject)) return false;
  return /\[tool\.pytest/.test(readFileSync(pyproject, "utf8"));
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

export function initProject({ cwd = process.cwd(), force = false } = {}) {
  const root = repoRoot(cwd);
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
    // 自带一组针对预设规则的回归用例：没有它们的项目，改规则不会有任何检查能发现退化。
    const starter = join(assetPath("golden"), "starter.json");
    const body = existsSync(starter) ? readFileSync(starter, "utf8") : `${JSON.stringify({ version: 1, tasks: [] }, null, 2)}\n`;
    writeFileSync(join(dir, "golden", "tasks.json"), body);
    written.push(".harness/golden/tasks.json");
  }
  mkdirSync(join(dir, "acceptance"), { recursive: true });

  writeRules({ root, version });
  writeManagedBlock({ root, body: managedBlockBody() });
  const install = installAll({ cwd: root });
  return { root, version, written, install };
}

export function upgradeProject({ cwd = process.cwd() } = {}) {
  const root = repoRoot(cwd);
  const version = packageVersion();
  publishVersion({ version });
  writeRules({ root, version });
  const shim = installAll({ cwd: root });
  return { root, version, shim };
}
