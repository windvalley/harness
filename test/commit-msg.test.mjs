import { strict as assert } from "node:assert";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { git, makeRepo, sh, write } from "./helpers.mjs";
import { cleanCommitMessage } from "../src/githook.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

describe("提交信息按 git 的清理规则判定", () => {
  const STRICT = "^[a-z]+\\([^)]+\\): .+\\n\\n(- .+\\n?){2,}$";
  const strictPolicy = {
    version: 1,
    presets: ["secrets", "git-safety", "gate-self"],
    disabled: [],
    rules: [{ id: "commit-message", kind: "commit-message", pattern: STRICT, forbidPatterns: ["^Co-Authored-By:"], reason: "提交信息必须符合规范", fix: "按规范改写" }],
  };

  function commitWithEditor(repo, message) {
    const source = join(repo.root, "..", "editor-message.txt");
    const editor = join(repo.root, "..", "fake-editor.sh");
    write(repo.root, "../editor-message.txt", message);
    write(repo.root, "../fake-editor.sh", '#!/bin/sh\ncat "$MSG_SOURCE" > "$1"\n');
    chmodSync(editor, 0o755);
    return sh(repo.root, "git", ["commit", "-q", "-v"], { ...repo.env, GIT_EDITOR: editor, MSG_SOURCE: source });
  }

  test("用编辑器写的提交信息带注释行和剪刀线，校验按 git 最终写入的内容", () => {
    const repo = makeRepo({ project: { ".harness/policy.json": strictPolicy } });
    repos.push(repo);
    git(repo.root, "checkout", "-q", "-b", "task/editor");
    write(repo.root, "a.txt", "a\n");
    git(repo.root, "add", "a.txt");
    const message = [
      "feat(demo): 编辑器里写的提交信息",
      "",
      "- 第一条",
      "- 第二条",
      "",
      "# Please enter the commit message for your changes. Lines starting",
      "# with '#' will be ignored.",
      "# ------------------------ >8 ------------------------",
      "# Do not modify or remove the line above.",
      "diff --git a/a.txt b/a.txt",
      "+a",
      "",
    ].join("\n");
    const result = commitWithEditor(repo, message);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(repo.root, "log", "-1", "--format=%B"), "feat(demo): 编辑器里写的提交信息\n\n- 第一条\n- 第二条");

    write(repo.root, "b.txt", "b\n");
    git(repo.root, "add", "b.txt");
    const refused = commitWithEditor(repo, "feat(demo): 只有标题\n\n# Please enter the commit message\n");
    assert.notEqual(refused.status, 0, "去掉注释后不满足规范仍要拒绝");
    assert.match(refused.stderr, /不符合规范/);
  });

  test("清理规则：剪刀线以下、注释行、行尾空白、多余空行", () => {
    assert.equal(cleanCommitMessage("a: b  \r\n\r\n\r\n- x\n# note\n- y\n\n"), "a: b\n\n- x\n- y");
    assert.equal(cleanCommitMessage("a: b\n\n- x\n# ------------------------ >8 ------------------------\n- 不算\n"), "a: b\n\n- x");
    assert.equal(cleanCommitMessage("a: b\n; note\n# kept\n", ";"), "a: b\n# kept");
  });
});
