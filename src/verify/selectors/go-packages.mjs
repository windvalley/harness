import { dirname } from "node:path";
import { matchAny } from "../../lib/glob.mjs";
import { run } from "../../lib/git.mjs";

function goList(cwd, args) {
  const result = run("go", ["list", ...args], { cwd });
  if (result.status !== 0)
    throw new Error(`go list 失败: ${result.stderr.trim()}`);
  return result.stdout.split("\n").filter(Boolean);
}

export function reverseDependents(cwd, importPaths) {
  const out = run(
    "go",
    [
      "list",
      "-test=false",
      "-f",
      '{{.ImportPath}}|{{join .Deps ","}}',
      "./...",
    ],
    { cwd }
  );
  if (out.status !== 0) throw new Error(`go list 失败: ${out.stderr.trim()}`);
  const targets = new Set(importPaths);
  const dependents = new Set();
  for (const line of out.stdout.split("\n")) {
    if (!line) continue;
    const [pkg, deps = ""] = line.split("|");
    if (targets.has(pkg)) continue;
    if (deps.split(",").some((dep) => targets.has(dep))) dependents.add(pkg);
  }
  return [...dependents];
}

export function selectGoPackages({ cwd, changed, check }) {
  const goFiles = changed.filter(
    (path) => path.endsWith(".go") && matchAny(path, check.when)
  );
  const dirs = [...new Set(goFiles.map((path) => dirname(path)))].sort();
  if (dirs.length === 0) return { mode: "none", packages: [] };

  const max = check.maxPackages ?? 40;
  const modulePath = goList(cwd, ["-m"])[0];
  const direct = dirs.map((dir) =>
    dir === "." ? modulePath : `${modulePath}/${dir}`
  );
  const sharedDirs = dirs.filter((dir) =>
    (check.sharedPrefixes ?? []).some((prefix) => `${dir}/`.startsWith(prefix))
  );

  let packages = direct;
  let mode = "direct";
  if (sharedDirs.length > 0) {
    const sharedImports = sharedDirs.map((dir) => `${modulePath}/${dir}`);
    const dependents = reverseDependents(cwd, sharedImports);
    packages = [...new Set([...direct, ...dependents])];
    mode = "with-dependents";
  }

  if (packages.length > max) {
    return {
      mode: "full",
      packages: ["./..."],
      note: `影响 ${packages.length} 个包,超过阈值 ${max},扩大为全量 go test`,
    };
  }
  return { mode, packages: packages.sort(), sharedDirs };
}
