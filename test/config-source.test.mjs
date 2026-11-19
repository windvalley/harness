import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { CONFIG, commit, git, makeRepo } from "./helpers.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

const VERIFY = {
  version: 1,
  docOnly: { match: ["docs/**", "**/*.md"], exclude: [] },
  checks: [
    { id: "unit", tier: "gate", when: ["src/**"], cmd: ["node", "-e", "process.exit(0)"] },
    { id: "browser", tier: "extended", when: ["src/**"], reason: "浏览器", howToVerify: "跑" },
  ],
  fullSuiteTriggers: { paths: [] },
};
const CHECKLIST = "# 验收清单\n\n## 应该发生\n\n- 行为正确。\n";

/**
 * 读到第 advanceAt 次 .harness 文件时把主分支推进到“检查为空”的提交。
 * 用来模拟两次配置读取之间主分支前进：加载到的检查必须与输出里标注的提交是同一份。
 */
function racingGit({ advanceAt }) {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const dir = mkdtempSync("/tmp/harness-racing-");
  const wrapper = join(dir, "git");
  writeFileSync(
    wrapper,
    `#!/bin/sh
REAL="${real}"
if [ "$1" = "cat-file" ] && [ "$2" = "blob" ]; then
  printf '%s\\n' "$3" >> "${dir}/reads.txt"
  case "$3" in
    *:.harness/*)
      n=0
      [ -f "${dir}/count" ] && n=$(cat "${dir}/count")
      n=$((n + 1))
      printf '%s' "$n" > "${dir}/count"
      if [ "$n" -eq ${advanceAt} ] && [ ! -f "${dir}/advanced" ]; then
        : > "${dir}/advanced"
        empty=$(printf '{"version":1,"docOnly":{"match":[],"exclude":[]},"checks":[],"fullSuiteTriggers":{"paths":[]}}\\n' | "$REAL" hash-object -w --stdin)
        idx="${dir}/index"
        GIT_INDEX_FILE="$idx" "$REAL" read-tree main
        GIT_INDEX_FILE="$idx" "$REAL" update-index --add --cacheinfo 100644,$empty,.harness/verify.json
        tree=$(GIT_INDEX_FILE="$idx" "$REAL" write-tree)
        next=$(printf 'advance main\\n' | "$REAL" commit-tree "$tree" -p main)
        HARNESS_MAIN_BYPASS=1 "$REAL" update-ref refs/heads/main "$next"
      fi
      ;;
  esac
fi
exec "$REAL" "$@"
`,
  );
  chmodSync(wrapper, 0o755);
  return {
    env: { PATH: `${dir}:${process.env.PATH}` },
    reads() {
      try {
        return readFileSync(join(dir, "reads.txt"), "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

/** 在当前进程环境里临时换掉 PATH，跑完恢复：夹具的 env 就是这个对象。 */
function withPath(repo, env, run) {
  const before = repo.env.PATH;
  repo.env.PATH = env.PATH;
  try {
    return run();
  } finally {
    if (before === undefined) delete repo.env.PATH;
    else repo.env.PATH = before;
  }
}

describe("配置来源固定", () => {
  test("两次配置读取之间主分支前进时，加载的检查与标注的提交一致", () => {
    const repo = makeRepo({ project: { ".harness/verify.json": VERIFY } });
    repos.push(repo);
    repo.branch("task/a", { "src/a.js": "a\n", ".harness/acceptance/task-a.md": CHECKLIST });
    const racing = racingGit({ advanceAt: 3 });
    const result = withPath(repo, racing.env, () => repo.cli("verify", "--branch", "task/a"));
    const stderr = result.stderr;

    const labeled = (stderr.match(/配置来源 main@([0-9a-f]{12})/) ?? [])[1];
    assert.ok(labeled, `要标注配置来源: ${stderr}`);
    const planLine = stderr.split("\n").find((line) => line.includes("计划")) ?? "";
    const planned = Number((planLine.match(/计划 (\d+) 项/) ?? [])[1]);

    // 标注的提交里有几项会自动执行的检查，就必须计划几项。
    const config = JSON.parse(git(repo.root, "show", `${labeled}:.harness/verify.json`));
    const expected = config.checks.filter((check) => check.tier !== "extended" && check.tier !== "advisory").length;
    assert.equal(planned, expected, `计划与标注提交不一致: ${planLine}`);

    const reads = racing.reads();
    // 主分支配置不能按分支名读：那正是“读到的内容”与“标注的提交”错配的来源。
    for (const read of reads) {
      assert.doesNotMatch(read, /^(main|master):\.harness\//, `主分支配置应当先解析成提交再读: ${read}`);
    }
    const configReads = reads.filter((read) => /\.harness\/(config|verify)\.json$/.test(read));
    // 最后一次读 verify.json 用的提交就是要标注的提交，且那一次读取里三个配置文件同源。
    const verifyReads = configReads.filter((read) => read.endsWith(".harness/verify.json"));
    const pinned = verifyReads.at(-1).split(":")[0];
    assert.equal(pinned.slice(0, 12), labeled, "标注的提交必须就是实际读配置的提交");
    assert.ok(configReads.includes(`${pinned}:.harness/config.json`), "配置与检查集必须来自同一个提交");
  });
});

describe("首次接入的提示", () => {
  function bootstrapRepo() {
    const repo = makeRepo();
    repos.push(repo);
    git(repo.root, "rm", "-q", ".harness/config.json");
    commit(repo.root, "chore(demo): 回到首次接入\n\n- 主分支还没有配置\n- 由接入分支提议", {});
    repo.branch("task/a", {
      "src/a.js": "a\n",
      ".harness/config.json": `${JSON.stringify(CONFIG, null, 2)}\n`,
      ".harness/verify.json": `${JSON.stringify(VERIFY, null, 2)}\n`,
      ".harness/acceptance/task-a.md": CHECKLIST,
    });
    return repo;
  }

  test("verify 说明配置来自接入分支，不说任务分支配置不参与判定", () => {
    const repo = bootstrapRepo();
    const result = repo.cli("verify", "--branch", "task/a");
    const line = result.stderr.split("\n").find((item) => item.includes("配置来源")) ?? "";
    assert.match(line, /首次接入，按分支 task\/a 的配置/);
    assert.match(line, /首次接入阶段/);
    assert.doesNotMatch(line, /不参与门禁判定/, "首次接入时分支配置就是判定来源，两句话会互相矛盾");
  });

  test("attest 找不到检查时，首次接入指向接入分支而不是主分支", () => {
    const repo = bootstrapRepo();
    const report = join(repo.root, "..", "r.md");
    writeFileSync(report, "ok\n");
    const result = repo.cli("attest", "--branch", "task/a", "--check", "unknown", "--command", "run", "--report", report);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /接入分支 task\/a/);
    assert.doesNotMatch(result.stderr, /主分支/);
  });
});
