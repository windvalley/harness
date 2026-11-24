import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const OWNER = /^(\d+)-[0-9a-f]{24}$/;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}

function unlinkOwner(file) {
  try {
    unlinkSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// 每次竞争先原子登记独立的持有者文件，再检查其他活进程。
// 后登记者一定看得到仍在执行的先登记者；同时退让时随机错开重试。
// 崩溃后只删死亡进程的唯一文件，多个清理者不会删到继任者的锁。
export function withInstallLock(dir, action) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error(`安装锁路径不是普通目录: ${dir}`);
  const deadline = Date.now() + 8000;
  for (;;) {
    const owner = `${process.pid}-${randomBytes(12).toString("hex")}`;
    const file = join(dir, owner);
    closeSync(openSync(file, "wx", 0o600));
    try {
      let busy = false;
      for (const other of readdirSync(dir)) {
        const pid = Number(other.match(OWNER)?.[1]);
        if (other === owner || !Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) continue;
        if (pidAlive(pid)) busy = true;
        else unlinkOwner(join(dir, other));
      }
      if (!busy) return action();
    } finally {
      unlinkOwner(file);
    }
    if (Date.now() >= deadline) throw new Error(`另一个安装操作正在使用 ${dir}，稍后重试`);
    Atomics.wait(waitBuffer, 0, 0, 10 + Math.random() * 50);
  }
}
