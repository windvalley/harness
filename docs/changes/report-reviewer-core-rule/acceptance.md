# 0.19.3 评审者汇报规则提前验收

## 范围

0.19.2 的评审者汇报要求只写在 `harness.md`，会话没重读它就会漏。
把要求提到每次任务都读的 `core.md`，并让 merge 和 submit 在日志最后再提示一次。
不改评审门禁、证据记录结构、账本事件和托管块。

## 验收

- `core.md` 直接写明交付汇报必须带一行代码评审的评审者，来源是 merge、submit 日志或 `status` 的“评审者”摘要，并指向 `harness.md` 的格式细则。
- `harness.md` 里已有的汇报规则保持不变，`core.md` 不复制整段。
- `harness merge` 完成后，日志最后一条 `[merge]` 行是“汇报时写一行代码评审的评审者: …”，摘要与评审记录一致。
- `harness submit` 完成后，日志最后一条 `[submit]` 行是同样的提示，本机输出里端点域名照常显示，PR/MR 描述里仍不含域名。
- `--dry-run` 不输出这一行，没有评审记录时不输出这一行。
- 0.19.2 升级说明里“规则文本随托管块分发”的说法更正为“由 upgrade 整份重写进 `.harness/rules/`”。
- 完成定向回归、全量 `npm test` 和 `npm run docs:check`。

## 验证记录

- 1 条新增测试（merge 日志末行）和 2 条扩展断言（`core.md` 规则文本、submit 日志末行）在原实现上先红。
- 实现后相关测试文件 189 项通过，全量 `npm test` 600 项通过，`npm run docs:check` 通过。
