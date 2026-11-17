import { mainBranch } from "../lib/config.mjs";
import { git, gitOk, showBlob } from "../lib/git.mjs";
import { resolvePolicy } from "./resolve.mjs";

const KIND = "branch-name";
const FIELDS = ["id", "kind", "pattern", "reason", "fix", "example", "preset"];

/** 分支命名只在 policy 中定义；没有生效规则时不启用。 */
export function resolveBranchRule(resolved) {
  const rules = (resolved?.rules ?? []).filter((rule) => rule.kind === KIND);
  if (rules.length === 0) return null;
  if (rules.length > 1) throw new Error(".harness/policy.json 只能有一条生效的 branch-name 规则");
  const rule = rules[0];
  const label = ".harness/policy.json 的 branch-name 规则";
  const unknown = Object.keys(rule).filter((field) => !FIELDS.includes(field));
  if (unknown.length > 0) throw new Error(`${label} 有不认识的字段 ${unknown.join("、")}；可用字段：${FIELDS.filter((field) => field !== "preset").join("、")}`);
  for (const field of ["id", "pattern", "reason", "fix"]) {
    if (typeof rule[field] !== "string" || rule[field].trim() === "") throw new Error(`${label} 的 ${field} 必须是非空字符串`);
  }
  if (rule.example !== undefined && typeof rule.example !== "string") throw new Error(`${label} 的 example 必须是字符串`);
  try {
    new RegExp(rule.pattern);
  } catch (error) {
    throw new Error(`${label} 的 pattern 正则无效：${error.message}`);
  }
  return { rule, pattern: rule.pattern, example: rule.example ?? null };
}

export function branchNameProblems({ spec, name, mainRef }) {
  if (!spec || name === mainRef) return [];
  if (new RegExp(spec.pattern).test(name)) return [];
  return [`分支名称不符合规范：${name}，要求匹配 ${spec.pattern}`];
}

/** 用 Git 的引用解析结果识别来源，避免把标签、提交号或 HEAD 字样当作分支名称。 */
export function resolveBranchSource(root, source = "HEAD") {
  if (typeof source !== "string" || source === "") throw new Error("分支来源必须是非空的引用名称");
  let ref;
  if (source === "HEAD") {
    const symbolic = git(root, ["symbolic-ref", "--quiet", "HEAD"]);
    if (symbolic.status === 0) ref = symbolic.stdout.trim();
  }
  if (!ref) {
    const result = git(root, ["rev-parse", "--verify", "--symbolic-full-name", "--end-of-options", source], { env: { ...process.env, LC_ALL: "C" } });
    if (result.status !== 0 || /ambiguous/i.test(result.stderr)) throw new Error(`无法明确解析分支引用 ${source}：${result.stderr.trim() || "引用不存在"}`);
    ref = result.stdout.trim();
    // SHA 与提交表达式没有完整引用；标签也只能用于内容验证。
    if (!ref || ref.startsWith("refs/tags/")) {
      gitOk(root, ["rev-parse", "--verify", "--end-of-options", `${source}^{commit}`]);
      return null;
    }
    const symbolic = git(root, ["symbolic-ref", "--quiet", ref]);
    if (symbolic.status === 0) ref = symbolic.stdout.trim();
  }
  if (ref.startsWith("refs/heads/")) return { name: ref.slice("refs/heads/".length), ref, kind: "local" };
  if (ref.startsWith("refs/remotes/")) {
    const remoteName = ref.slice("refs/remotes/".length);
    const remotes = gitOk(root, ["remote"]).split("\n").filter(Boolean).sort((a, b) => b.length - a.length);
    const remote = remotes.find((name) => remoteName.startsWith(`${name}/`));
    // 远程配置可以被移除，但对应的远程跟踪引用仍保留。
    const name = remote ? remoteName.slice(remote.length + 1) : remoteName.slice(remoteName.indexOf("/") + 1);
    if (!name || name === remoteName) throw new Error(`无法从远程引用 ${ref} 识别分支名称`);
    return { name, ref, kind: "remote" };
  }
  return null;
}

function describeProblems(spec, problems) {
  if (!spec || problems.length === 0) return problems;
  return [...problems, spec.rule.reason, `正确做法：${spec.rule.fix}`, ...(spec.example ? [`示例：${spec.example}`] : [])];
}

function sourceProblems({ spec, source, branch, mainRef, requireBranch }) {
  if (!spec) return [];
  if (!source) return requireBranch ? [`来源 ${branch} 不是可识别的命名分支，请指定本地分支或远程跟踪分支`] : [];
  return branchNameProblems({ spec, name: source.name, mainRef });
}

export function branchProblems({ project, root = project.root, branch = "HEAD", requireBranch = false }) {
  const spec = resolveBranchRule(resolvePolicy(project.policy));
  if (!spec) return [];
  const source = resolveBranchSource(root, branch);
  return describeProblems(spec, sourceProblems({ spec, source, branch, mainRef: mainBranch(project), requireBranch }));
}

/** 新规则从开始就严格检查，不继承提交规范的旧配置兼容逻辑。 */
export function branchRuleErrorAt(root, ref) {
  try {
    const blob = showBlob(root, ref, ".harness/policy.json");
    if (blob === null) return null;
    let policy;
    try {
      policy = JSON.parse(blob);
    } catch (error) {
      throw new Error(`.harness/policy.json 不是合法的 JSON：${error.message}`);
    }
    resolveBranchRule(resolvePolicy(policy));
    return null;
  } catch (error) {
    return error.message;
  }
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

/** 验证与评审只检查规则配置，不重复执行分支命名门禁。 */
export function assertBranchRule({ project, root = project.root, ref = "HEAD", checkRule = true }) {
  let spec;
  try {
    spec = resolveBranchRule(resolvePolicy(project.policy));
  } catch (error) {
    fail("branch_name_rule_invalid", `分支命名规则不能用：${error.message}。请修正 .harness/policy.json 中的 branch-name 规则`);
  }
  if (checkRule) {
    const ruleError = branchRuleErrorAt(root, ref);
    if (ruleError) fail("branch_name_rule_invalid", `来源 ${ref} 中的分支命名规则不能用：${ruleError}。请修正 .harness/policy.json 后重新验证和评审`);
  }
  return spec;
}

/** 提交、交付与状态共用名称判定；配置与来源错误分别报告。 */
export function assertBranchPolicy({ project, root = project.root, branch = "HEAD", requireBranch = false, checkRule = true }) {
  const spec = assertBranchRule({ project, root, ref: branch, checkRule });
  if (!spec) return { spec: null, source: null };
  let source;
  try {
    source = resolveBranchSource(root, branch);
  } catch (error) {
    fail("bad_branch_name", describeProblems(spec, [`无法识别分支来源 ${branch}：${error.message}`]).join("\n"));
  }
  const problems = sourceProblems({ spec, source, branch, mainRef: mainBranch(project), requireBranch });
  if (problems.length > 0) fail("bad_branch_name", describeProblems(spec, problems).join("\n"));
  return { spec, source };
}
