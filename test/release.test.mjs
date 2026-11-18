import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { auditRelease, ensureRelease } from "../scripts/release.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TAG = "v1.2.3";
const COMMIT = "a".repeat(40);
const NOTES = "本次发布\n\n- 第一项\n";
const RELEASE_URL = `https://github.com/windvalley/harness/releases/tag/${TAG}`;

function release(overrides = {}) {
  return { tagName: TAG, targetCommitish: COMMIT, body: NOTES, isDraft: false, isPrerelease: false, url: RELEASE_URL, ...overrides };
}

function fixture({ current = release(), remoteCommit = COMMIT, viewError = null } = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git") {
      const suffix = remoteCommit ? `${remoteCommit}\trefs/tags/${TAG}\n` : "";
      return { status: 0, stdout: suffix, stderr: "" };
    }
    if (args[0] === "release" && args[1] === "view") {
      if (viewError) return { status: 1, stdout: "", stderr: viewError };
      if (!current) return { status: 1, stdout: "", stderr: "Not Found" };
      return { status: 0, stdout: JSON.stringify(current), stderr: "" };
    }
    if (args[0] === "release" && args[1] === "create") {
      current = release({ body: NOTES });
      return { status: 0, stdout: RELEASE_URL, stderr: "" };
    }
    throw new Error(`意外命令: ${cmd} ${args.join(" ")}`);
  };
  return { exec, calls };
}

const options = (exec) => ({ tag: TAG, commit: COMMIT, notes: NOTES, notesFile: join(ROOT, "CHANGELOG.md"), repository: "windvalley/harness", exec });

describe("GitHub Release 安全续跑", () => {
  test("已有 Release 身份与正文一致时不重复创建", () => {
    const { exec, calls } = fixture();
    const result = ensureRelease(options(exec));
    assert.equal(result.status, "existing");
    assert.equal(result.url, RELEASE_URL);
    assert.equal(calls.some((args) => args[1] === "release" && args[2] === "create"), false);
  });

  test("已有 Release 正文或提交不一致时拒绝，不覆盖", () => {
    for (const current of [release({ body: "旧正文" }), release({ targetCommitish: "b".repeat(40) })]) {
      const { exec, calls } = fixture({ current });
      assert.throws(() => ensureRelease(options(exec)), /Release/);
      assert.equal(calls.some((args) => args[1] === "release" && args[2] === "create"), false);
    }
  });

  test("有匹配 tag 但缺 Release 时安全补建并回读审计", () => {
    const { exec, calls } = fixture({ current: null });
    const result = ensureRelease(options(exec));
    assert.equal(result.status, "created");
    assert.equal(calls.filter((args) => args[1] === "release" && args[2] === "create").length, 1);
    assert.equal(calls.filter((args) => args[1] === "release" && args[2] === "view").length >= 2, true);
  });

  test("tag 指向其他提交时禁止补建", () => {
    const { exec, calls } = fixture({ current: null, remoteCommit: "b".repeat(40) });
    assert.throws(() => ensureRelease(options(exec)), /tag.*提交|tag.*commit/i);
    assert.equal(calls.some((args) => args[1] === "release" && args[2] === "create"), false);
  });

  test("Release 查询的网络或权限错误不能当成不存在", () => {
    const { exec, calls } = fixture({ current: null, viewError: "network timeout" });
    assert.throws(() => ensureRelease(options(exec)), /network timeout/);
    assert.equal(calls.some((args) => args[1] === "release" && args[2] === "create"), false);
  });

  test("只读 audit 核对 Release、tag 与正文且不创建", () => {
    const { exec, calls } = fixture();
    const result = auditRelease(options(exec));
    assert.equal(result.status, "verified");
    assert.equal(calls.some((args) => args[1] === "release" && args[2] === "create"), false);
  });

  test("工作流复用 ensure 与 audit，并从发布 tag 做隔离安装", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
    assert.match(workflow, /scripts\/release\.mjs ensure/);
    assert.match(workflow, /scripts\/release\.mjs audit/);
    assert.match(workflow, /--branch "\$tag"/);
    assert.match(workflow, /store=.*RELEASE/);
    assert.match(workflow, /HARNESS_STORE="\$store"/);
    assert.doesNotMatch(workflow, /already exists; nothing to do/);
  });

  test("工作流全新安装校验脚本语法有效", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
    const script = workflow.match(/RELEASE_SOURCE="\$source" node --input-type=module <<'NODE'\n([\s\S]*?)\n\s*NODE/);
    assert.ok(script, "未找到全新安装校验脚本");
    const result = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: script[1], encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  });
});
