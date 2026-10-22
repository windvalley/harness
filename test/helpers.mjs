import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");


export function sh(cwd, cmd, args, env = {}, input) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    input,
    env: { ...process.env, ...env },
  });
  return { status: result.status ?? (result.error ? 127 : 1), stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// 环境按仓库根目录登记：git 钩子会调用 shim，必须拿到同一套目录。
const REPO_ENV = new Map();

export function git(cwd, ...args) {
  const env = args.length > 0 && typeof args[args.length - 1] === "object" ? args.pop() : repoEnv(cwd);
  const result = sh(cwd, "git", args, env);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

export function repoEnv(cwd) {
  for (const [root, env] of REPO_ENV) {
    if (cwd === root || cwd.startsWith(`${root}/`)) return env;
  }
  return {};
}

export function write(root, rel, content) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// 夹具初始化提交相当于人工准备仓库，需要绕开门禁自身的引用保护。
export function commitWith(root, env, message, files = {}) {
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  const bypass = { ...env, HARNESS_MAIN_BYPASS: "1" };
  git(root, "add", "-A", bypass);
  git(root, "commit", "-q", "--no-verify", "-m", message, bypass);
  return git(root, "rev-parse", "HEAD", bypass);
}

export function commit(root, message, files = {}) {
  return commitWith(root, repoEnv(root), message, files);
}

export const CONFIG = {
  version: 1,
  mainBranch: "main",
  verify: { timeoutSeconds: 60, failFast: true },
  merge: {
    subjectPrefix: "Merge: ",
    postMergeCommand: null,
    requireEvidence: true,
    requireReview: true,
    commitMessagePattern: "^[a-z]+(\\([^)]+\\))?: .+\\n\\n(- .+\\n?)+$",
    forbidMessagePatterns: ["^Co-Authored-By:"],
  },
  review: { model: "sonnet", maxBudgetUsd: 1, blockSeverities: ["high", "critical"] },
  intent: { mode: "checklist", dir: "acceptance" },
  governance: { confirmOnGateChange: true, gatePaths: [".claude/settings.json"] },
  escalate: { triggers: [] },
  env: {},
};

const POLICY = {
  version: 1,
  presets: ["secrets", "git-safety", "gate-self"],
  disabled: [],
  rules: [
    {
      id: "commit-message",
      kind: "commit-message",
      pattern: "^[a-z]+(\\([^)]+\\))?: .+",
      forbidPatterns: ["^Co-Authored-By:"],
      reason: "提交信息必须符合规范",
      fix: "按规范改写",
    },
    {
      id: "generated",
      kind: "generated-header",
      paths: ["**/*.go"],
      headerPatterns: ["DO NOT EDIT"],
      reason: "自动生成文件禁止手改",
      fix: "改源文件后运行生成器",
    },
  ],
};

const VERIFY = {
  version: 1,
  docOnly: { match: ["docs/**", "**/*.md"], exclude: [] },
  // 与 init 生成的起始检查保持一致，这样起始黄金任务在夹具里同样适用。
  checks: [
    {
      id: "lint",
      tier: "gate",
      when: ["**/*.js", "**/*.ts", "**/*.tsx", "**/*.go", "**/*.py", "**/*.rs", "**/*.java", "src/**", "lib/**", "app/**"],
      cmd: ["node", "-e", "process.exit(0)"],
    },
    { id: "manual-check", tier: "extended", when: ["src/**"], reason: "需要人工确认的检查，示例项", howToVerify: "按项目实际情况填写补验命令" },
    { id: "visual-hint", tier: "advisory", when: ["src/**"], hint: "界面类改动建议人工过一眼，示例项" },
  ],
  fullSuiteTriggers: { doc: "", paths: [] },
};

/** 建一个带 harness 配置的临时仓库，并把当前源码发布进隔离的版本目录。 */
export function makeRepo({ files = {}, project = {}, install = true, trustCodex = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "harness-test-"));
  const root = join(base, "repo");
  mkdirSync(root);
  const env = {
    HARNESS_DATA_DIR: join(base, "data"),
    HARNESS_KEY_DIR: join(base, "key"),
    HARNESS_STORE: join(base, "store"),
    HARNESS_CACHE_DIR: join(base, "cache"),
    // 夹具自带 Codex 用户目录，避免读到本机真实配置，也便于模拟“已信任钩子”。
    CODEX_HOME: join(base, "codex-home"),
  };

  REPO_ENV.set(root, env);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "tester");
  git(root, "config", "user.email", "tester@example.com");
  git(root, "config", "commit.gpgsign", "false");

  const defaults = {
    ".harness/config.json": CONFIG,
    ".harness/policy.json": POLICY,
    ".harness/verify.json": VERIFY,
  };
  for (const [rel, value] of Object.entries({ ...defaults, ...project })) {
    if (value === null) continue;
    write(root, rel, `${JSON.stringify(value, null, 2)}\n`);
  }
  write(root, "AGENTS.md", "# 项目规范\n\n<!-- harness:start -->\n## Harness\n<!-- harness:end -->\n");
  commit(root, "chore: 初始化\n\n- 写入测试配置\n- 建立初始提交", { "README.md": "demo\n", ...files });

  const codexHome = join(base, "codex-home");
  mkdirSync(codexHome, { recursive: true });

  if (install) {
    const published = sh(root, process.execPath, [join(PACKAGE_ROOT, "bin", "harness.mjs"), "install"], env);
    if (published.status !== 0) throw new Error(`安装失败: ${published.stderr}`);
    // .harness/bin 由 install 生成且不入库；忽略它，避免分支提交把它带走。
    write(root, ".gitignore", ".harness/bin/\n.harness/dsh-plugin/\n");
    const bypass = { ...env, HARNESS_MAIN_BYPASS: "1" };
    git(root, "add", "-A", bypass);
    git(root, "commit", "-q", "--no-verify", "-m", "chore: 忽略门禁入口\n\n- 入口由 install 生成\n- 不入库", bypass);
    if (trustCodex !== false) {
      writeFileSync(
        join(codexHome, "config.toml"),
        `[hooks.state."${root}/.codex/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:${"a".repeat(64)}"\n`,
      );
    }
  }

  return {
    root,
    env,
    keyDir: join(base, "key"),
    cli(...args) {
      return sh(root, join(root, ".harness/bin/harness"), args, env);
    },
    rawCli(...args) {
      return sh(root, process.execPath, [join(PACKAGE_ROOT, "bin", "harness.mjs"), ...args], env);
    },
    branch(name, files2, message = "feat(demo): 调整示例\n\n- 增加示例文件\n- 补充对应说明") {
      git(root, "checkout", "-q", "-b", name);
      const head = commit(root, message, files2);
      git(root, "checkout", "-q", "main");
      return head;
    },
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

export function writeReview(repo, commitOid, verdict, extra = {}) {
  const script = `
    import { writeRecord } from ${JSON.stringify(join(PACKAGE_ROOT, "src/lib/store.mjs"))};
    writeRecord(process.argv[1], "review", process.argv[2], JSON.parse(process.argv[3]));
  `;
  const payload = JSON.stringify({
    verdict,
    reviewedCommit: commitOid,
    requirementFit: { rating: "met", evidence: "ok" },
    engineeringQuality: { rating: "good", evidence: "ok" },
    findings: [],
    blocking: [],
    ...extra,
  });
  return sh(repo.root, process.execPath, ["--input-type=module", "-e", script, repo.root, commitOid, payload], repo.env);
}

export function fakeReviewer(repo, structured) {
  const bin = join(repo.root, "..", "fake-claude.mjs");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { readFileSync, appendFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
appendFileSync(${JSON.stringify(join(repo.root, "..", "prompt.log"))}, prompt + "\\n=====\\n");
process.stdout.write(JSON.stringify({ is_error: false, total_cost_usd: 0.01, structured_output: ${JSON.stringify(structured)} }));
`,
  );
  chmodSync(bin, 0o755);
  repo.env.HARNESS_REVIEWER_BIN = bin;
  return bin;
}

/** 假的 codex：记录参数、工作目录、输入与结构定义，再把给定结果写到 --output-last-message。 */
export function fakeCodex(repo, structured) {
  const dir = join(repo.root, "..", "fakebin");
  mkdirSync(dir, { recursive: true });
  const log = join(repo.root, "..", "codex-call.json");
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const stdin = readFileSync(0, "utf8");
const schema = JSON.parse(readFileSync(at("--output-schema"), "utf8"));
writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), stdin, schema }));
writeFileSync(at("--output-last-message"), JSON.stringify(${JSON.stringify(structured)}));
`,
  );
  chmodSync(bin, 0o755);
  repo.env.PATH = `${dir}:${process.env.PATH}`;
  return log;
}

export const APPROVE = {
  verdict: "approve",
  requirementFit: { rating: "met", evidence: "满足" },
  engineeringQuality: { rating: "good", evidence: "无问题" },
  findings: [],
};

export function copyPackage() {
  const dir = mkdtempSync(join(tmpdir(), "harness-pkg-"));
  cpSync(join(PACKAGE_ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(PACKAGE_ROOT, "assets"), join(dir, "assets"), { recursive: true });
  cpSync(join(PACKAGE_ROOT, "bin"), join(dir, "bin"), { recursive: true });
  cpSync(join(PACKAGE_ROOT, "package.json"), join(dir, "package.json"));
  return dir;
}

export { readFileSync };
