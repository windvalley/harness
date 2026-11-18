import { commandExists } from "../review/review.mjs";
import { run, git } from "../lib/git.mjs";
import { tail } from "../lib/redact.mjs";

/**
 * harness 在 PR/MR 描述里维护的区块。区块外的文字由团队自己写，重跑 submit 时原样保留。
 * 用注释标记而不是“整段替换描述”，团队写在描述里的上线说明、检查清单不会被冲掉。
 */
export const SECTION_START = "<!-- harness:submit:start -->";
export const SECTION_END = "<!-- harness:submit:end -->";

export function managedSection(body) {
  return `${SECTION_START}\n${body.trim()}\n${SECTION_END}`;
}

/** 用新区块替换描述里的旧区块；没有区块时追加在末尾，区块外内容不动。 */
export function replaceManagedSection(existing, section) {
  const text = existing ?? "";
  const start = text.indexOf(SECTION_START);
  const end = text.indexOf(SECTION_END);
  if (start < 0 || end <= start) {
    const head = text.trim();
    return head ? `${head}\n\n${section}` : section;
  }
  const before = text.slice(0, start).replace(/\n+$/, "");
  const after = text.slice(end + SECTION_END.length).replace(/^\n+/, "");
  return [before, section, after].filter((part) => part !== "").join("\n");
}

/**
 * 从远程地址里取出平台上的仓库标识：主机名与路径。
 * 只用于显示与人核对，不参与鉴权；地址里带的凭据一律丢弃，不写进描述、日志或错误信息。
 * 本地路径（测试与离线环境）没有平台标识，返回 null。
 */
export function parseRemoteUrl(url) {
  const text = String(url ?? "").trim();
  if (!text) return null;
  // scp 风格: git@host:group/repo.git
  const scp = text.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/);
  if (scp && !text.includes("://")) return normalizeHost(scp[1], scp[2]);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "ssh:" && parsed.protocol !== "git+ssh:") return null;
  // parsed.host 不含凭据与端口：https://user:token@host/... 的 token 不会进入结果。
  return normalizeHost(parsed.hostname, parsed.pathname);
}

function normalizeHost(host, path) {
  const clean = String(path ?? "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  // 去掉 URL 里可能残留的用户名与口令段。
  const parts = clean.split("/").filter((part) => part !== "");
  if (parts.length < 2) return null;
  return { host, path: parts.join("/") };
}

/**
 * 获授权远程对应的平台仓库，形如 HOST/OWNER/REPO。
 * 平台命令默认按本地仓库的 remote 或 GH_REPO 推断要操作哪个仓库，配置成 upstream 时
 * 可能推送到仓库 A、却改到仓库 B 的同名 PR，因此所有平台调用都显式带上这个标识。
 * 取配置原值而不是 git remote get-url：后者会应用 url.insteadOf 重写，映射到镜像或本地目录后就不是获授权的仓库了。
 * 识别不出（本地路径等）时返回 null。
 */
export function platformRepo({ root, remote }) {
  const url = git(root, ["config", "--get", `remote.${remote}.url`]);
  if (url.status !== 0) return null;
  const parsed = parseRemoteUrl(url.stdout.trim());
  return parsed ? `${parsed.host}/${parsed.path}` : null;
}

/** gh 与 glab 都接受 --repo HOST/OWNER/REPO。 */
function repoFlag(repo) {
  return repo ? ["--repo", repo] : [];
}

/** 平台命令与子命令，按 provider 分派。参数形状按 gh 2.94 与 glab 的 mr 子命令写。 */
const PLATFORMS = {
  github: {
    bin: "gh",
    group: "pr",
    login: "gh auth login",
    label: "PR",
  },
  gitlab: {
    bin: "glab",
    group: "mr",
    login: "glab auth login",
    label: "MR",
  },
};

export function platformOf(provider) {
  const platform = PLATFORMS[provider];
  if (!platform) throw new Error(`未知的平台 ${provider}，可选 ${Object.keys(PLATFORMS).join(" 或 ")}`);
  return platform;
}

/**
 * 平台命令是否在 PATH 中。认证由实际的只读列表查询验证。
 */
export function platformStatus(provider) {
  const platform = platformOf(provider);
  return { ...platform, ok: commandExists(platform.bin) };
}

/**
 * 查找已打开、以任务分支为源、以主分支为目标的 PR/MR。
 * 返回 { id, url, body } 或 null；调用方用 id 决定创建还是更新。
 */
export function findOpen({ provider, branch, base, repo = null, cwd, env = process.env, timeout }) {
  const platform = platformOf(provider);
  const args =
    provider === "github"
      ? [
          platform.group,
          "list",
          // --head 只按分支名匹配，fork 里同名分支的 PR 也会命中，靠 isCrossRepository 排除。
          "--head",
          branch,
          "--base",
          base,
          "--state",
          "open",
          "--json",
          "number,url,body,state,headRefName,isCrossRepository",
          ...repoFlag(repo),
        ]
      : [
          platform.group,
          "list",
          "--source-branch",
          branch,
          "--target-branch",
          base,
          "--output",
          "json",
          ...repoFlag(repo),
        ];
  const result = run(platform.bin, args, { cwd, env, timeout });
  if (result.status !== 0) throw platformFailure(provider, "list", result);
  let list;
  try {
    list = JSON.parse(result.stdout);
  } catch {
    list = null;
  }
  const invalid = (stderr) => platformFailure(provider, "list", { status: result.status, stderr });
  if (!Array.isArray(list) || list.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw invalid("平台没有返回有效的 JSON 请求列表，请核对 CLI 和仓库访问。");
  }
  const first = list.find((item) => isOwnOpen(provider, item, { branch }));
  if (!first) return null;
  const request = provider === "github"
    ? { id: first.number, url: first.url, body: first.body ?? "" }
    : { id: first.iid, url: first.web_url, body: first.description ?? "" };
  if (!Number.isInteger(request.id) || request.id < 1 || typeof request.url !== "string" || !request.url || typeof request.body !== "string") {
    throw invalid("匹配的 PR/MR 缺少有效编号、地址或正文，请核对平台返回。");
  }
  return request;
}

/**
 * 是不是本仓库自己的、以任务分支为源的打开请求。
 * GitHub 用 isCrossRepository 排除 fork 里同名分支的 PR；GitLab 要求 source_project_id 与 target_project_id 相同。
 * 识别字段缺失时按“不是自己的”处理：宁可新建一个，也不把门禁结果写到别的仓库的代码上。
 */
function isOwnOpen(provider, item, { branch }) {
  if (provider === "github") {
    if ((item.state ?? "").toUpperCase() !== "OPEN") return false;
    if (item.headRefName !== branch) return false;
    return item.isCrossRepository === false;
  }
  // GitLab 的打开状态是 opened。
  if (item.state !== "opened") return false;
  if (item.source_branch !== undefined && item.source_branch !== branch) return false;
  return item.source_project_id !== undefined && item.source_project_id === item.target_project_id;
}

/** 创建指向主分支的 PR/MR。标题只在创建时确定，之后不覆盖，避免冲掉团队改过的标题。 */
export function createRequest({ provider, branch, base, title, body, repo = null, cwd, env = process.env }) {
  const platform = platformOf(provider);
  const args =
    provider === "github"
      ? [platform.group, "create", "--head", branch, "--base", base, "--title", title, "--body-file", "-", ...repoFlag(repo)]
      : [platform.group, "create", "--source-branch", branch, "--target-branch", base, "--title", title, "--description", body, ...repoFlag(repo)];
  const result = run(platform.bin, args, { cwd, env, input: provider === "github" ? body : undefined });
  if (result.status !== 0) throw platformFailure(provider, "create", result);
  return { id: null, url: result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "" };
}

/** 只替换描述里的托管区块，标题与区块外的内容都不动。 */
export function updateRequest({ provider, id, body, repo = null, cwd, env = process.env }) {
  const platform = platformOf(provider);
  const args =
    provider === "github"
      ? [platform.group, "edit", String(id), "--body-file", "-", ...repoFlag(repo)]
      : [platform.group, "update", String(id), "--description", body, ...repoFlag(repo)];
  const result = run(platform.bin, args, { cwd, env, input: provider === "github" ? body : undefined });
  if (result.status !== 0) throw platformFailure(provider, "update", result);
  return { id, url: result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "" };
}

/** 只对有明确诊断的失败作判断，其他非零退出留给调用方核对。 */
function platformFailureReason(result) {
  const message = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  const status = message.match(/\b(?:HTTP(?:\/[\d.]+)?|status(?: code)?)[:=\s]+(\d{3})\b/i)?.[1] ??
    message.match(/\b(?:GET|HEAD|POST|PUT|PATCH|DELETE) https?:\/\/\S+: (\d{3})\b/)?.[1];
  if (status === "429" || /rate limit|too many requests/i.test(message)) return "rate_limit";
  if (status === "401" || /bad credentials|authentication failed|not (?:logged in|authenticated)|(?:gh|glab) auth login/i.test(message)) return "login";
  if (status === "403" || /permission denied|access denied|insufficient permissions?/i.test(message)) return "permission";
  if (["500", "502", "503", "504"].includes(status) ||
      result.error?.code === "ETIMEDOUT" ||
      /connection (?:reset|refused|timed out)|network is unreachable|i\/o timeout|TLS handshake timeout|context deadline exceeded/i.test(message)) {
    return "temporary";
  }
  return "unknown";
}

export function platformFailureAdvice(provider, reason) {
  const { login } = platformOf(provider);
  switch (reason) {
    case "login":
      return { human: true, detail: `平台登录不可用，请由人运行 ${login} 并核对目标仓库的访问权限` };
    case "permission":
      return { human: true, detail: "平台拒绝访问，请由人核对目标仓库的账号、权限或保护规则" };
    case "rate_limit":
      return { human: false, detail: "平台限流，等限流解除后再继续" };
    case "temporary":
      return { human: false, detail: "平台暂时不可用，先确认平台恢复" };
    default:
      return { human: false, detail: "无法判定平台错误的原因，先根据命令报错核对平台状态" };
  }
}

function platformFailure(provider, action, result) {
  const platform = platformOf(provider);
  const reason = platformFailureReason(result);
  const detail = tail(result.stderr || result.stdout);
  const error = new Error(
    [
      `${platform.bin} ${platform.group} ${action} 失败(exit ${result.status})`,
      detail,
      platformFailureAdvice(provider, reason).detail,
      "harness 不读取、不保存也不传递平台令牌，全部由上面的命令自己管理。",
    ].join("\n"),
  );
  error.code = "platform_failed";
  error.platformReason = reason;
  return error;
}
