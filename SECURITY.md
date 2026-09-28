# 安全策略（SECURITY.md）

## 支持的版本

| 版本 | 支持情况 |
|---|---|
| 0.1.x（V1） | ✅ 积极修复 |

## 报告漏洞

请勿公开提 Issue。通过仓库维护者公布的私人渠道（如 SECURITY 邮箱）报告，标题注明 `[security]`。

响应时限承诺：

- **确认收到**：48 小时内；
- **评估与定级**：5 个工作日内给出初步结论；
- **修复发布**：高危（凭据泄露、鉴权绕过、任意代码执行）7 天内；中危 30 天内；低危随下个版本。

## 本系统的威胁模型要点（设计即防御）

- 后台唯一入口为 Argon2id 登录 + 服务端 Session（Redis），失败 5 次锁定 15 分钟；
- 所有写操作强制 CSRF 双提交校验；全站安全头齐全；
- X Token / Binance Key / AI Key 一律 AES-256-GCM 加密落库，API 与日志只出掩码；
- `APP_ENCRYPTION_KEY` 缺失时进程拒绝启动；
- PostgreSQL / Redis 仅在 Docker 内部网络可达，不映射宿主机端口；
- 日志经 Pino redact 覆盖凭据路径，CI 含 grep 回归检查；
- 发布结果未知（504/超时/断连）时系统停止并等待人工确认，绝不自动重发。

若你丢失 `APP_ENCRYPTION_KEY`：已保存的 Token 无法恢复，请在 X Developer Portal 吊销 App 授权、在 Binance 创作者中心重新生成 Publishing Key，然后清空数据库重新配置。
