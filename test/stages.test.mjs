import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { APPROVE, CONFIG, PACKAGE_ROOT, commit, fakeReviewer, git, makeRepo, sh } from "./helpers.mjs";

let repos = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});

const POLICY = { version: 1, presets: ["secrets", "git-safety", "gate-self", "plan-first"], disabled: [], rules: [] };
const FILE = "docs/changes/alpha/stages.json";
const PLAN = "docs/changes/alpha/plan.md";
const QUOTE = "可以，按方案实施全部阶段";
const STAGE_TEXT = { s1: "- 阶段一验收\n", s2: "- 阶段二验收\n", s3: "- 阶段三验收\n" };
const STAGES = {
  stages: [
    { id: "s1", title: "基础", branch: "feat/alpha-1", acceptance: "docs/changes/alpha/s1.md" },
    { id: "s2", title: "响应", branch: "feat/alpha-2", acceptance: "docs/changes/alpha/s2.md" },
    { id: "s3", title: "降噪", branch: "feat/alpha-3", acceptance: "docs/changes/alpha/s3.md" },
  ],
};
const C1 = "feat/alpha-1";
const D2 = "feat/alpha-2";
const D3 = "feat/alpha-3";
const SESSION = "session-stages";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const acc = (branch) => `.harness/acceptance/${branch.replace(/[^0-9A-Za-z._-]+/g, "-")}.md`;
const code = (lines, name = "v") => `${Array.from({ length: lines }, (_, i) => `export const ${name}${i} = ${i};`).join("\n")}\n`;

function setup(policy = POLICY) {
  const config = { ...CONFIG, intent: { ...CONFIG.intent, plan: { maxLines: 5 } } };
  const repo = makeRepo({ project: { ".harness/config.json": config, ".harness/policy.json": policy } });
  repos.push(repo);
  return repo;
}

/** 携带方案的第一阶段分支：方案、阶段文件、全部阶段清单与本分支清单一起提交。 */
function carrierFiles(overrides = {}) {
  return {
    [PLAN]: "# 实施方案\n",
    [FILE]: json(STAGES),
    "docs/changes/alpha/s1.md": STAGE_TEXT.s1,
    "docs/changes/alpha/s2.md": STAGE_TEXT.s2,
    "docs/changes/alpha/s3.md": STAGE_TEXT.s3,
    [acc(C1)]: STAGE_TEXT.s1,
    "src/alpha1.js": code(2, "a"),
    ...overrides,
  };
}

/** 后续阶段分支：照搬阶段清单作为本分支清单，加上超过阈值的代码。 */
function stageFiles(branch, text, name) {
  return { [acc(branch)]: text, [`src/${name}.js`]: code(10, name) };
}

const approveStages = (repo, branch, ...extra) => repo.cli("approve", "--branch", branch, "--yes", "--note", QUOTE, "--stages", FILE, ...extra);
const derive = (repo, branch, stage, ...extra) => repo.cli("approve", "--branch", branch, "--yes", "--from-stages", FILE, "--stage", stage, ...extra);

function landed(repo, branch) {
  fakeReviewer(repo, APPROVE);
  for (const step of ["verify", "review"]) {
    const result = repo.cli(step, "--branch", branch);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const merged = repo.cli("merge", "--branch", branch);
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  return merged;
}

function grantFiles(repo) {
  const dir = join(repo.env.HARNESS_DATA_DIR, "plan-stages");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => join(dir, name)) : [];
}

function ledger(repo) {
  const file = join(repo.env.HARNESS_DATA_DIR, "ledger.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

const status = (repo, branch) => repo.cli("status", "--branch", branch).stdout;
const approvedLine = /\[ok\] plan: 已有实施授权/;
const stageConfirmation = (stages) => sha(JSON.stringify({
  stagesHash: sha(json({ stages })),
  stage: "s1",
  topLevelContract: null,
  stages: stages.map((item) => ({
    id: item.id,
    acceptance: item.acceptance,
    acceptanceHash: sha(STAGE_TEXT[item.id]),
    contract: null,
    contractHash: null,
  })),
}));

/** 评审读取验收清单时标记的来源：approved 表示任务分支清单有有效授权。 */
function reviewSource(repo, branch) {
  const script = `
    const { readAcceptance } = await import(process.argv[1]);
    const { loadGateProject, mainBranch } = await import(process.argv[2]);
    const project = loadGateProject(process.argv[3], { branch: process.argv[4] });
    console.log(readAcceptance({ project, root: project.root, branch: process.argv[4], mainRef: mainBranch(project) }).source);
  `;
  const args = [pathToFileURL(join(PACKAGE_ROOT, "src/review/review.mjs")).href, pathToFileURL(join(PACKAGE_ROOT, "src/lib/config.mjs")).href, repo.root, branch];
  const result = sh(repo.root, process.execPath, ["--input-type=module", "-e", script, ...args], repo.env);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function hook(repo, args, payload) {
  return sh(repo.root, join(repo.root, ".harness/bin/harness"), ["hook", "--client", "claude", ...args], repo.env, JSON.stringify(payload));
}

/** 会话经手某个分支：和 Agent 一样经实时拦截运行一条推进交付的命令。 */
function touch(repo, branch, session = SESSION) {
  const result = hook(repo, [], { session_id: session, cwd: repo.root, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `.harness/bin/harness verify --branch ${branch}` } });
  assert.equal(result.status, 0, result.stderr);
}

function stop(repo, session = SESSION) {
  const result = hook(repo, ["--event", "stop"], { session_id: session, cwd: repo.root, hook_event_name: "Stop", stop_hook_active: false, transcript_path: null });
  assert.equal(result.status, 0, result.stderr);
  const text = result.stdout.trim();
  return text ? JSON.parse(text) : null;
}

/** 第一阶段授权并合入，返回仓库，供后续阶段的用例使用。 */
function carrierLanded() {
  const repo = setup();
  repo.branch(C1, carrierFiles());
  const approved = approveStages(repo, C1);
  assert.equal(approved.status, 0, approved.stderr);
  landed(repo, C1);
  return repo;
}

describe("多阶段方案授权", () => {
  test("没有阶段文件时，普通授权与 status 不出现阶段逻辑", () => {
    const repo = setup();
    repo.branch("feat/plain", { [acc("feat/plain")]: "- 普通任务\n", "src/plain.js": code(10) });
    assert.equal(repo.cli("approve", "--branch", "feat/plain", "--yes", "--note", QUOTE).status, 0);
    const text = status(repo, "feat/plain");
    assert.match(text, approvedLine);
    assert.doesNotMatch(text, /stages:/);
    assert.equal(grantFiles(repo).length, 0);
    assert.equal(ledger(repo).filter((event) => event.event === "plan.approve" && event.stages).length, 0);
  });

  test("approve --stages 记录原话、阶段文件与各阶段清单哈希和携带阶段；按文件路径做键，重新授权覆盖并在账本留痕", () => {
    const repo = setup();
    repo.branch(C1, carrierFiles());
    const approved = approveStages(repo, C1);
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(approved.stdout, /全部 3 个阶段/);
    assert.match(approved.stdout, /对应阶段 s1/);

    const files = grantFiles(repo);
    assert.equal(files.length, 1);
    const grant = JSON.parse(readFileSync(files[0], "utf8"));
    assert.equal(grant.file, FILE);
    assert.equal(grant.note, QUOTE);
    assert.equal(grant.stagesHash, sha(json(STAGES)));
    assert.deepEqual(grant.stages.map((stage) => [stage.id, stage.acceptanceHash]), [
      ["s1", sha(STAGE_TEXT.s1)],
      ["s2", sha(STAGE_TEXT.s2)],
      ["s3", sha(STAGE_TEXT.s3)],
    ]);
    assert.deepEqual(grant.carrier, { branch: C1, stage: "s1" });

    const text = status(repo, C1);
    assert.match(text, approvedLine);
    assert.match(text, /\[-\] stages: 方案 docs\/changes\/alpha\/stages\.json：本分支是阶段 s1，已合入 0\/3 个阶段，下一阶段 s2（响应）/);

    const again = repo.cli("approve", "--branch", C1, "--yes", "--note", "同意，重新授权", "--stages", FILE);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(grantFiles(repo).length, 1, "同一份方案只有一条当前记录");
    assert.equal(JSON.parse(readFileSync(files[0], "utf8")).note, "同意，重新授权");
    const events = ledger(repo).filter((event) => event.event === "plan.approve" && event.stages === FILE);
    assert.equal(events.length, 2, "每次授权都在账本留痕");
    assert.deepEqual([events[0].stage, events[0].role], ["s1", "carrier"]);
  });

  test("多阶段核心契约允许阶段验收细化，派生阶段仍绑定各自契约", () => {
    const repo = setup();
    const contracts = Object.fromEntries(STAGES.stages.map((item) => [item.id, `docs/changes/alpha/${item.id}-contract.md`]));
    const staged = { stages: STAGES.stages.map((item) => ({ ...item, contract: contracts[item.id] })) };
    repo.branch(C1, carrierFiles({
      [FILE]: json(staged),
      ...Object.fromEntries(Object.values(contracts).map((path) => [path, "# 核心契约\n\n- 保持权限边界\n"])),
    }));
    assert.equal(approveStages(repo, C1).status, 0);
    const carrierGrant = JSON.parse(readFileSync(join(repo.env.HARNESS_DATA_DIR, "plan", "feat-alpha-1.json"), "utf8"));
    assert.equal(carrierGrant.contractPath, contracts.s1, "首阶段绑定阶段文件指定的契约");
    assert.equal(carrierGrant.contractHash, sha("# 核心契约\n\n- 保持权限边界\n"));
    landed(repo, C1);

    repo.branch(D2, {
      ...stageFiles(D2, STAGE_TEXT.s2, "alpha2"),
      [contracts.s2]: "# 核心契约\n\n- 保持权限边界\n",
    });
    assert.equal(derive(repo, D2, "s2").status, 0);
    git(repo.root, "checkout", "-q", D2);
    commit(repo.root, "docs(alpha): 细化阶段验收\n\n- 保持核心契约不变", { [acc(D2)]: "- 阶段二验收\n- 失败时可以重试\n" });
    git(repo.root, "checkout", "-q", "main");
    assert.match(status(repo, D2), approvedLine);

    git(repo.root, "checkout", "-q", D2);
    commit(repo.root, "docs(alpha): 调整阶段契约\n\n- 需要重新确认", { [contracts.s2]: "# 核心契约\n\n- 改为扩大权限\n" });
    git(repo.root, "checkout", "-q", "main");
    assert.match(status(repo, D2), /核心授权契约在授权后改过/);
  });

  test("approve --stages 拒绝阶段 id 重复、阶段文件或阶段清单未提交、路径不在约定里与未知阶段", () => {
    const repo = setup();
    const duplicate = { stages: [STAGES.stages[0], { ...STAGES.stages[1], id: "s1" }] };
    repo.branch("feat/dup", carrierFiles({ [FILE]: json(duplicate), [acc("feat/dup")]: STAGE_TEXT.s1 }));
    const dup = approveStages(repo, "feat/dup");
    assert.notEqual(dup.status, 0);
    assert.match(dup.stderr, /阶段 id 重复: s1/);

    const missing = carrierFiles({ [acc("feat/missing")]: STAGE_TEXT.s1 });
    delete missing["docs/changes/alpha/s3.md"];
    repo.branch("feat/missing", missing);
    const noAcceptance = approveStages(repo, "feat/missing");
    assert.notEqual(noAcceptance.status, 0);
    assert.match(noAcceptance.stderr, /阶段 s3 的验收清单 docs\/changes\/alpha\/s3\.md 还没有提交到分支/);

    repo.branch("feat/nofile", { [PLAN]: "# 方案\n", [acc("feat/nofile")]: STAGE_TEXT.s1 });
    const noFile = approveStages(repo, "feat/nofile");
    assert.notEqual(noFile.status, 0);
    assert.match(noFile.stderr, /阶段文件 docs\/changes\/alpha\/stages\.json 还没有提交到分支/);

    const outside = repo.cli("approve", "--branch", "feat/dup", "--yes", "--note", QUOTE, "--stages", "docs/stages.json");
    assert.notEqual(outside.status, 0);
    assert.match(outside.stderr, /intent\.plan\.stages/);

    repo.branch(C1, carrierFiles());
    const unknown = approveStages(repo, C1, "--stage", "s9");
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /没有阶段 s9/);
    assert.equal(grantFiles(repo).length, 0, "拒绝时不写记录");
  });

  test("建议分支名不符合当前命名规则时只提示，不拒绝", () => {
    const rule = { id: "branch-name", kind: "branch-name", pattern: "^(feat|fix|docs)/[a-z0-9-]+$", reason: "分支用类型前缀", fix: "改用 feat/<任务>" };
    const repo = setup({ ...POLICY, rules: [rule] });
    const named = { stages: [STAGES.stages[0], { ...STAGES.stages[1], branch: "Alpha_Two" }, STAGES.stages[2]] };
    repo.branch(C1, carrierFiles({ [FILE]: json(named) }));
    const approved = approveStages(repo, C1);
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(approved.stderr, /阶段 s2 的建议分支名 Alpha_Two 不符合当前分支命名规则/);
  });

  test("approve --from-stages 不接受 --note，照搬原话并注明阶段；拒绝主分支阶段文件不一致、清单不一致与前序阶段未合入；改名后仍可派生", () => {
    const repo = setup();
    repo.branch(C1, carrierFiles());
    assert.equal(approveStages(repo, C1).status, 0);
    repo.branch("feat/early", stageFiles("feat/early", STAGE_TEXT.s2, "early"));
    const early = derive(repo, "feat/early", "s2");
    assert.notEqual(early.status, 0);
    assert.match(early.stderr, /主分支上的阶段文件 docs\/changes\/alpha\/stages\.json 与方案授权时不一致或不存在/);
    landed(repo, C1);

    repo.branch(D2, stageFiles(D2, STAGE_TEXT.s2, "beta"));
    const withNote = derive(repo, D2, "s2", "--note", "同意");
    assert.notEqual(withNote.status, 0);
    assert.match(withNote.stderr, /--from-stages 不接受 --note/);

    repo.branch(D3, stageFiles(D3, STAGE_TEXT.s3, "gamma"));
    const tooEarly = derive(repo, D3, "s3");
    assert.notEqual(tooEarly.status, 0);
    assert.match(tooEarly.stderr, /前序阶段 s2 还没有合入主分支/);

    repo.branch("feat/alpha-2b", stageFiles("feat/alpha-2b", "- 改过的阶段二\n", "delta"));
    const changed = derive(repo, "feat/alpha-2b", "s2");
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /验收清单 \.harness\/acceptance\/feat-alpha-2b\.md 与阶段 s2 授权时的清单 docs\/changes\/alpha\/s2\.md 不一致/);

    const renamed = "fix/alpha-two";
    repo.branch(renamed, stageFiles(renamed, STAGE_TEXT.s2, "epsilon"));
    const derived = derive(repo, renamed, "s2");
    assert.equal(derived.status, 0, derived.stderr);
    assert.match(derived.stdout, new RegExp(`已按方案 docs/changes/alpha/stages\\.json 的授权记录 ${renamed} 的阶段 s2 授权（依据：${QUOTE}；验收清单 \\.harness/acceptance/fix-alpha-two\\.md）`));
    assert.match(status(repo, renamed), new RegExp(`已有实施授权.*依据：${QUOTE}`));
    const event = ledger(repo).filter((item) => item.event === "plan.approve").at(-1);
    assert.deepEqual([event.branch, event.stages, event.stage, event.role], [renamed, FILE, "s2", "derived"]);

    landed(repo, renamed);
    const third = derive(repo, D3, "s3");
    assert.equal(third.status, 0, third.stderr);
  });

  test("阶段分支合并后被删除，按账本里的本地合并或远程推送记录认定已合入", () => {
    const repo = carrierLanded();
    git(repo.root, "branch", "-D", C1);
    repo.branch(D2, stageFiles(D2, STAGE_TEXT.s2, "beta"));
    const second = derive(repo, D2, "s2");
    assert.equal(second.status, 0, second.stderr);

    landed(repo, D2);
    git(repo.root, "branch", "-D", D2);
    // 远程交付只有推送记录，由平台合入：把本地合并记录换成推送记录。
    const file = join(repo.env.HARNESS_DATA_DIR, "ledger.jsonl");
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const rewritten = lines.map((event) => (event.event === "merge" && event.branch === D2 ? { at: event.at, event: "submit.push", branch: D2, head: event.head, remote: "origin" } : event));
    writeFileSync(file, `${rewritten.map((event) => JSON.stringify(event)).join("\n")}\n`);
    repo.branch(D3, stageFiles(D3, STAGE_TEXT.s3, "gamma"));
    const third = derive(repo, D3, "s3");
    assert.equal(third.status, 0, third.stderr);
  });

  test("携带分支授权后改了阶段文件或任一阶段清单，status、merge、评审与收尾检查一致判为未授权", () => {
    const repo = setup();
    repo.branch(C1, carrierFiles());
    assert.equal(approveStages(repo, C1).status, 0);
    touch(repo, C1);
    assert.equal(reviewSource(repo, C1), "approved");
    assert.equal(stop(repo)?.decision, "block", "授权有效时缺验证要接着做");

    git(repo.root, "checkout", "-q", C1);
    const edited = { stages: [{ ...STAGES.stages[0], title: "基础（改）" }, ...STAGES.stages.slice(1)] };
    writeFileSync(join(repo.root, FILE), json(edited));
    git(repo.root, "commit", "-q", "-am", "docs(alpha): 调整阶段\n\n- 修改阶段标题");
    git(repo.root, "checkout", "-q", "main");
    let text = status(repo, C1);
    assert.match(text, /待实施授权/);
    assert.match(text, /方案材料在授权后改过，需要向用户说明并重新授权/);
    fakeReviewer(repo, APPROVE);
    assert.equal(repo.cli("verify", "--branch", C1).status, 0);
    assert.equal(repo.cli("review", "--branch", C1).status, 0);
    const refused = repo.cli("merge", "--branch", C1);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /plan_unapproved/);
    assert.notEqual(reviewSource(repo, C1), "approved");
    assert.equal(stop(repo), null, "失效后等用户重新授权，收尾检查放行");

    const rejectedReapproval = approveStages(repo, C1);
    assert.notEqual(rejectedReapproval.status, 0);
    const preserved = JSON.parse(readFileSync(grantFiles(repo)[0], "utf8"));
    assert.equal(preserved.stagesHash, sha(json(STAGES)), "未确认新契约前不能覆盖旧方案授权");
    assert.equal(approveStages(repo, C1, "--confirm-contract", stageConfirmation(edited.stages)).status, 0);
    assert.match(status(repo, C1), approvedLine);
    git(repo.root, "checkout", "-q", C1);
    writeFileSync(join(repo.root, "docs/changes/alpha/s3.md"), "- 阶段三验收（改）\n");
    git(repo.root, "commit", "-q", "-am", "docs(alpha): 调整阶段三\n\n- 修改阶段三清单");
    git(repo.root, "checkout", "-q", "main");
    text = status(repo, C1);
    assert.match(text, /待实施授权/);
    assert.match(text, /方案材料在授权后改过/);
  });

  test("只交换阶段顺序时指出顺序变化，不当成排版变化", () => {
    const repo = setup();
    repo.branch(C1, carrierFiles());
    assert.equal(approveStages(repo, C1).status, 0);

    git(repo.root, "checkout", "-q", C1);
    // 字段都不动，只把 s1 与 s2 的位置对调：阶段派生按数组顺序检查前序是否已合入。
    writeFileSync(join(repo.root, FILE), json({ stages: [STAGES.stages[1], STAGES.stages[0], STAGES.stages[2]] }));
    git(repo.root, "commit", "-q", "-am", "docs(alpha): 调整阶段顺序\n\n- 交换前两个阶段\n- 字段不变");
    git(repo.root, "checkout", "-q", "main");

    const text = status(repo, C1);
    assert.match(text, /阶段顺序由 s1 -> s2 -> s3 改为 s2 -> s1 -> s3/, "换序改变交付条件，不能报成无关改动");
    assert.doesNotMatch(text, /只有排版或无关字段变化/);
  });

  test("在开头插入新阶段时只报告新增，不误报顺序变化", () => {
    const repo = setup();
    repo.branch(C1, carrierFiles());
    assert.equal(approveStages(repo, C1).status, 0);

    git(repo.root, "checkout", "-q", C1);
    const inserted = {
      stages: [
        { id: "s0", title: "准备", branch: "feat/alpha-0", acceptance: "docs/changes/alpha/s0.md" },
        ...STAGES.stages,
      ],
    };
    writeFileSync(join(repo.root, FILE), json(inserted));
    writeFileSync(join(repo.root, "docs/changes/alpha/s0.md"), "- 阶段零验收\n");
    git(repo.root, "add", "-A");
    git(repo.root, "commit", "-q", "-m", "docs(alpha): 增加前置阶段\n\n- 新增 s0\n- 其余顺序不变");
    git(repo.root, "checkout", "-q", "main");

    const text = status(repo, C1);
    assert.match(text, /新增阶段 s0/);
    assert.doesNotMatch(text, /阶段顺序由/, "共有阶段的相对顺序没变");
  });

  test("派生分支的清单改动、来源记录缺失或被改动时判为未授权，改回后恢复", () => {
    const repo = carrierLanded();
    repo.branch(D2, stageFiles(D2, STAGE_TEXT.s2, "beta"));
    assert.equal(derive(repo, D2, "s2").status, 0);
    assert.match(status(repo, D2), approvedLine);
    assert.equal(reviewSource(repo, D2), "approved");

    git(repo.root, "checkout", "-q", D2);
    writeFileSync(join(repo.root, acc(D2)), "- 阶段二验收（改）\n");
    git(repo.root, "commit", "-q", "-am", "docs(alpha): 调整清单\n\n- 修改本分支清单");
    git(repo.root, "checkout", "-q", "main");
    assert.match(status(repo, D2), /待实施授权/);
    git(repo.root, "checkout", "-q", D2);
    writeFileSync(join(repo.root, acc(D2)), STAGE_TEXT.s2);
    git(repo.root, "commit", "-q", "-am", "docs(alpha): 改回清单\n\n- 恢复本分支清单");
    git(repo.root, "checkout", "-q", "main");
    assert.match(status(repo, D2), approvedLine, "改回授权过的内容后恢复");

    const [file] = grantFiles(repo);
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace(/"approvedAt": "[^"]+"/, '"approvedAt": "2000-01-01T00:00:00.000Z"'));
    let text = status(repo, D2);
    assert.match(text, /待实施授权/);
    assert.match(text, /阶段授权记录无效/);
    rmSync(file);
    text = status(repo, D2);
    assert.match(text, /待实施授权/);
    assert.match(text, /阶段授权记录无效/);
    writeFileSync(file, original);
    assert.match(status(repo, D2), approvedLine);
  });

  test("重新授权只改一个阶段：改动阶段的派生授权失效，未改阶段的保持有效；改回原内容后恢复；旧携带分支失效；不依赖授权时间", () => {
    const repo = carrierLanded();
    repo.branch(D2, stageFiles(D2, STAGE_TEXT.s2, "beta"));
    assert.equal(derive(repo, D2, "s2").status, 0);

    const revise = (branch, files, stage, note) => {
      repo.branch(branch, { [PLAN]: `# 实施方案（${branch}）\n`, ...files, [acc(branch)]: `- ${branch}\n` });
      const result = repo.cli("approve", "--branch", branch, "--yes", "--note", note, "--stages", FILE, "--stage", stage);
      assert.equal(result.status, 0, result.stderr);
    };

    revise("docs/revise-a", { "docs/changes/alpha/s3.md": "- 阶段三验收（修订）\n" }, "s3", "同意修订阶段三");
    assert.match(status(repo, D2), approvedLine, "只改了阶段三，阶段二的派生授权不受影响");
    assert.match(status(repo, "docs/revise-a"), approvedLine);

    revise("docs/revise-b", { "docs/changes/alpha/s2.md": "- 阶段二验收（修订）\n" }, "s2", "同意修订阶段二");
    let text = status(repo, D2);
    assert.match(text, /待实施授权/);
    assert.match(text, /阶段 s2 的验收清单与方案授权不一致/);
    text = status(repo, "docs/revise-a");
    assert.match(text, /待实施授权/);
    assert.match(text, /已在分支 docs\/revise-b 重新授权/);

    revise("docs/revise-c", {}, "s2", "同意恢复阶段二");
    assert.match(status(repo, D2), approvedLine, "阶段二改回授权过的内容后恢复");
  });
});

describe("多阶段方案的收尾检查", () => {
  test("阶段合入后下一阶段没有分支时给出续跑欠项；下一阶段有未交付分支时提示接着完成；全部合入后放行", () => {
    const repo = setup();
    repo.branch(C1, carrierFiles());
    assert.equal(approveStages(repo, C1).status, 0);
    touch(repo, C1);
    landed(repo, C1);

    let owed = stop(repo);
    assert.equal(owed?.decision, "block");
    assert.match(owed.reason, /feat\/alpha-1：方案 docs\/changes\/alpha\/stages\.json 还有后续阶段 s2（响应）没有开始/);
    assert.match(owed.reason, /从 main 创建分支 feat\/alpha-2/);
    assert.match(owed.reason, /把 docs\/changes\/alpha\/s2\.md 复制为该分支的验收清单 \.harness\/acceptance\/feat-alpha-2\.md 并提交/);
    assert.match(owed.reason, /harness approve --branch feat\/alpha-2 --yes --from-stages docs\/changes\/alpha\/stages\.json --stage s2/);
    assert.match(status(repo, C1), /\[-\] stages: 方案 docs\/changes\/alpha\/stages\.json：本分支是阶段 s1，已合入 1\/3 个阶段，下一阶段 s2（响应）/);

    repo.branch(D2, stageFiles(D2, STAGE_TEXT.s2, "beta"));
    assert.equal(derive(repo, D2, "s2").status, 0);
    owed = stop(repo);
    assert.equal(owed?.decision, "block");
    assert.match(owed.reason, /下一阶段 s2 在分支 feat\/alpha-2 上还没有交付；下一步 接着完成分支 feat\/alpha-2：harness status --branch feat\/alpha-2/);

    landed(repo, D2);
    owed = stop(repo);
    assert.equal(owed?.decision, "block");
    assert.match(owed.reason, /还有后续阶段 s3（降噪）没有开始/);

    repo.branch(D3, stageFiles(D3, STAGE_TEXT.s3, "gamma"));
    assert.equal(derive(repo, D3, "s3").status, 0);
    landed(repo, D3);
    assert.equal(stop(repo), null, "全部阶段合入后放行");
    assert.match(status(repo, C1), /已合入 3\/3 个阶段，全部阶段已合入/);
  });

  test("方案级授权失效时不生成续跑欠项，放行并提示需要用户重新授权；与其他分支的欠项一起列出", () => {
    const repo = carrierLanded();
    touch(repo, C1);
    const [file] = grantFiles(repo);
    const original = readFileSync(file, "utf8");
    rmSync(file);
    const released = stop(repo);
    assert.equal(released?.decision, undefined, "要人重新授权，不拦");
    assert.match(released.systemMessage, /feat\/alpha-1/);
    assert.match(released.systemMessage, /阶段授权记录无效/);
    assert.match(released.systemMessage, /需要用户重新授权/);
    assert.equal(stop(repo), null, "同一提示不重复");

    const other = "session-other";
    touch(repo, C1, other);
    repo.branch("feat/other", { "src/other.js": code(2, "o") });
    touch(repo, "feat/other", other);
    const both = stop(repo, other);
    assert.equal(both?.decision, "block");
    assert.match(both.reason, /feat\/other：还差/);
    assert.match(both.reason, /另外需要用户处理：.*feat\/alpha-1.*需要用户重新授权/);

    writeFileSync(file, original);
    repo.branch("docs/alpha-tweak", { [FILE]: json({ stages: [...STAGES.stages, { id: "s4", title: "分析", branch: "feat/alpha-4", acceptance: "docs/changes/alpha/s3.md" }] }) });
    landed(repo, "docs/alpha-tweak");
    const third = "session-third";
    touch(repo, C1, third);
    const changed = stop(repo, third);
    assert.equal(changed?.decision, undefined);
    assert.match(changed.systemMessage, /主分支上的阶段文件与授权时不一致/);
  });

  test("提示问题消除后再出现时重新提示", () => {
    const repo = carrierLanded();
    touch(repo, C1);
    const [file] = grantFiles(repo);
    const original = readFileSync(file, "utf8");
    rmSync(file);
    assert.match(stop(repo)?.systemMessage ?? "", /需要用户重新授权/);
    assert.equal(stop(repo), null);
    writeFileSync(file, original);
    assert.equal(stop(repo)?.decision, "block", "授权恢复后回到下一阶段的欠项");
    rmSync(file);
    assert.match(stop(repo)?.systemMessage ?? "", /需要用户重新授权/, "同一问题再次出现时重新提示");
  });

  test("阶段分支合并后被删除，收尾检查仍给出下一阶段", () => {
    const repo = setup();
    repo.branch(C1, carrierFiles());
    assert.equal(approveStages(repo, C1).status, 0);
    touch(repo, C1);
    landed(repo, C1);
    git(repo.root, "branch", "-D", C1);
    const owed = stop(repo);
    assert.equal(owed?.decision, "block");
    assert.match(owed.reason, /feat\/alpha-1：方案 docs\/changes\/alpha\/stages\.json 还有后续阶段 s2（响应）没有开始/);

    repo.branch("feat/dropped", { [acc("feat/dropped")]: STAGE_TEXT.s2, "src/dropped.js": code(10, "z") });
    assert.equal(derive(repo, "feat/dropped", "s2").status, 0);
    touch(repo, "feat/dropped", "session-dropped");
    git(repo.root, "branch", "-D", "feat/dropped");
    assert.equal(stop(repo, "session-dropped"), null, "没合入就删掉的阶段分支不提示下一阶段");
  });

  test("全部阶段合入后主分支再改阶段文件，不再提示重新授权", () => {
    const repo = carrierLanded();
    for (const [branch, stage, name] of [[D2, "s2", "beta"], [D3, "s3", "gamma"]]) {
      repo.branch(branch, stageFiles(branch, STAGE_TEXT[stage], name));
      assert.equal(derive(repo, branch, stage).status, 0);
      landed(repo, branch);
    }
    repo.branch("docs/alpha-done", { [FILE]: json({ ...STAGES, note: "全部完成" }) });
    landed(repo, "docs/alpha-done");
    touch(repo, C1);
    assert.equal(stop(repo), null);
    const text = status(repo, C1);
    assert.match(text, /\[-\] stages: .*已合入 3\/3 个阶段，全部阶段已合入/);
  });

  test("阶段信息读取出错时，status 降级为一行提示，收尾检查记录诊断并照常核对其他分支", () => {
    const repo = carrierLanded();
    const dir = join(repo.env.HARNESS_DATA_DIR, "plan-stages");
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "not a directory\n");
    const result = repo.cli("status", "--branch", C1);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[!!\] stages: 无法读取方案 docs\/changes\/alpha\/stages\.json 的进度/);

    repo.branch("feat/other", { "src/other.js": code(2, "o") });
    touch(repo, C1);
    touch(repo, "feat/other");
    const owed = stop(repo);
    assert.equal(owed?.decision, "block");
    assert.match(owed.reason, /feat\/other：还差/);
    assert.ok(ledger(repo).some((event) => event.event === "stop.error" && event.branch === C1), "出错的分支记诊断");
  });
});

describe("多阶段方案的授权交互", () => {
  test("未授权时只读摘要请用户在对话中授权，命令由 Agent 执行", () => {
    const repo = setup();
    repo.branch(C1, carrierFiles());
    const before = grantFiles(repo).length;
    const result = repo.cli("approve", "--branch", C1, "--stages", FILE);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /用户在对话中明确同意/);
    assert.match(result.stdout, /全部阶段/);
    assert.match(result.stdout, /由 Agent 执行：harness approve --branch feat\/alpha-1 --yes --note "<用户原话>" --stages docs\/changes\/alpha\/stages\.json/);
    assert.match(result.stdout, /用户无需执行命令/);
    assert.equal(grantFiles(repo).length, before, "只读摘要不得写入授权记录");
    const waiting = status(repo, C1);
    assert.match(waiting, /由 Agent 执行：harness approve/);
    assert.match(waiting, /用户无需执行命令/);
  });

  test("阶段派生预览明确 Agent 可继承已有授权直接执行", () => {
    const repo = carrierLanded();
    repo.branch(D2, stageFiles(D2, STAGE_TEXT.s2, "beta"));
    const result = repo.cli("approve", "--branch", D2, "--from-stages", FILE, "--stage", "s2");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Agent 可直接继续执行：harness approve --branch feat\/alpha-2 --yes --from-stages docs\/changes\/alpha\/stages\.json --stage s2/);
    assert.match(result.stdout, /无需用户再次授权/);
  });
});
