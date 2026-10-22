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
    review: { model: "sonnet", maxBudgetUsd: 2, blockSeverities: ["high", "critical"] },
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

function starterVerify() {
  const hasGo = existsSync("go.mod");
  const hasFrontend = existsSync("frontend/package.json");
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
  checks.push({ id: "lint", tier: "gate", when: ["**/*"], cmd: ["true"] });
  return {
    version: 1,
    docOnly: { match: ["docs/**", "**/*.md"], exclude: [] },
    checks,
    fullSuiteTriggers: { doc: "影响范围无法限定时扩大到全量", paths: [] },
  };
}

export function initProject({ cwd = process.cwd(), force = false } = {}) {
  const root = repoRoot(cwd);
  const mainBranch = refExists(root, "refs/heads/main") ? "main" : "master";
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
  create("verify.json", starterVerify());
  if (!existsSync(join(dir, "golden", "tasks.json"))) {
    mkdirSync(join(dir, "golden"), { recursive: true });
    writeFileSync(join(dir, "golden", "tasks.json"), `${JSON.stringify({ version: 1, tasks: [] }, null, 2)}\n`);
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
