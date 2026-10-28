/**
 * 把诊断信息里可能出现的凭据替换掉。
 * git 与平台命令的报错会原样带出远程地址，地址里可能有用户信息（user:token@）或查询参数（?access_token=）。
 * 这类内容只能出现在本机错误输出里，不能进描述、账本或其他人的屏幕，统一在拼错误信息时清洗。
 */
const SECRET_PARAM = /((?:access_token|token|private_token|authkey|password|secret)=)[^&\s'"]+/gi;

export function redact(text) {
  return String(text ?? "")
    // URL 里的用户信息: scheme://user:pass@host 或 scheme://user@host
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    // 同一行里紧跟着命令的裸地址，例如 fatal: 'https://user:tok@host/repo' ...
    .replace(/(['"])([a-z][a-z0-9+.-]*:\/\/[^\s'"]*)@/gi, (match, quote, head) => `${quote}${head.split("://")[0]}://***@`)
    .replace(SECRET_PARAM, "$1***");
}

/** 只清洗最后若干行，错误信息不需要整段 git 输出。 */
export function tail(text, lines = 6) {
  return redact(String(text ?? "").trim().split("\n").slice(-lines).join("\n"));
}
