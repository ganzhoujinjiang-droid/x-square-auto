# X → Binance Square 自动同步系统

自托管的单向内容管道：把你自己的 X（Twitter）帖子自动同步发布到 Binance Square。
**只使用 X 官方 API 与 Binance Square OpenAPI，不含任何爬虫或自动化浏览器手段。**

```text
X 官方 API v2（只读） → PostgreSQL（记忆/去重） → Redis + BullMQ → Binance Square OpenAPI（发布）
```

## ⚠️ 部署前必读

1. 本项目仅使用 X 官方 API，不含任何爬虫或自动化浏览器手段。
2. 需要你自己的 X Developer App，且 **App Owner 必须与被监控账号一致**，否则按标准价 $0.005/资源计费（Owned Reads 优惠价的 5 倍）。
3. X API 为预购信用点按量扣费，请先在 Developer Console 设置 Spending Limit（建议 $5/账期起步）。
4. Binance Square OpenAPI 有 **100 帖/日、400 上传/日** 的硬限额，系统在代码中前置校验。
5. `APP_ENCRYPTION_KEY` 丢失将导致所有已保存的 Token 与 Key 无法解密，请务必离线备份。
6. 自动发布内容需遵守 X 与 Binance 双方平台条款，使用者自行承担责任。
7. 504/超时场景下系统标记为「待确认」而非自动重试——这是有意设计：**宁可停下等人，也不自动重发**。

## 功能（V1）

- X OAuth 2.0 + PKCE（单账号，只申请 tweet.read / users.read / offline.access）
- baseline 机制：首次连接只记录断点，绝不回溯历史帖子
- since_id 增量轮询（默认 30s，可配 15/30/60/120/300），429 自动退避
- 原创纯文本 + 原创图片（≤4 张）自动同步；关键词包含/排除过滤；原样/模板化文本
- PostgreSQL 唯一索引去重 + 同事务断点推进：服务器重启不丢帖、不重复
- 完整状态机（含 UNCERTAIN 人工确认入口）+ BullMQ 延迟与退避重试
- Next.js 后台：Dashboard / X 账号 / Binance 账号 / 规则 / 记录 / 待确认 / 设置
- Argon2id 登录 + Session + CSRF + Rate Limit + 失败锁定
- AES-256-GCM 密钥静态加密 + 掩码显示 + Pino 日志脱敏
- X API 用量采集与成本估算；Docker Compose 一键部署（ARM64）

明确不做（V1/V2 均受平台限制）：编辑/删除已发布的 Square 帖子、视频/GIF/长文章、多账号、网页抓取。详见 [docs/系统设计文档.md](docs/系统设计文档.md) §22。

## 快速开始

要求：Docker Compose v2；目标机为 ARM64 时全部镜像原生支持。

```bash
git clone <repo-url> && cd x-square-auto
cp .env.example .env        # 填入全部变量；密钥生成方式见文件内注释
pnpm install --frozen-lockfile
docker compose up -d --build
docker compose exec api pnpm --filter @x-square/database deploy   # 执行迁移
docker compose exec api pnpm --filter @x-square/database seed     # 初始管理员（密码来自 ADMIN_PASSWORD）
```

访问：生产走宿主机 Nginx/Cloudflare 反代到 `127.0.0.1:8443`（§16.3 方案 A）；
调试可用 SSH 隧道 `ssh -L 8443:127.0.0.1:8443 user@server` 后打开 http://127.0.0.1:8443 。

详细步骤与排错见 [docs/部署指南.md](docs/部署指南.md)，X App 申请见 [docs/X-App-申请指南.md](docs/X-App-申请指南.md)。

## 项目结构

```text
apps/web          Next.js 后台
apps/api          Fastify API（认证/OAuth/业务路由/health）
workers           x-monitor / sync-worker / image-worker / ai-worker（单进程）
packages/*        shared · crypto · schemas · database · x-client · binance-client · queue · ai
prisma/           schema + migrations + seed
docker/           Dockerfile×3 + Caddyfile
docs/             系统设计文档 + 部署指南 + X App 申请指南
```

## 开发

```bash
pnpm install
pnpm build        # 全仓编译
pnpm test         # vitest 全量（无需数据库/Redis）
pnpm typecheck
```

核心原则（详见设计文档 §28）：TypeScript 负责整个应用；X 官方 API 负责发现内容；PostgreSQL 负责记忆和去重；Redis + Worker 负责可靠发布；结果未知时宁可停下等人，也不自动重发。

## 成本参考

| 项 | 价格 |
|---|---|
| X Posts Read（Owned Reads） | $0.001 / 资源 |
| X Posts Read（标准） | $0.005 / 资源 |
| 空响应 | 不计费 |
| Binance Square OpenAPI | 免费，限额见上 |

个人自用典型用量（每天几十条新帖轮询 + 同步）月成本通常在 $1–3 区间，以 Developer Console 账单为准。

## License

MIT，见 [LICENSE](LICENSE)。安全漏洞披露见 [SECURITY.md](SECURITY.md)。
