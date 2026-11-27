import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { observabilityRoot } from "./projects.mjs";

const HEALTH_SCHEMA = 1;

function historyFile(projectId) {
  if (!/^[0-9a-f-]{36}$/.test(projectId)) throw new Error("项目 ID 无效");
  return join(observabilityRoot(), "health", `${projectId}.jsonl`);
}

export function captureHealth(project, now = Date.now()) {
  if (!project.health || !project.config) return null;
  const file = historyFile(project.projectId);
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const record = {
    schema: HEALTH_SCHEMA,
    projectId: project.projectId,
    capturedAt: new Date(now).toISOString(),
    config: project.config,
    doctor: project.health.doctor,
    conformance: project.health.conformance,
  };
  appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

function publicSample(record) {
  return {
    capturedAt: record.capturedAt,
    config: record.config,
    doctorOk: record.doctor.ok,
    failedChecks: record.doctor.checks.filter((check) => !check.ok).map((check) => ({ id: check.id, detail: check.detail })),
    conformancePending: record.conformance.pendingCount,
    conformanceFailed: record.conformance.failedCount,
  };
}

export function readHealthHistory(projectId) {
  const file = historyFile(projectId);
  if (!existsSync(file)) return { samples: [], warnings: [] };
  const samples = [];
  const warnings = [];
  for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (record.schema !== HEALTH_SCHEMA || record.projectId !== projectId || !Number.isFinite(Date.parse(record.capturedAt))) throw new Error("invalid");
      samples.push(publicSample(record));
    } catch {
      warnings.push({ code: "health_snapshot_invalid", line: index + 1 });
    }
  }
  return { samples, warnings };
}
