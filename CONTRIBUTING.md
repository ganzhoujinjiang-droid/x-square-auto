# 贡献指南（CONTRIBUTING.md）

## 开发环境

- Node.js ≥ 20（推荐 22 LTS）、pnpm ≥ 9；
- 克隆后 `pnpm install`；单元测试**不需要**数据库/Redis（全部走 stub / 内存实现）；
- 本地联调需要 Docker：`docker compose up -d postgres redis`，再执行 `pnpm db:migrate && pnpm db:seed`。

## 代码规范

- TypeScript `strict: true`，monorepo 分包遵循设计文档 §5 的边界：包之间不循环依赖，业务逻辑只放 apps/workers；
- 所有外部输入/输出必须经 `@x-square/schemas` 的 Zod schema 校验；新增 X/Binance 字段先登记 schema，禁止 passthrough；
- 状态转移一律走 `workers/src/state-machine.ts`，不得直接 UPDATE status 列；
- 任何 Token / Key 严禁写日志、进错误 message、出现在 API 响应；
- 涉及重试的改动必须先回答：「这个失败自动重试会不会造成重复发布？」会 → 转 UNCERTAIN。

## 提交流程

1. 从 main 开分支（feat/xxx、fix/xxx）；
2. PR 前本地跑齐 CI 四件套：`pnpm typecheck && pnpm lint && pnpm test && pnpm build`；
3. 每个 PR 附验收说明：改了哪个 Phase、如何验证；
4. 维护者 review 后 squash merge。

## 设计先行

行为变更（新状态、新队列、新限额、计费口径）请先在 Discussions/Issue 对齐，必要时更新 `docs/系统设计文档.md` 并同步其 §23.1 进度表，再动代码。
