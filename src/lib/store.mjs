import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commonDir } from "./git.mjs";

const OWNER_FILE = "owner.json";

/**
 * 运行数据放在共享 git 目录下，所有 Worktree 共用同一份账本；代码不在这里，升级不会丢数据。
 * 目录里写一个归属标记：同名目录已被其他工具占用（例如项目原有的门禁）时改用 harness.d，
 * 两边的账本、证据互不混淆，原有工具在退役前也照常工作。选择规则只看标记，结果稳定。
 */
export function dataDir(cwd) {
  if (process.env.HARNESS_DATA_DIR) {
    mkdirSync(process.env.HARNESS_DATA_DIR, { recursive: true });
    return process.env.HARNESS_DATA_DIR;
  }
  const base = commonDir(cwd);
  const primary = join(base, "harness");
  const alternate = join(base, "harness.d");
  const owned = (dir) => existsSync(join(dir, OWNER_FILE));
  let dir;
  if (owned(primary)) dir = primary;
  else if (owned(alternate)) dir = alternate;
  else if (!existsSync(primary) || readdirSync(primary).length === 0 || signedByUs(primary)) dir = primary;
  else dir = alternate;
  mkdirSync(dir, { recursive: true });
  if (!owned(dir)) writeFileSync(join(dir, OWNER_FILE), `${JSON.stringify({ tool: "harness", createdAt: new Date().toISOString() })}\n`);
  return dir;
}

/**
 * 0.3 及以前没有归属标记。目录里有能被本机密钥校验的记录，说明是 harness 自己写的，继续沿用，
 * 升级后进行中的证据与评审不会因为换目录而失效。
 */
function signedByUs(dir) {
  let secret;
  try {
    secret = loadKey({ create: false });
  } catch {
    return false;
  }
  for (const kind of RECORD_KINDS) {
    const sub = join(dir, kind);
    if (!existsSync(sub)) continue;
    for (const name of readdirSync(sub).filter((item) => item.endsWith(".json")).slice(0, 20)) {
      try {
        if (verifySignature(JSON.parse(readFileSync(join(sub, name), "utf8")), secret)) return true;
      } catch {
        // 解析失败的记录不作为判断依据
      }
    }
  }
  return false;
}

/** 同名数据目录是否被其他工具占用，供接入前调查使用，只读。 */
export function foreignDataDir(cwd) {
  if (process.env.HARNESS_DATA_DIR) return null;
  const primary = join(commonDir(cwd), "harness");
  if (!existsSync(primary) || existsSync(join(primary, OWNER_FILE))) return null;
  if (readdirSync(primary).length === 0 || signedByUs(primary)) return null;
  return primary;
}

function keyDir() {
  return process.env.HARNESS_KEY_DIR || join(homedir(), ".local", "share", "harness");
}

export function keyPath() {
  return join(keyDir(), "evidence.key");
}

// 轮换下来的旧密钥放在这里，只为误操作时能由人手工恢复；门禁本身不再读取它们。
export function retiredKeyDir() {
  return join(keyDir(), "retired");
}

const KEY_PATTERN = /^[0-9a-f]{64}$/;

export class KeyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function writeNewKey(file) {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function loadKey({ create = true } = {}) {
  const file = keyPath();
  if (!existsSync(file)) {
    if (!create) throw new KeyError("missing", `缺少证据密钥 ${file}`);
    writeNewKey(file);
  }
  const key = readFileSync(file, "utf8").trim();
  // 空文件或被截断的密钥依然能算出 HMAC，但强度没有保证，宁可报错也不静默使用。
  if (!KEY_PATTERN.test(key)) {
    throw new KeyError("invalid", `证据密钥 ${file} 格式不正确，需要由人运行 harness key rotate --yes 重新生成`);
  }
  return key;
}

/** 密钥指纹写进每条记录，用来区分“记录被改过”和“记录出自另一把密钥”。指纹不泄露密钥本身。 */
export function keyFingerprint(key) {
  return sha256(`harness-evidence-key:${key}`).slice(0, 16);
}

/** 密钥现状，只给出路径、指纹与权限，不返回密钥内容。 */
export function keyStatus() {
  const file = keyPath();
  if (!existsSync(file)) return { file, exists: false };
  const mode = statSync(file).mode & 0o777;
  try {
    return { file, exists: true, valid: true, fingerprint: keyFingerprint(loadKey({ create: false })), mode, private: (mode & 0o077) === 0 };
  } catch (error) {
    return { file, exists: true, valid: false, mode, private: (mode & 0o077) === 0, reason: error.message };
  }
}

/**
 * 轮换密钥：旧密钥移入 retired/，生成新密钥。
 * 此后所有已有的证据、评审与确认都无法通过校验，需要重新生成；这正是轮换的目的。
 */
export function rotateKey({ now = new Date() } = {}) {
  const file = keyPath();
  let retired = null;
  let previous = null;
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8").trim();
    previous = KEY_PATTERN.test(text) ? keyFingerprint(text) : null;
    mkdirSync(retiredKeyDir(), { recursive: true, mode: 0o700 });
    retired = join(retiredKeyDir(), `evidence-${now.toISOString().replace(/[:.]/g, "-")}.key`);
    renameSync(file, retired);
    chmodSync(retired, 0o600);
  }
  writeNewKey(file);
  return { file, retired, previous, fingerprint: keyFingerprint(loadKey({ create: false })) };
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

export function verifySignature(record, secret) {
  const { signature, ...body } = record;
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (secret === undefined) {
    try {
      secret = loadKey({ create: false });
    } catch {
      return false;
    }
  }
  const expected = Buffer.from(signPayload(body, secret), "hex");
  const actual = Buffer.from(signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// 记录失效时告诉人该重跑哪一步，而不是只说“签名不匹配”。
const RERUN = {
  evidence: "harness verify --branch <分支>",
  review: "harness review --branch <分支>",
  confirm: "harness confirm --branch <分支> --yes",
};
export const RECORD_KINDS = Object.keys(RERUN);

function rerunHint(kind) {
  return RERUN[kind] ?? `重新生成 ${kind} 记录`;
}

function recordPath(cwd, kind, key) {
  if (!/^[0-9A-Za-z._-]+$/.test(key)) throw new Error(`非法记录键: ${key}`);
  const dir = join(dataDir(cwd), kind);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${key}.json`);
}

export function writeRecord(cwd, kind, key, payload) {
  const secret = loadKey();
  // keyId 放在最后，调用方的载荷不能覆盖它。
  const body = { schema: 3, kind, key, ...payload, keyId: keyFingerprint(secret) };
  const record = { ...body, signature: signPayload(body, secret) };
  writeFileSync(recordPath(cwd, kind, key), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** 校验一条已解析的记录；code 区分缺密钥、密钥已轮换、签名不符，便于给出对应的恢复方式。 */
export function checkRecord(record, kind, key) {
  let secret;
  try {
    secret = loadKey({ create: false });
  } catch (error) {
    const recover =
      error.code === "missing"
        ? `密钥丢失后旧记录全部作废；重新运行 ${rerunHint(kind)} 会生成新密钥并重新签名`
        : "由人运行 harness key rotate --yes 重新生成密钥后再重跑";
    return { ok: false, code: `key_${error.code ?? "error"}`, reason: `${kind} 记录无法校验: ${error.message}。${recover}` };
  }
  const current = keyFingerprint(secret);
  if (record.keyId && record.keyId !== current) {
    return {
      ok: false,
      code: "key_rotated",
      reason: `${kind} 记录由另一把密钥签发(指纹 ${record.keyId}，当前 ${current})，密钥已轮换或记录来自别的机器。重新运行 ${rerunHint(kind)}`,
    };
  }
  if (!verifySignature(record, secret)) {
    return { ok: false, code: "signature", reason: `${kind} 记录签名不匹配，内容可能被改动过。重新运行 ${rerunHint(kind)}` };
  }
  if (record.key !== key || record.kind !== kind) {
    return { ok: false, code: "mismatch", reason: `${kind} 记录与目标不一致` };
  }
  return { ok: true, record };
}

export function readRecord(cwd, kind, key) {
  const file = recordPath(cwd, kind, key);
  if (!existsSync(file)) return { ok: false, code: "missing", reason: `缺少 ${kind} 记录(${key})` };
  let record;
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, code: "unparsable", reason: `${kind} 记录无法解析` };
  }
  return checkRecord(record, kind, key);
}

/** 统计本仓库里各类记录能否被当前密钥校验，用于轮换前后评估影响面。 */
export function scanRecords(cwd) {
  const summary = { total: 0, ok: 0, byCode: {} };
  for (const kind of RECORD_KINDS) {
    const dir = join(dataDir(cwd), kind);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      summary.total += 1;
      let outcome;
      try {
        outcome = checkRecord(JSON.parse(readFileSync(join(dir, name), "utf8")), kind, name.slice(0, -".json".length));
      } catch {
        outcome = { ok: false, code: "unparsable" };
      }
      if (outcome.ok) summary.ok += 1;
      else summary.byCode[outcome.code] = (summary.byCode[outcome.code] ?? 0) + 1;
    }
  }
  return summary;
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
