import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { commonDir, mainWorktreeRoot, repoRoot } from "../lib/git.mjs";
import { redact } from "../lib/redact.mjs";

const REGISTRY_SCHEMA = 1;
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

export function observabilityRoot() {
  return process.env.HARNESS_OBSERVABILITY_DIR || join(homedir(), ".local", "share", "harness", "observability");
}

export function projectsFile() {
  return join(observabilityRoot(), "projects.json");
}

function emptyRegistry() {
  return { schema: REGISTRY_SCHEMA, projects: [] };
}

export function readProjects() {
  const file = projectsFile();
  if (!existsSync(file)) return emptyRegistry();
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || parsed.schema !== REGISTRY_SCHEMA || !Array.isArray(parsed.projects)) throw new Error("项目注册表格式不受支持");
  return parsed;
}

function lockIsStale(file) {
  try {
    if (Date.now() - statSync(file).mtimeMs < 30_000) return false;
    const pid = Number(readFileSync(file, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  } catch (error) {
    return error.code !== "ENOENT";
  }
}

function updateRegistry(update) {
  const root = observabilityRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = join(root, "projects.lock");
  let fd;
  for (let attempt = 0; attempt < 200 && fd === undefined; attempt += 1) {
    try {
      fd = openSync(lock, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (lockIsStale(lock)) {
        try {
          unlinkSync(lock);
        } catch {
          // 另一个持有者可能已经释放锁，下一轮重新判断。
        }
      }
      Atomics.wait(LOCK_WAIT, 0, 0, 25);
    }
  }
  if (fd === undefined) throw new Error("等待项目注册表锁超时");
  try {
    const next = update(readProjects());
    const temporary = join(root, `.projects-${process.pid}-${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, projectsFile());
    return next;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

function canonical(file) {
  return realpathSync(file);
}

function projectInfo(cwd) {
  const worktree = repoRoot(cwd);
  const common = canonical(commonDir(worktree));
  const mainWorktree = canonical(mainWorktreeRoot(worktree));
  return { commonDir: common, mainWorktree, displayName: basename(mainWorktree) };
}

function timestamp(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

export function registerProject(cwd, { version = null, now } = {}) {
  const info = projectInfo(cwd);
  const at = timestamp(now);
  let result;
  updateRegistry((registry) => {
    const existing = registry.projects.find((project) => project.commonDir === info.commonDir);
    if (existing) {
      existing.mainWorktree = info.mainWorktree;
      existing.displayName = info.displayName;
      existing.lastRegisteredAt = at;
      existing.status = "active";
      if (version) existing.lastHarnessVersion = version;
      result = { project: existing, added: false };
      return registry;
    }
    const project = {
      projectId: randomUUID(),
      ...info,
      firstSeenAt: at,
      lastRegisteredAt: at,
      lastHarnessVersion: version,
      status: "active",
    };
    registry.projects.push(project);
    result = { project, added: true };
    return registry;
  });
  return result;
}

export function registerProjectBestEffort(cwd, options) {
  try {
    return registerProject(cwd, options);
  } catch {
    return null;
  }
}

export function markProject(cwd, status) {
  const common = canonical(commonDir(cwd));
  let marked = null;
  updateRegistry((registry) => {
    const project = registry.projects.find((item) => item.commonDir === common);
    if (project) {
      project.status = status;
      marked = project;
    }
    return registry;
  });
  return marked;
}

export function markProjectBestEffort(cwd, status) {
  try {
    return markProject(cwd, status);
  } catch {
    return null;
  }
}

export function rebindProject(projectId, cwd) {
  const info = projectInfo(cwd);
  let rebound;
  updateRegistry((registry) => {
    const project = registry.projects.find((item) => item.projectId === projectId);
    if (!project) throw new Error(`未登记项目 ${projectId}`);
    if (registry.projects.some((item) => item.projectId !== projectId && item.commonDir === info.commonDir)) {
      throw new Error("目标仓库已经登记为另一个项目，不自动合并历史");
    }
    Object.assign(project, info, { status: "active" });
    rebound = project;
    return registry;
  });
  return rebound;
}

export function projectIdFor(cwd) {
  try {
    const common = canonical(commonDir(cwd));
    return readProjects().projects.find((project) => project.commonDir === common)?.projectId ?? null;
  } catch {
    return null;
  }
}

function currentStatus(project) {
  if (project.status === "uninstalled") return { status: "uninstalled" };
  if (!existsSync(project.mainWorktree) || !existsSync(project.commonDir)) return { status: "missing" };
  try {
    const current = canonical(commonDir(project.mainWorktree));
    if (current !== project.commonDir) return { status: "moved", currentCommonDir: current };
    return { status: "active", currentCommonDir: current };
  } catch (error) {
    return { status: error.code === "EACCES" || error.code === "EPERM" ? "unreadable" : "invalid", detail: redact(error.message) };
  }
}

export function listProjects() {
  return readProjects().projects
    .map((project) => ({ ...project, ...currentStatus(project) }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "zh-CN", { numeric: true, sensitivity: "base" }));
}
