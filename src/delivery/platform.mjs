import { commandExists } from "../review/review.mjs";
import { run } from "../lib/git.mjs";

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
 * 平台命令是否可用。只判是否存在，不额外调 --version：认证状态在 list 时才知道，
 * 而 list 本来就在推送之前执行，失败时按 platform_failed 处理。
 */
export function platformStatus(provider) {
  const platform = platformOf(provider);
  return { ...platform, ok: commandExists(platform.bin) };
}

/**
 * 查找已打开、以任务分支为源、以主分支为目标的 PR/MR。
 * 返回 { id, url, body } 或 null；调用方用 id 决定创建还是更新。
 */
export function findOpen({ provider, branch, base, cwd, env = process.env }) {
  const platform = platformOf(provider);
  const args =
    provider === "github"
      ? [platform.group, "list", "--head", branch, "--base", base, "--state", "open", "--json", "number,url,body"]
      : [platform.group, "list", "--source-branch", branch, "--target-branch", base];
  const result = run(platform.bin, args, { cwd, env });
  if (result.status !== 0) throw platformFailure(provider, "list", result);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim() || "[]");
  } catch {
    throw new Error(`无法解析 ${platform.bin} ${platform.group} list 的输出: ${result.stdout.trim().slice(0, 200)}`);
  }
  const list = Array.isArray(parsed) ? parsed : [];
  const first = list.find((item) => (item.state ?? "open") === "open");
  if (!first) return null;
  return provider === "github"
    ? { id: first.number, url: first.url, body: first.body ?? "" }
    : { id: first.iid, url: first.web_url, body: first.description ?? "" };
}

/** 创建指向主分支的 PR/MR。标题只在创建时确定，之后不覆盖，避免冲掉团队改过的标题。 */
export function createRequest({ provider, branch, base, title, body, cwd, env = process.env }) {
  const platform = platformOf(provider);
  const args =
    provider === "github"
      ? [platform.group, "create", "--head", branch, "--base", base, "--title", title, "--body-file", "-"]
      : [platform.group, "create", "--source-branch", branch, "--target-branch", base, "--title", title, "--description", body];
  const result = run(platform.bin, args, { cwd, env, input: provider === "github" ? body : undefined });
  if (result.status !== 0) throw platformFailure(provider, "create", result);
  return { id: null, url: result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "" };
}

/** 只替换描述里的托管区块，标题与区块外的内容都不动。 */
export function updateRequest({ provider, id, body, cwd, env = process.env }) {
  const platform = platformOf(provider);
  const args =
    provider === "github"
      ? [platform.group, "edit", String(id), "--body-file", "-"]
      : [platform.group, "update", String(id), "--description", body];
  const result = run(platform.bin, args, { cwd, env, input: provider === "github" ? body : undefined });
  if (result.status !== 0) throw platformFailure(provider, "update", result);
  return { id, url: result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "" };
}

function platformFailure(provider, action, result) {
  const platform = platformOf(provider);
  const detail = (result.stderr || result.stdout).trim().split("\n").slice(-6).join("\n");
  const error = new Error(
    [
      `${platform.bin} ${platform.group} ${action} 失败(exit ${result.status})`,
      detail,
      `认证或网络问题由人处理: 运行 ${platform.login} 登录，确认可以访问远程仓库后重试。`,
      "harness 不读取、不保存也不传递平台令牌，全部由上面的命令自己管理。",
    ].join("\n"),
  );
  error.code = "platform_failed";
  return error;
}
