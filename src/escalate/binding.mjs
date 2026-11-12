import { loadGateProject, mainBranch } from "../lib/config.mjs";
import { git, gitOk } from "../lib/git.mjs";
import { redact } from "../lib/redact.mjs";
import { collectObligations } from "../verify/obligation.mjs";

/** 上报与 Stop 共用同一份可信版本及待验收快照；读取失败由调用方处理，不能当空集合。 */
export function escalationBinding(root, branch, mainCommit) {
  if (!mainCommit) {
    const project = loadGateProject(root, { branch });
    mainCommit = gitOk(root, ["rev-parse", "--verify", `${mainBranch(project)}^{commit}`]);
  }
  const pending = collectObligations({ root, mainCommit, branch }).filter((item) => item.due && !item.closed);
  const local = git(root, ["show-ref", "--verify", "--hash", `refs/heads/${branch}`]);
  let head = local.status === 0 ? local.stdout.trim() : null;
  if (!head && pending.length > 0) {
    // 验签失败的字段只保留在义务快照里，不能提供版本，也无需参与时间排序。
    if (pending.some((item) => item.problem)) head = mainCommit;
    else {
      const time = (item) => typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt)) ? Date.parse(item.createdAt) : 0;
      const newest = [...pending].sort((a, b) => time(a) - time(b) || a.key.localeCompare(b.key)).at(-1);
      head = newest.branchTip;
    }
  }
  return { head, pending, obligations: pending.map((item) => item.key).sort() };
}

/** 持久化诊断前清洗凭据与本机仓库、运行数据路径。 */
export function bindingProblem(root, error) {
  let text = redact(error?.message ?? error);
  for (const path of [process.env.HARNESS_DATA_DIR, root].filter(Boolean)) text = text.replaceAll(path, "<local>");
  return text || "无法计算可信上报绑定，请检查本地仓库与义务记录";
}
