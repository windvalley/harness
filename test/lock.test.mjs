import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { acquireLock } from "../src/merge/merge.mjs";

const MERGE_MODULE = fileURLToPath(new URL("../src/merge/merge.mjs", import.meta.url));

let dir;
let previous;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-lock-"));
  previous = process.env.HARNESS_DATA_DIR;
  process.env.HARNESS_DATA_DIR = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.HARNESS_DATA_DIR;
  else process.env.HARNESS_DATA_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

const lockFile = () => join(dir, "merge.lock");
const refusedWith = (code) => (error) => error.code === code;

/** 已经退出的进程号：用来表示崩溃的持有者。 */
async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid;
}

describe("合并锁", () => {
  test("持有期间别的获取者被拒绝，释放后可以再取", () => {
    const release = acquireLock(dir);
    assert.throws(() => acquireLock(dir), refusedWith("merge_locked"));
    release();
    assert.equal(existsSync(lockFile()), false);
    acquireLock(dir)();
  });

  test("持有者进程已不存在时接管失效的锁", async () => {
    writeFileSync(lockFile(), `${await deadPid()}\n`);
    const release = acquireLock(dir);
    assert.match(readFileSync(lockFile(), "utf8"), new RegExp(`^${process.pid}\\n`));
    release();
  });

  test("刚创建、还读不出进程号的锁按持有中处理，不清理", () => {
    writeFileSync(lockFile(), "");
    assert.throws(() => acquireLock(dir), refusedWith("merge_locked"));
    assert.equal(readFileSync(lockFile(), "utf8"), "", "空锁文件原样保留，不被当作失效锁删掉");
  });

  test("读不出进程号的锁超过宽限时间后才算失效", () => {
    writeFileSync(lockFile(), "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile(), old, old);
    acquireLock(dir)();
  });

  test("释放只删自己的锁：锁已被别人接管时保持原样", () => {
    const release = acquireLock(dir);
    writeFileSync(lockFile(), `${process.pid}\nsomeone-else\n`);
    release();
    assert.equal(readFileSync(lockFile(), "utf8"), `${process.pid}\nsomeone-else\n`);
  });

  test("遗留的接管守卫超时后会被清掉，不会卡住获取", async () => {
    writeFileSync(lockFile(), `${await deadPid()}\n`);
    const guard = `${lockFile()}.takeover`;
    writeFileSync(guard, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(guard, old, old);
    acquireLock(dir)();
    assert.equal(existsSync(guard), false);
  });

  test("多个进程同时抢失效的锁，同一时刻只有一个拿到", async () => {
    writeFileSync(lockFile(), `${await deadPid()}\n`);
    const script = `
      const { acquireLock } = await import(${JSON.stringify(MERGE_MODULE)});
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await wait(Number(process.argv[1]) - Date.now());
      try {
        const release = acquireLock(process.env.HARNESS_DATA_DIR);
        console.log("got " + Date.now());
        await wait(300);
        release();
      } catch (error) {
        console.log("refused " + error.code);
      }
    `;
    const start = Date.now() + 800;
    const runs = Array.from({ length: 8 }, () =>
      new Promise((resolve) => {
        let out = "";
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, String(start)], { env: { ...process.env, HARNESS_DATA_DIR: dir } });
        child.stdout.on("data", (chunk) => (out += chunk));
        child.on("exit", () => resolve(out.trim()));
      }),
    );
    const results = await Promise.all(runs);
    const got = results.filter((line) => line.startsWith("got"));
    assert.equal(got.length, 1, `只能有一个进程拿到锁: ${results.join(" | ")}`);
    assert.ok(results.filter((line) => line !== got[0]).every((line) => line === "refused merge_locked"), results.join(" | "));
  });
});
