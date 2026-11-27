import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { redact } from "../lib/redact.mjs";
import { existingDataDir } from "../lib/store.mjs";
import { observabilityRoot } from "./projects.mjs";

const KNOWN_EVENTS = new Set([
  "attest", "confirm.approve", "escalate.answer", "escalate.open", "escalate.resolve", "golden", "merge", "merge.post_failed",
  "merge.push_failed", "merge.push_skipped", "merge.pushed", "obligation.close", "plan.amend", "plan.approve", "plan.review",
  "policy.deny", "review", "review.preflight", "stop.block", "stop.error", "stop.unresolved", "submit.push", "submit.ready",
  "sync", "verify", "verify.targeted", "worktree.clean",
]);

const FIELDS = new Set([
  "schema", "id", "at", "event", "projectId", "outcome", "harnessVersion", "branch", "branches", "taskId", "tree", "head",
  "base", "baseCommit", "status", "mode", "checks", "executed", "reused", "failed", "durationMs", "checkId", "source",
  "verdict", "rejectionReasons", "findings", "blocking", "backend", "reviewer", "model", "costUsd", "reviewMode", "chunks",
  "rule", "tool", "client", "approvalKind", "commit", "acceptanceHash", "stages", "stage", "role", "passRate", "passed",
  "total", "skipped", "failedIds", "fastForward", "bootstrap", "mainRef", "remote", "from", "to", "gateFiles", "riskSignals",
  "riskObserved", "code", "exit", "current", "recovered", "pushed", "closed", "definitionFrom", "phase", "choice",
  "trigger", "missing", "blocks", "removed", "pending", "hasPostMergeAcceptance", "hadAcceptance",
]);

function clean(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => ["id", "code"].includes(key)).map(([key, item]) => [key, clean(item)]));
  }
  return value;
}

function publicEvent(event) {
  return Object.fromEntries(Object.entries(event).filter(([key]) => FIELDS.has(key)).map(([key, value]) => [key, clean(value)]));
}

export function findDataDir(cwd) {
  return existingDataDir(cwd);
}

function emptyCoverage(file) {
  return {
    file,
    exists: false,
    totalLines: 0,
    parsedEvents: 0,
    invalidLines: 0,
    invalidTimestamps: 0,
    legacyEvents: 0,
    duplicateEvents: 0,
    unknownEvents: 0,
    firstEventAt: null,
    lastEventAt: null,
    bytes: 0,
    mtimeMs: null,
  };
}

function newState(file) {
  return { file, events: [], warnings: [], coverage: emptyCoverage(file), seenIds: new Set() };
}

function cachedState(cached) {
  const state = newState(cached.file);
  state.events = cached.events;
  state.warnings = cached.warnings;
  state.coverage = { ...cached.coverage };
  state.seenIds = new Set(state.events.map((event) => event.id).filter(Boolean));
  return state;
}

function parseText(text, state) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const lineNumber = state.coverage.totalLines + 1;
    state.coverage.totalLines = lineNumber;
    let raw;
    try {
      raw = JSON.parse(line);
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.event !== "string") throw new Error("invalid event");
    } catch {
      state.coverage.invalidLines += 1;
      state.warnings.push({ code: "ledger_line_invalid", line: lineNumber });
      continue;
    }
    if (typeof raw.at !== "string" || !Number.isFinite(Date.parse(raw.at))) {
      state.coverage.invalidTimestamps += 1;
      state.warnings.push({ code: "ledger_timestamp_invalid", line: lineNumber });
      continue;
    }
    if (!raw.id) state.coverage.legacyEvents += 1;
    else if (state.seenIds.has(raw.id)) {
      state.coverage.duplicateEvents += 1;
      continue;
    } else state.seenIds.add(raw.id);
    if (!KNOWN_EVENTS.has(raw.event)) state.coverage.unknownEvents += 1;
    const event = publicEvent(raw);
    state.events.push(event);
    if (!state.coverage.firstEventAt || event.at < state.coverage.firstEventAt) state.coverage.firstEventAt = event.at;
    if (!state.coverage.lastEventAt || event.at > state.coverage.lastEventAt) state.coverage.lastEventAt = event.at;
  }
  state.coverage.parsedEvents = state.events.length;
}

function cacheFile(file, projectId) {
  const key = createHash("sha256").update(`${projectId ?? ""}\0${file}`).digest("hex");
  return join(observabilityRoot(), "ledger-cache", `${key}.json`);
}

function readCache(file) {
  try {
    const cached = JSON.parse(readFileSync(file, "utf8"));
    if (cached.schema !== 1 || !Array.isArray(cached.events) || !Array.isArray(cached.warnings) || !cached.coverage) return null;
    return cached;
  } catch {
    return null;
  }
}

function writeCache(file, state) {
  const temporary = `${file}.${process.pid}.tmp`;
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporary, file);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function result(state, { size, mtimeMs, readMode, bytesRead, tailHash, endedNewline }) {
  state.coverage.exists = true;
  state.coverage.bytes = size;
  state.coverage.mtimeMs = mtimeMs;
  state.coverage.readMode = readMode;
  state.coverage.bytesRead = bytesRead;
  return {
    events: state.events,
    coverage: state.coverage,
    warnings: state.warnings,
    cache: { size, tailHash, endedNewline },
  };
}

export function readObservedLedger(cwd, { projectId = null, useCache = true } = {}) {
  const file = join(findDataDir(cwd), "ledger.jsonl");
  if (!existsSync(file)) return { events: [], coverage: emptyCoverage(file), warnings: [] };
  const cachePath = useCache ? cacheFile(file, projectId) : null;
  const cached = cachePath ? readCache(cachePath) : null;
  const stat = statSync(file);
  if (cached?.cache?.size === stat.size && cached.coverage.mtimeMs === stat.mtimeMs) {
    return result(cachedState(cached), { size: stat.size, mtimeMs: stat.mtimeMs, readMode: "cache_hit", bytesRead: 0, ...cached.cache });
  }
  let state = newState(file);
  let start = 0;
  let readMode = "full";
  if (cached?.cache?.endedNewline && stat.size > cached.cache.size && cached.coverage.mtimeMs !== undefined) {
    state = cachedState(cached);
    start = cached.cache.size;
    readMode = "append";
  }
  let fd;
  try {
    fd = openSync(file, "r");
    if (readMode === "append") {
      const length = Math.min(256, start);
      const previousTail = Buffer.alloc(length);
      readSync(fd, previousTail, 0, length, start - length);
      if (sha256(previousTail) !== cached.cache.tailHash) {
        state = newState(file);
        start = 0;
        readMode = "full";
      }
    }
    const buffer = Buffer.alloc(stat.size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    parseText(buffer.toString("utf8"), state);
    const tailLength = Math.min(256, stat.size);
    const tail = Buffer.alloc(tailLength);
    readSync(fd, tail, 0, tailLength, stat.size - tailLength);
    const endedNewline = stat.size > 0 && tail.at(-1) === 10;
    const outcome = result(state, { size: stat.size, mtimeMs: stat.mtimeMs, readMode, bytesRead: buffer.length, tailHash: sha256(tail), endedNewline });
    if (cachePath) {
      try {
        writeCache(cachePath, { schema: 1, file, events: outcome.events, warnings: outcome.warnings, coverage: outcome.coverage, cache: outcome.cache });
      } catch {
        // 派生缓存写失败不影响原账本读取。
      }
    }
    return outcome;
  } catch (error) {
    const coverage = emptyCoverage(file);
    coverage.exists = true;
    return { events: [], coverage, warnings: [{ code: "ledger_read_failed", detail: redact(error.message) }] };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function isKnownEvent(name) {
  return KNOWN_EVENTS.has(name);
}
