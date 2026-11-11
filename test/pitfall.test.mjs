import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { CONFIG, git, makeRepo, sh, write } from "./helpers.mjs";
import { gatePaths } from "../src/lib/config.mjs";
import { matchAny } from "../src/lib/glob.mjs";
import { addPitfall, listPitfalls, MAX_BYTES, MAX_ENTRIES, MAX_HITS, parsePitfalls } from "../src/pitfall/pitfall.mjs";

let repos = [];
let dirs = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  repos = [];
  dirs = [];
});

const FILE = ".harness/pitfalls.md";

function setup() {
  const repo = makeRepo();
  repos.push(repo);
  assert.equal(repo.cli("upgrade").status, 0);
  return repo;
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "harness-pitfall-"));
  mkdirSync(join(dir, ".harness"));
  dirs.push(dir);
  return dir;
}

const add = (repo, signature, extra = {}) =>
  repo.cli("pitfall", "add", "--signature", signature, "--symptom", extra.symptom ?? `${signature} 现象`, "--fix", extra.fix ?? `${signature} 做法`);

describe("harness pitfall add", () => {
  test("第一次记录创建文件与条目，输出命中 1 次", () => {
    const repo = setup();
    const result = add(repo, "npm ci 报 EINTEGRITY", { symptom: "安装依赖时校验失败", fix: "删除 node_modules 与锁文件缓存后重装" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /新增.*命中 1 次/);
    const doc = parsePitfalls(readFileSync(join(repo.root, FILE), "utf8"));
    assert.equal(doc.entries.length, 1);
    assert.equal(doc.entries[0].signature, "npm ci 报 EINTEGRITY");
    assert.equal(doc.entries[0].symptom, "安装依赖时校验失败");
    assert.equal(doc.entries[0].fix, "删除 node_modules 与锁文件缓存后重装");
    assert.equal(doc.entries[0].hits.length, 1);
  });

  test("相同 signature（忽略空白与大小写差异）只累加命中，不新增条目", () => {
    const repo = setup();
    add(repo, "Port 3000 in use");
    const again = add(repo, "  port   3000 IN use ");
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /命中 2 次/);
    const doc = parsePitfalls(readFileSync(join(repo.root, FILE), "utf8"));
    assert.equal(doc.entries.length, 1);
    assert.equal(doc.entries[0].hits.length, 2);
  });

  test("再次命中时给出新的做法会替换旧的做法，没给则保留", () => {
    const repo = setup();
    add(repo, "e1", { fix: "旧做法" });
    repo.cli("pitfall", "add", "--signature", "e1", "--fix", "新做法");
    let entry = parsePitfalls(readFileSync(join(repo.root, FILE), "utf8")).entries[0];
    assert.equal(entry.fix, "新做法");
    assert.equal(entry.symptom, "e1 现象");
    repo.cli("pitfall", "add", "--signature", "e1");
    entry = parsePitfalls(readFileSync(join(repo.root, FILE), "utf8")).entries[0];
    assert.equal(entry.fix, "新做法");
    assert.equal(entry.hits.length, 3);
  });

  test("满 3 次才标记建议固化，第 2 次不标", () => {
    const repo = setup();
    assert.doesNotMatch(add(repo, "slow-test").stdout, /建议固化/);
    assert.doesNotMatch(add(repo, "slow-test").stdout, /建议固化/);
    const third = add(repo, "slow-test");
    assert.match(third.stdout, /命中 3 次/);
    assert.match(third.stdout, /建议固化/);
    add(repo, "other");
    const flagged = repo.cli("pitfall", "list", "--flagged");
    assert.equal(flagged.status, 0, flagged.stderr);
    assert.match(flagged.stdout, /slow-test/);
    assert.doesNotMatch(flagged.stdout, /other/);
    assert.match(repo.cli("pitfall", "list").stdout, /other/);
  });

  test("命中记录只保留最近 MAX_HITS 条，建议固化标记不丢", () => {
    const repo = setup();
    for (let i = 0; i < MAX_HITS + 3; i++) assert.equal(add(repo, "loop").status, 0);
    const doc = parsePitfalls(readFileSync(join(repo.root, FILE), "utf8"));
    assert.equal(doc.entries[0].hits.length, MAX_HITS);
    assert.match(repo.cli("pitfall", "list", "--flagged").stdout, /loop/);
  });

  test("signature、现象、做法必须是单行非空短文本", () => {
    const repo = setup();
    const bad = (args) => {
      const result = repo.cli("pitfall", "add", ...args);
      assert.notEqual(result.status, 0, args.join(" "));
      return result.stderr;
    };
    assert.match(bad(["--symptom", "x", "--fix", "y"]), /signature/);
    assert.match(bad(["--signature", "  ", "--symptom", "x", "--fix", "y"]), /signature/);
    assert.match(bad(["--signature", "a", "--fix", "y"]), /现象/);
    assert.match(bad(["--signature", "a", "--symptom", "x"]), /做法/);
    assert.match(bad(["--signature", "a", "--symptom", "x".repeat(500), "--fix", "y"]), /过长/);
    assert.match(bad(["--signature", "a\nb", "--symptom", "x", "--fix", "y"]), /单行/);
    assert.equal(parsePitfalls(readFileSync(join(repo.root, FILE), "utf8")).entries.length, 0, "校验失败不写入条目");
  });

  test("文件里留着未解决的合并冲突标记时拒绝写入", () => {
    const repo = setup();
    add(repo, "a");
    const file = join(repo.root, FILE);
    write(repo.root, FILE, `${readFileSync(file, "utf8")}<<<<<<< HEAD\n=======\n>>>>>>> feat/x\n`);
    const result = add(repo, "b");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /合并冲突/);
  });

  test("两个分支合并后出现同名条目，下次记录时合并成一条并保留双方命中", () => {
    const dir = scratch();
    const header = "# 坑位记录\n\n";
    const entry = (hits) => `## dup\n- 现象: s\n- 做法: f\n${hits.map((hit) => `- 命中: ${hit}\n`).join("")}\n`;
    write(dir, FILE, `${header}${entry(["2026-11-01 feat/a"])}${entry(["2026-11-02 feat/b"])}`);
    const result = addPitfall(dir, { signature: "dup", symptom: "s", fix: "f", branch: "feat/c", date: "2026-11-03" });
    assert.equal(result.hits, 3);
    const doc = parsePitfalls(readFileSync(join(dir, FILE), "utf8"));
    assert.equal(doc.entries.length, 1);
    assert.equal(doc.entries[0].hits.length, 3);
  });
});

describe("容量上限", () => {
  const fill = (dir, count, { date = (i) => `2026-10-${String(i + 1).padStart(2, "0")}` } = {}) => {
    for (let i = 0; i < count; i++) addPitfall(dir, { signature: `sig-${i}`, symptom: "s", fix: "f", date: date(i) });
  };

  test("条目数到上限后再新增，淘汰最久未命中的条目", () => {
    const dir = scratch();
    fill(dir, MAX_ENTRIES);
    const result = addPitfall(dir, { signature: "fresh", symptom: "s", fix: "f", date: "2026-11-01" });
    assert.deepEqual(result.evicted, ["sig-0"]);
    const names = listPitfalls(dir).map((item) => item.signature);
    assert.equal(names.length, MAX_ENTRIES);
    assert.ok(names.includes("fresh"));
    assert.ok(!names.includes("sig-0"));
  });

  test("日期相同时淘汰命中次数最少的", () => {
    const dir = scratch();
    fill(dir, MAX_ENTRIES, { date: () => "2026-10-01" });
    addPitfall(dir, { signature: "sig-0", date: "2026-10-01" });
    const result = addPitfall(dir, { signature: "fresh", symptom: "s", fix: "f", date: "2026-10-01" });
    assert.deepEqual(result.evicted, ["sig-1"]);
  });

  test("已建议固化的条目即使最久未命中也不被淘汰", () => {
    const dir = scratch();
    fill(dir, MAX_ENTRIES);
    for (let i = 0; i < 2; i++) addPitfall(dir, { signature: "sig-0", date: "2026-09-01" });
    const result = addPitfall(dir, { signature: "fresh", symptom: "s", fix: "f", date: "2026-11-01" });
    assert.deepEqual(result.evicted, ["sig-1"]);
    assert.ok(listPitfalls(dir).some((item) => item.signature === "sig-0"));
  });

  test("文件字节数超过上限时同样淘汰", () => {
    const dir = scratch();
    const long = "长".repeat(100);
    for (let i = 0; i < 20; i++) addPitfall(dir, { signature: `big-${i}`, symptom: long, fix: long, date: `2026-10-${String(i + 1).padStart(2, "0")}` });
    const size = Buffer.byteLength(readFileSync(join(dir, FILE), "utf8"));
    assert.ok(size <= MAX_BYTES, `文件 ${size} 字节超过上限 ${MAX_BYTES}`);
    assert.ok(listPitfalls(dir).length < 20);
    assert.ok(listPitfalls(dir).some((item) => item.signature === "big-19"), "最新的条目保留");
  });

  test("没有可淘汰的条目时拒绝新增，不破坏已有内容", () => {
    const dir = scratch();
    fill(dir, MAX_ENTRIES);
    for (let i = 0; i < MAX_ENTRIES; i++) for (let n = 0; n < 2; n++) addPitfall(dir, { signature: `sig-${i}`, date: "2026-10-05" });
    const before = readFileSync(join(dir, FILE), "utf8");
    assert.throws(() => addPitfall(dir, { signature: "fresh", symptom: "s", fix: "f", date: "2026-11-01" }), /建议固化/);
    assert.equal(readFileSync(join(dir, FILE), "utf8"), before);
  });
});

describe("接入与门禁", () => {
  test("坑位文件不属于门禁文件，追加不触发人工确认", () => {
    const gate = gatePaths({ config: CONFIG });
    assert.equal(matchAny(FILE, gate), false);
    assert.equal(matchAny(".harness/rules/core.md", gate), true, "对照：规则文件仍是门禁文件");
  });

  test("任务分支追加坑位后 status 不报门禁改动，并提示建议固化的条目", () => {
    const repo = setup();
    git(repo.root, "add", "-A", repo.env);
    git(repo.root, "commit", "-q", "--no-verify", "-m", "chore: 升级\n\n- 刷新规则\n- 生成坑位文件", { ...repo.env, HARNESS_MAIN_BYPASS: "1" });
    const linked = join(realpathSync(repo.root), "..", "task");
    git(repo.root, "worktree", "add", "-q", "-b", "feat/pit", linked, "main");
    const run = (...args) => sh(linked, join(repo.root, ".harness/bin/harness"), args, repo.env);
    for (let i = 0; i < 3; i++) assert.equal(run("pitfall", "add", "--signature", "flaky", "--symptom", "偶发失败", "--fix", "重跑前先清缓存").status, 0);
    git(linked, "add", "-A", repo.env);
    git(linked, "commit", "-q", "--no-verify", "-m", "docs: 记录坑位\n\n- 追加一条坑位\n- 命中三次", repo.env);
    const status = run("status", "--branch", "feat/pit");
    assert.match(status.stdout, /gate: 本次没有改动门禁/);
    assert.match(status.stdout, /pitfalls: .*1 条.*1 条.*flaky/);
    assert.doesNotMatch(status.stdout, /gate_unconfirmed/);
  });

  test("init 生成坑位文件；再次 init 与 upgrade 不覆盖已有内容", () => {
    const repo = makeRepo({ install: false, project: { ".harness/config.json": null, ".harness/policy.json": null, ".harness/verify.json": null } });
    repos.push(repo);
    assert.equal(repo.rawCli("init").status, 0);
    assert.ok(existsSync(join(repo.root, FILE)));
    assert.equal(repo.rawCli("pitfall", "add", "--signature", "keep", "--symptom", "s", "--fix", "f").status, 0);
    const before = readFileSync(join(repo.root, FILE), "utf8");
    assert.equal(repo.rawCli("init").status, 0);
    assert.equal(repo.rawCli("upgrade").status, 0);
    assert.equal(readFileSync(join(repo.root, FILE), "utf8"), before);
  });

  test("托管块引用坑位文件与命令，且不展开细则", () => {
    const repo = setup();
    const agents = readFileSync(join(repo.root, "AGENTS.md"), "utf8");
    const block = agents.slice(agents.indexOf("<!-- harness:start -->"), agents.indexOf("<!-- harness:end -->"));
    assert.match(block, /\.harness\/pitfalls\.md/);
    assert.match(block, /harness pitfall add/);
    assert.doesNotMatch(block, /signature|MAX_ENTRIES|8192/);
  });

  test("默认卸载保留坑位文件", () => {
    const repo = setup();
    add(repo, "stay");
    assert.equal(repo.cli("uninstall").status, 0);
    assert.ok(existsSync(join(repo.root, FILE)));
  });

  test("conformance 的 context 判据：冲突标记与缺字段算问题，正常文件通过", () => {
    const repo = setup();
    add(repo, "ok");
    assert.match(repo.cli("conformance").stdout, /PASS context: 规则入口与托管块齐全/);
    const file = join(repo.root, FILE);
    write(repo.root, FILE, `${readFileSync(file, "utf8")}<<<<<<< HEAD\n=======\n>>>>>>> x\n`);
    const broken = repo.cli("conformance");
    assert.match(broken.stdout, /FAIL context: .*坑位记录.*合并冲突/);
    write(repo.root, FILE, "# 坑位记录\n\n## half\n- 现象: 只有现象\n");
    assert.match(repo.cli("conformance").stdout, /FAIL context: .*half.*做法/);
  });
});
