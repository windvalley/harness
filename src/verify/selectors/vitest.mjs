import { matchAny } from "../../lib/glob.mjs";

const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|vue)$/;

export function selectVitestFiles({ changed, check, listAllTests }) {
  const scoped = changed.filter((path) => matchAny(path, check.when));
  const direct = scoped.filter((path) => TEST_FILE.test(path));
  const sourceFiles = scoped.filter((path) => !TEST_FILE.test(path));
  const siblings = new Set();

  if (sourceFiles.length > 0) {
    const all = listAllTests();
    for (const source of sourceFiles) {
      const stem = source.replace(/\.(vue|ts|tsx|js)$/, "");
      const base = stem.split("/").pop();
      for (const candidate of all) {
        if (candidate.startsWith(`${stem}.`) && TEST_FILE.test(candidate))
          siblings.add(candidate);
        else if (
          candidate.startsWith(`${stem.slice(0, stem.lastIndexOf("/"))}/`) &&
          candidate.includes(`/${base}.`)
        )
          siblings.add(candidate);
      }
    }
  }

  const files = [...new Set([...direct, ...siblings])].sort();
  return {
    files,
    hasSourceWithoutTest: sourceFiles.length > 0 && files.length === 0,
    sourceFiles,
  };
}
