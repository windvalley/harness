import { strict as assert } from "node:assert";
import { afterEach, describe, test } from "node:test";
import { makeRepo, sh } from "./helpers.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});
function setup() {
  const repo = makeRepo();
  repos.push(repo);
  return repo;
}
const call = (repo, payload, ...extra) => sh(repo.root, ".harness/bin/harness".startsWith("/") ? "" : `${repo.root}/.harness/bin/harness`, ["hook", "--client", "generic", ...extra], repo.env, typeof payload === "string" ? payload : JSON.stringify(payload));

describe("通用客户端入口", () => {
  test("统一载荷：被规则禁止的写入退出码 2，原因在 stderr", () => {
    const repo = setup();
    const result = call(repo, { kind: "write", path: "config/server.pem", content: "x" });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /secrets-write|密钥|拦截/);
  });

  test("统一载荷：不违规的调用放行，shell 与 read 也能判定", () => {
    const repo = setup();
    assert.equal(call(repo, { kind: "write", path: "src/a.js", content: "a" }).status, 0);
    assert.equal(call(repo, { kind: "shell", command: "ls" }).status, 0);
    assert.equal(call(repo, { kind: "read", path: "config/server.pem" }).status, 2);
  });

  test("载荷不合约定时按失败处理，不静默放行", () => {
    const repo = setup();
    assert.equal(call(repo, { kind: "teleport" }).status, 2);
    assert.equal(call(repo, { kind: "write" }).status, 2);
    assert.equal(call(repo, "不是 JSON").status, 2);
  });

  test("generic 不支持收尾检查，明确报错", () => {
    const repo = setup();
    const result = call(repo, { kind: "shell", command: "ls" }, "--event", "stop");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /generic/);
  });
});
