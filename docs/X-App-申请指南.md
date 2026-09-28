# X Developer App 申请指南

本系统只读你自己的帖子，所需权限极小。按以下步骤申请（约 10 分钟）。

## 1. 注册与登录

1. 打开 https://developer.x.com 用**将被监控的那个 X 账号**登录；
2. 完成开发者协议签署。⚠️ **App Owner 必须与被监控账号一致**——这是享受 Owned Reads（$0.001/资源）定价的前提；用 A 的 App 读 B 的时间线按 $0.005/资源计费（5 倍）。

## 2. 创建 App

1. Developer Portal → Projects & Apps → Create App；
2. App type 选 Web App / Automated App（两者均支持 OAuth 2.0 + PKCE）；
3. 记录 Client ID；机密客户端需要 Client Secret（公开客户端可留空，走纯 PKCE）。

## 3. App 权限设置（最小集）

在 App 的 User context settings 中，**只勾选**：

```text
✅ tweet.read        读取帖子
✅ users.read        读取用户信息（/2/users/me）
✅ offline.access    获取 refresh_token，长期无人值守运行必需
❌ tweet.write       不申请！本系统绝不写 X
❌ like.write / follows.write / dm.write   一律不申请
```

代码层有兜底校验（`assertXScopes`）：若 token 响应出现任何写入 scope，授权直接失败并告警。

## 4. 回调地址

在 App settings 的 Callback URI / Redirect URL 填入与 `.env` 中 `X_REDIRECT_URI` **完全一致**的地址：

```text
http://127.0.0.1:4000/api/x/oauth/callback          # 本地调试
https://square.yourdomain.com/api/x/oauth/callback  # 生产（经反代）
```

不一致时 X 会在授权页直接报错，不会跳转。

## 5. 计费与额度（关键）

- 当前 X API 为预购信用点按量扣费：Developer Console → Billing 先购买 credits；
- **务必设置 Spending Limit**（建议个人自用 $5/账期起步）——不设上限时异常轮询可能烧穿余额；
- 信用余额可为负，为负后所有请求被静默阻止、同步随之停摆：后台 Dashboard 会显示成本估算，配合 Console 账单双保险；
- 价格随时可能调整（官方声明 "Prices are subject to change"），定期核对。

## 6. 验证

配置进 `.env` 后启动系统，点后台「连接 X 账号」：

```text
授权页正常弹出 → 同意 → 回跳成功
→ x_accounts 表出现 username 与 baseline_tweet_id
→ Dashboard 轮询状态 OK
```

即完成。历史帖子不会被同步（baseline 机制），只有连接之后发布的新帖进入管道。
