/**
 * 把诊断信息里可能出现的凭据替换掉。
 * git 与平台命令的报错会原样带出远程地址，地址里可能有用户信息（user:token@）或查询参数（?access_token=）。
 * 这类内容只能出现在本机错误输出里，不能进描述、账本或其他人的屏幕，统一在拼错误信息时清洗。
 * 命令行里的 --token、--password、API_KEY=、Authorization 头也按同样方式遮盖；
 * 这是按名字识别的启发式，认不出的写法（位置参数里的密码、短选项）仍可能漏掉，登记前仍要自己确认。
 */
// 名字里带这些词的参数、选项与环境变量，值按凭据处理；词前后允许有别的字符（GITHUB_TOKEN、client-secret、AWS_SECRET_ACCESS_KEY）。
const SECRET_WORD = "(?:token|secret|password|passwd|credentials?|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?key)";
const VALUE = "(?:\"[^\"]*\"|'[^']*'|[^&\\s'\"]+)";
// name=value：查询参数、环境变量赋值与 --name=value。
const SECRET_PARAM = new RegExp(`([a-z0-9_-]*${SECRET_WORD}=)${VALUE}`, "gi");
// --name value：值在下一个词里。名字必须以凭据词结尾，--token-count、--tokenizer 这类不算。
const SECRET_FLAG = new RegExp(`(--(?:[a-z0-9]+[-_])*${SECRET_WORD}[ \\t]+)${VALUE}`, "gi");
// Authorization 头的整个值，以及单独出现的 Bearer 令牌。
const AUTH_HEADER = /(authorization["']?\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s'"]+/gi;
const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

export function redact(text) {
  return String(text ?? "")
    // URL 里的用户信息: scheme://user:pass@host 或 scheme://user@host
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    // 同一行里紧跟着命令的裸地址，例如 fatal: 'https://user:tok@host/repo' ...
    .replace(/(['"])([a-z][a-z0-9+.-]*:\/\/[^\s'"]*)@/gi, (match, quote, head) => `${quote}${head.split("://")[0]}://***@`)
    .replace(AUTH_HEADER, "$1***")
    .replace(BEARER, "$1***")
    .replace(SECRET_FLAG, "$1***")
    .replace(SECRET_PARAM, "$1***");
}

/** 只清洗最后若干行，错误信息不需要整段 git 输出。 */
export function tail(text, lines = 6) {
  return redact(String(text ?? "").trim().split("\n").slice(-lines).join("\n"));
}
