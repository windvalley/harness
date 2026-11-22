export function humanExecutes(command) {
  return `由人在自己的终端执行：${command}`;
}

export function agentAfterConsent(decision, command) {
  return `用户在对话中${decision}后，由 Agent 执行：${command}`;
}

export function agentContinues(command) {
  return `Agent 可直接继续执行：${command}`;
}

export function noNextAction(reason) {
  return `无需继续执行：${reason}`;
}
