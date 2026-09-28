# 更新记录

本项目遵循 Keep a Changelog 与语义化版本。

## [0.1.0] - 2026-09-28

V1 首个完整实现（代码 + 单测），端到端验收随部署进行：

### 新增

- `packages/shared`：常量、错误分类（retry/fail/uncertain）、状态机表、Snowflake 工具、模板渲染、日志脱敏清单；
- `packages/crypto`：AES-256-GCM 静态加密、OAuth PKCE、Argon2id 口令哈希；
- `packages/schemas`：X API v2 / Binance Square OpenAPI / 队列载荷 / 系统设置的全套 Zod schema；
- `packages/database`：Prisma 客户端单例、同事务封装、串行化冲突重试；
- `packages/x-client`：OAuth 授权/刷新、users/me、时间线轮询（§6.1 参数全集）、429 退避元数据；
- `packages/binance-client`：Square 三端点（发布 V1 / 图片 V2）、前置硬校验、504→UNCERTAIN；
- `packages/queue`：BullMQ 队列定义、Redis 分布式锁、UTC 日配额计数器；
- `packages/ai`：AIProvider 抽象与失败降级（V1 默认关闭）；
- `workers`：x-monitor（baseline/轮询/断点推进）、sync-worker（过滤+状态机+发布）、image-worker（下载/上传/轮询/清理）；
- `apps/api`：Fastify 后台接口（登录/CSRF/限流/OAuth 回调/规则/记录/待确认/health）；
- `apps/web`：Next.js 后台 8 个页面；
- 部署链路：docker-compose（网络隔离 + 健康检查）、api/worker/web Dockerfile、Caddyfile；
- 文档：系统设计文档（含 §23.1 进度标注）、README、SECURITY、CONTRIBUTING、部署指南、X App 申请指南。

### 已知限制

- Square 正文准确字符上限官方未公开，以 280 软预警 + 错误码 20013 兜底；
- 图片处理状态轮询接口结构来自官方 skill 行为描述，上线后以真实响应校准。
