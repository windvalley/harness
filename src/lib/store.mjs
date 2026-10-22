import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commonDir } from "./git.mjs";

// 运行数据放在共享 git 目录下，所有 Worktree 共用同一份账本；代码不在这里，升级不会丢数据。
export function dataDir(cwd) {
  const dir = process.env.HARNESS_DATA_DIR || join(commonDir(cwd), "harness");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function keyPath() {
  const dir = process.env.HARNESS_KEY_DIR || join(homedir(), ".local", "share", "harness");
  return join(dir, "evidence.key");
}

export function loadKey({ create = true } = {}) {
  const file = keyPath();
  if (!existsSync(file)) {
    if (!create) throw new Error(`缺少证据密钥 ${file}，请先运行 harness install`);
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return readFileSync(file, "utf8").trim();
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function signPayload(payload, key = loadKey()) {
  return createHmac("sha256", key).update(canonical(payload)).digest("hex");
}

export function verifySignature(record) {
  const { signature, ...body } = record;
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
  let secret;
  try {
    secret = loadKey({ create: false });
  } catch {
    return false;
  }
  const expected = Buffer.from(signPayload(body, secret), "hex");
  const actual = Buffer.from(signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function recordPath(cwd, kind, key) {
  if (!/^[0-9A-Za-z._-]+$/.test(key)) throw new Error(`非法记录键: ${key}`);
  const dir = join(dataDir(cwd), kind);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${key}.json`);
}

export function writeRecord(cwd, kind, key, payload) {
  const body = { schema: 2, kind, key, ...payload };
  const record = { ...body, signature: signPayload(body) };
  writeFileSync(recordPath(cwd, kind, key), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function readRecord(cwd, kind, key) {
  const file = recordPath(cwd, kind, key);
  if (!existsSync(file)) return { ok: false, reason: `缺少 ${kind} 记录(${key})` };
  let record;
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, reason: `${kind} 记录无法解析` };
  }
  if (!verifySignature(record)) return { ok: false, reason: `${kind} 记录签名不匹配` };
  if (record.key !== key || record.kind !== kind) {
    return { ok: false, reason: `${kind} 记录与目标不一致` };
  }
  return { ok: true, record };
}

export function anyRecord(cwd, kind, key) {
  return readRecord(cwd, kind, key);
}

export function appendLedger(cwd, event) {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), ...event });
    appendFileSync(join(dataDir(cwd), "ledger.jsonl"), `${line}\n`);
  } catch {
    // 账本只用于度量，写入失败不能影响门禁结果。
  }
}

export function readLedger(cwd) {
  const file = join(dataDir(cwd), "ledger.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
