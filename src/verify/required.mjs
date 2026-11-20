import { matchAny } from "../lib/glob.mjs";
import { showBlob } from "../lib/git.mjs";
import { approvalRecord } from "../plan/plan.mjs";
import { readAttestation } from "./attestation.mjs";

function definitionsText({ root, branch, acceptanceText, at }) {
  const approval = approvalRecord(root, branch);
  if (approval?.contractPath) return showBlob(root, at ?? branch, approval.contractPath) ?? "";
  return acceptanceText ?? "";
}

export function requiredEvidenceDefinitions({ project, root, branch, acceptanceText, at }) {
  const text = definitionsText({ root, branch, acceptanceText, at });
  const requirements = [];
  const problems = [];
  const seen = new Set();
  for (const match of text.matchAll(/<!--\s*harness:evidence\s+([^>]+)-->/g)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((item) => [item[1], item[2]]));
    const id = attrs.id ?? "";
    const phase = attrs.phase ?? "pre-merge";
    const check = project.verify.checks.find((item) => item.id === id);
    if (!id || !["pre-merge", "post-merge"].includes(phase)) {
      problems.push({ id: id || "unknown", reason: `必需证据声明 ${match[0]} 缺少合法 id 或 phase` });
      continue;
    }
    if (seen.has(id)) {
      problems.push({ id, reason: `必需证据 ${id} 重复声明` });
      continue;
    }
    seen.add(id);
    if (!check || check.tier !== "extended") {
      problems.push({ id, reason: `必需证据 ${id} 不是 verify.json 里的 extended 检查` });
      continue;
    }
    const actualPhase = check.phase ?? "pre-merge";
    if (actualPhase !== phase) {
      problems.push({ id, reason: `必需证据 ${id} 声明为 ${phase}，检查定义实际是 ${actualPhase}` });
      continue;
    }
    requirements.push({ id, phase, check, howToVerify: check.howToVerify });
  }
  return { requirements, problems };
}

export function requiredEvidencePlanProblems({ project, root, branch, acceptanceText, at, changed, phase = "pre-merge" }) {
  const { requirements, problems } = requiredEvidenceDefinitions({ project, root, branch, acceptanceText, at });
  return [
    ...problems,
    ...requirements
      .filter((item) => item.phase === phase && !changed.some((path) => matchAny(path, item.check.when)))
      .map((item) => ({
        id: item.id,
        code: "evidence_scope_mismatch",
        reason: `必需证据 ${item.id} 声明为 ${phase}，但它的 when 没有命中当前改动`,
        howToVerify: "核对检查 when 是否覆盖被测实现、测试、夹具与配置；不要用其他范围的报告代替这项验收",
      })),
  ];
}

export function requiredEvidenceProblems({ project, root, branch, acceptanceText, at, evidence, phase = "pre-merge", head = null }) {
  const { requirements, problems } = requiredEvidenceDefinitions({ project, root, branch, acceptanceText, at });
  const result = [...problems.map((item) => ({ ...item, code: "evidence_incomplete", howToVerify: "修正核心契约里的必需证据声明" }))];
  for (const item of requirements.filter((entry) => entry.phase === phase)) {
    const registered = (evidence?.attested ?? []).some((entry) => entry.id === item.id);
    const current = registered ? readAttestation({ root, branch, check: item.check, head: head ?? evidence?.head ?? branch }) : null;
    if (!current?.ok) {
      const pending = (evidence?.notExecuted ?? []).find((entry) => entry.id === item.id);
      result.push({
        id: item.id,
        code: "evidence_incomplete",
        reason: current?.reason ?? pending?.reason ?? `缺少必需证据 ${item.id}`,
        howToVerify: `${item.howToVerify}；成功后运行 harness attest --branch ${branch} --check ${item.id} --command "<实际命令>" --report <报告>`,
      });
    }
  }
  return result;
}

export function assertRequiredEvidence(args) {
  const problems = requiredEvidenceProblems(args);
  if (problems.length > 0) {
    const error = new Error(problems.map((item) => `${item.id}: ${item.reason}；${item.howToVerify}`).join("\n"));
    error.code = "evidence_incomplete";
    error.problems = problems;
    throw error;
  }
}
