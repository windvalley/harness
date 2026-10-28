import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { evaluateCall, evaluatePath, formatDenial } from "../src/policy/engine.mjs";
import { resolvePolicy, ruleStats, loadPreset } from "../src/policy/resolve.mjs";
import { claude } from "../src/adapters/claude.mjs";
import { codex } from "../src/adapters/codex.mjs";
import { dsh } from "../src/adapters/dsh.mjs";

const policy = {
  presets: ["secrets", "git-safety", "gate-self"],
  disabled: [],
  rules: [
    {
      id: "generated",
      kind: "generated-header",
      paths: ["**/*.go"],
      headerPatterns: ["DO NOT EDIT"],
      reason: "自动生成",
      fix: "改源文件",
    },
  ],
};
const resolved = resolvePolicy(policy);

let dirs = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
function tmpRoot(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "harness-policy-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const decide = (call, context = {}) => evaluateCall({ policy: resolved, root: tmpRoot(), call, context });
const denies = (call, context) => decide(call, context).decision === "deny";

describe("预设解析", () => {
  test("三个预设都能加载且每条规则都有 id、reason、fix", () => {
    for (const id of ["secrets", "git-safety", "gate-self"]) {
      const preset = loadPreset(id);
      assert.ok(preset.rules.length > 0, id);
      for (const rule of preset.rules) {
        assert.ok(rule.id && rule.kind && rule.reason && rule.fix, `${id}/${rule.id}`);
      }
    }
    const stats = ruleStats(resolved);
    assert.equal(stats.presets.length, 3);
    assert.ok(stats.total >= 13);
  });

  test("项目规则可以关闭预设规则，也可以覆盖同 id 规则", () => {
    const custom = resolvePolicy({ presets: ["git-safety"], disabled: ["git-stash"], rules: [] });
    assert.equal(custom.rules.some((rule) => rule.id === "git-stash"), false);
    const overridden = resolvePolicy({
      presets: ["git-safety"],
      rules: [{ id: "git-stash", kind: "shell-forbid", patterns: ["\\bgit\\s+stash\\s+list\\b"], reason: "x", fix: "y" }],
    });
    const rule = overridden.rules.find((item) => item.id === "git-stash");
    assert.equal(rule.reason, "x");
  });

  test("所有正则都能编译", () => {
    for (const rule of resolved.rules) {
      for (const pattern of [...(rule.patterns ?? []), ...(rule.headerPatterns ?? [])]) {
        assert.doesNotThrow(() => new RegExp(pattern), `${rule.id}: ${pattern}`);
      }
    }
  });

  test("未知预设直接报错", () => {
    assert.throws(() => resolvePolicy({ presets: ["nope"] }), /未知预设/);
  });
});

describe("路径与内容判定", () => {
  test("生成文件按文件头判定，允许手改的生成文件不拦", () => {
    const root = tmpRoot({
      "gen.go": "// Code generated. DO NOT EDIT.\npackage a\n",
      "free.go": "// auto-generated. You may modify it as needed.\npackage a\n",
    });
    assert.equal(evaluatePath({ policy: resolved, root, relPath: "gen.go", access: "write" }).decision, "deny");
    assert.equal(evaluatePath({ policy: resolved, root, relPath: "free.go", access: "write" }).decision, "allow");
  });

  test("私钥与凭据读出写入都拦，开发环境的环境文件与示例放行", () => {
    for (const rel of ["keys/server.pem", "deploy/server.key", "id_rsa", "credentials-prod.json"]) {
      assert.equal(evaluatePath({ policy: resolved, root: tmpRoot(), relPath: rel, access: "read" }).decision, "deny", rel);
      assert.equal(evaluatePath({ policy: resolved, root: tmpRoot(), relPath: rel, access: "write" }).decision, "deny", rel);
    }
    for (const rel of [".env", ".env.local", "frontend/.env.test-infra", ".env.example"]) {
      assert.equal(evaluatePath({ policy: resolved, root: tmpRoot(), relPath: rel, access: "read" }).decision, "allow", rel);
      assert.equal(evaluatePath({ policy: resolved, root: tmpRoot(), relPath: rel, access: "write" }).decision, "allow", rel);
    }
  });

  test("仓库外的证据密钥与轮换下来的旧密钥都不能读", () => {
    for (const file of ["/Users/u/.local/share/harness/evidence.key", "/Users/u/.local/share/harness/retired/evidence-1.key"]) {
      assert.equal(decide({ kind: "read", path: file }).decision, "deny", file);
    }
  });

  test("执行器入口受保护，规则与配置文件不受保护", () => {
    for (const rel of [".harness/bin/harness", ".harness/hooks/x", ".claude/settings.json", ".githooks/pre-commit"]) {
      assert.equal(evaluatePath({ policy: resolved, root: tmpRoot(), relPath: rel, access: "write" }).decision, "deny", rel);
    }
    for (const rel of [".harness/policy.json", ".harness/verify.json", ".harness/rules/core.md", ".harness/acceptance/x.md"]) {
      assert.equal(evaluatePath({ policy: resolved, root: tmpRoot(), relPath: rel, access: "write" }).decision, "allow", rel);
    }
  });

  test("拒绝信息带正确做法", () => {
    const result = evaluatePath({ policy: resolved, root: tmpRoot(), relPath: "keys/server.pem", access: "read" });
    assert.match(formatDenial(result), /正确做法/);
  });
});

describe("命令判定", () => {
  test("递归删除的各种写法", () => {
    for (const command of ["rm -rf build", "rm -f -r x", "ls | xargs rm -r", "bash -c \"rm -rf a\"", "(rm -rf a)", "find x -exec rm -rf {} +"]) {
      assert.ok(denies({ kind: "shell", command }), command);
    }
    assert.equal(denies({ kind: "shell", command: "rm /tmp/a.txt" }), false);
  });

  test("git 丢弃改动与强推", () => {
    for (const command of ["git reset --hard", "git clean -fd", "git checkout -- .", "git branch -D x", "git push -f origin x", "git push origin +x", "git stash pop"]) {
      assert.ok(denies({ kind: "shell", command }), command);
    }
    assert.equal(denies({ kind: "shell", command: "git status --short" }), false);
  });

  test("强制删除 Worktree 会连带丢掉未提交改动，普通删除与清理记录放行", () => {
    for (const command of ["git worktree remove --force ../x", "git worktree remove -f ../x", "git worktree remove ../x --force", "git -C /repo worktree remove -f -f ../x"]) {
      assert.ok(denies({ kind: "shell", command }), command);
    }
    for (const command of ["git worktree remove ../my-feature", "git worktree prune", "git branch -d feat/x"]) {
      assert.equal(denies({ kind: "shell", command }), false, command);
    }
  });

  test("git 全局选项不构成绕过", () => {
    assert.ok(denies({ kind: "shell", command: "git -C /tmp/x stash" }));
    assert.ok(denies({ kind: "shell", command: "git -c core.pager=cat reset --hard" }));
  });

  test("主分支上不允许合并与重置，任务分支允许吸收主分支", () => {
    assert.ok(denies({ kind: "shell", command: "git merge main" }, { onMainBranch: true }));
    assert.equal(denies({ kind: "shell", command: "git merge main" }, { onMainBranch: false }), false);
    assert.ok(denies({ kind: "shell", command: "git update-ref refs/heads/main abc" }));
    assert.ok(denies({ kind: "shell", command: "git push origin main" }));
    assert.equal(denies({ kind: "shell", command: "git push -u origin task" }), false);
  });

  test("引号内的文字不触发逐段规则", () => {
    assert.equal(denies({ kind: "shell", command: "git commit -m \"docs: 禁止 git stash\"" }), false);
    assert.ok(denies({ kind: "shell", command: "HARNESS_MERGE_TOKEN=1 git commit -m x" }));
  });

  test("私钥读取不能换成命令，开发环境的环境文件可以用命令处理", () => {
    for (const command of ["cat keys/server.pem", "grep X ~/.ssh/id_rsa", "cat ~/.local/share/harness/evidence.key", "base64 credentials-prod.json"]) {
      assert.ok(denies({ kind: "shell", command }), command);
    }
    for (const command of ["cat .env", "grep KEY frontend/.env.local", "echo A=1 >> .env"]) {
      assert.equal(denies({ kind: "shell", command }), false, command);
    }
    assert.equal(denies({ kind: "shell", command: "cat .env.example" }), false);
    assert.equal(denies({ kind: "shell", command: "git add .env.example" }), false);
  });

  test("搜索无法绕过私钥保护，环境文件不再拦", () => {
    assert.ok(denies({ kind: "search", path: "config/server.pem" }));
    assert.ok(denies({ kind: "search", glob: "**/*.pem" }));
    assert.equal(denies({ kind: "search", path: ".env" }), false);
    assert.equal(denies({ kind: "search", path: "src" }), false);
  });

  test("执行器入口的命令行保护覆盖整个目录，同名前缀的其他目录不受影响", () => {
    const husky = `.hu${"sky"}`;
    for (const command of [`git rm -r -q frontend/${husky}`, "mv .githooks hooks.bak", `git mv ${husky} tools/x`, "cp -r x .githooks", "git mv .harness/bin tmp-bin"]) {
      assert.equal(decide({ kind: "shell", command }).rule, "protect-executor-via-shell", command);
    }
    for (const command of ["git add .githooks", "cat .githooks/pre-commit", `ls frontend/${husky}`, "cp lint.js .githooks-backup/x"]) {
      assert.equal(denies({ kind: "shell", command }), false, command);
    }
  });
});

describe("主 Worktree 只用来合并（main-worktree 预设）", () => {
  const guarded = resolvePolicy({ presets: ["secrets", "git-safety", "gate-self", "main-worktree"], disabled: [], rules: [] });
  const main = { linkedWorktree: false, onMainBranch: true, branch: "main" };
  const linked = { linkedWorktree: true, onMainBranch: false, branch: "task/x" };
  const judge = (call, context) => evaluateCall({ policy: guarded, root: "/repo", call, context });

  test("默认不启用，启用后主 Worktree 里改文件被拒，Linked Worktree 与被忽略的本机文件放行", () => {
    assert.equal(denies({ kind: "write", path: "src/app.js", content: "x" }, main), false, "未启用预设时不受限制");
    const edit = judge({ kind: "write", path: "src/app.js", content: "x" }, main);
    assert.equal(edit.decision, "deny");
    assert.equal(edit.rule, "main-worktree-edit");
    assert.equal(judge({ kind: "write", path: "src/app.js", content: "x" }, linked).decision, "allow");
    assert.equal(judge({ kind: "write", path: "tmp/local.log", content: "x" }, { ...main, ignored: true }).decision, "allow");
    assert.equal(judge({ kind: "write", path: "/tmp/scratch.txt", content: "x" }, { ...main, outsideRepo: true }).decision, "allow");
  });

  test("主 Worktree 不能切离主分支，切回主分支与 Linked Worktree 里切分支放行", () => {
    for (const command of ["git switch task/x", "git switch -c task/x", "git checkout task/x", "git checkout -b task/x", "git checkout HEAD~1", "git checkout main -- src/a.js"]) {
      const result = judge({ kind: "shell", command }, main);
      assert.equal(result.decision, "deny", command);
      assert.equal(result.rule, "main-worktree-leave-main", command);
    }
    for (const command of ["git switch main", "git checkout main", "git checkout -q master", "git worktree add -b task/x ../x main", "git status --short"]) {
      assert.equal(judge({ kind: "shell", command }, main).decision, "allow", command);
    }
    assert.equal(judge({ kind: "shell", command: "git switch -c task/y" }, linked).decision, "allow");
  });

  test("提交只在 Linked Worktree 里发生，关掉规则后主 Worktree 也能提交", () => {
    const refused = judge({ kind: "commit" }, main);
    assert.equal(refused.decision, "deny");
    assert.equal(refused.rule, "main-worktree-commit");
    assert.match(refused.detail, /当前分支 main/);
    assert.equal(judge({ kind: "commit" }, linked).decision, "allow");
    const relaxed = resolvePolicy({ presets: ["main-worktree"], disabled: ["main-worktree-commit"], rules: [] });
    assert.equal(evaluateCall({ policy: relaxed, root: "/repo", call: { kind: "commit" }, context: main }).decision, "allow");
  });

  test("每条规则都带原因与修复办法", () => {
    for (const rule of loadPreset("main-worktree").rules) {
      assert.ok(rule.reason && rule.fix, rule.id);
    }
  });
});

describe("适配器归一", () => {
  test("三个客户端把同一操作归一为同一 call", () => {
    const claudeCall = claude.normalize({ tool_name: "Bash", tool_input: { command: "git stash" } });
    const codexCall = codex.normalize({ tool_name: "shell", tool_input: { command: "git stash" } });
    const dshCall = dsh.normalize({ name: "bash", arguments: { command: "git stash" } });
    for (const item of [claudeCall, codexCall, dshCall]) {
      assert.deepEqual(item.call, { kind: "shell", command: "git stash" });
    }
    const claudeWrite = claude.normalize({ tool_name: "Write", tool_input: { file_path: "a.txt", content: "x" } });
    const dshWrite = dsh.normalize({ name: "write", arguments: { file_path: "a.txt", content: "x" } });
    assert.deepEqual(claudeWrite.call, dshWrite.call);
  });

  test("codex 的 apply_patch 取到全部文件路径", () => {
    const patch = "*** Begin Patch\n*** Update File: a.txt\n*** Add File: b.txt\n*** End Patch";
    const normalized = codex.normalize({ tool_name: "apply_patch", tool_input: { input: patch } });
    assert.deepEqual(normalized.call.paths, ["a.txt", "b.txt"]);
  });

  test("无法识别的工具返回 null，表示放行", () => {
    assert.equal(claude.normalize({ tool_name: "WebSearch", tool_input: {} }), null);
    assert.equal(dsh.normalize({ name: "unknown_tool", arguments: {} }), null);
  });

  test("拒绝输出格式各不相同但都带原因", () => {
    assert.equal(claude.formatDeny("x").exitCode, 2);
    const codexOut = codex.formatDeny("x");
    assert.match(codexOut.stdout, /permissionDecision/);
    assert.equal(dsh.formatDeny("x").decision.kind, "deny");
  });
});
