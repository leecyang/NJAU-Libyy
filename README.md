# NJAU Libyy

南京农业大学图书馆研讨室预约辅助系统。项目使用 Cloudflare Workers Static Assets 和 D1，提供邮箱账户、官方凭证绑定、三日房间查询、手动预约校验、自动预约任务、联约邀请、签到占位、签退占位和管理员查询能力。

## 当前边界

以下功能已保留完整状态流，但默认不会提交外部动作：

- 官方预约提交：等待补齐预约成功与失败响应结构后，将 `ENABLE_OFFICIAL_RESERVATION_SUBMISSION` 设为 `true`。
- 自动签退：等待确认官方 `reservationId` 字段路径和签退响应后启用。
- 自动签到：等待接入现场产生的 `systemMac` 与 `qrSignCheckCode` 后启用。
- 邮件发送：使用阿里企业邮 SMTP SSL，邮件先进入 `email_outbox`，再由 Cron 异步发送。

## 本地开发

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npm run types
npm run db:migrate:local
npm run dev
```

生成 32 字节 token 加密密钥：

```powershell
node -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'))"
```

开发联调时可以在 `.dev.vars` 中设置 `DEV_EXPOSE_VERIFICATION_CODES=true`，验证码会随开发环境 API 响应返回。生产环境不得启用。

## 校验

```powershell
npm run check
```

## 部署准备

项目包含两个隔离环境：

| 环境 | Worker | D1 | URL |
| --- | --- | --- | --- |
| staging | `njau-libyy-staging` | `njau-libyy-staging` | `https://staging-libyy.way2api.fun` |
| production | `njau-libyy-production` | `njau-libyy-production` | `https://libyy.way2api.fun` |

GitHub Actions 会在 `main` 更新后依次执行校验、staging 迁移与部署、staging 健康检查、production 迁移与部署、production 健康检查。首次启用前，在仓库中设置：

- Repository variable：`CLOUDFLARE_ACCOUNT_ID`
- Repository secret：`CLOUDFLARE_API_TOKEN`
- Repository variable：`DEPLOY_ENABLED=true`
- staging 与 production Environment secrets：`LIBYY_APP_SECRET`、`NJAU_PROXY_TOKEN`、`TOKEN_ENCRYPTION_KEY`、`SESSION_SECRET`、`PASSWORD_HASH_SECRET`、`SMTP_PASSWORD`

敏感值只允许通过 GitHub Settings 或 `wrangler secret put` 交互式写入，不得加入仓库、命令历史或日志。

官方 Libyy HTTP 请求统一经 `NJAU_PROXY_ENDPOINT` 指向的校园网代理转发。代理令牌必须保存为 `NJAU_PROXY_TOKEN` secret。SMTP 使用独立 TCP 通道，不经过该 HTTP 代理。

也可以在本机运行交互式引导脚本。输入内容不会回显：

```powershell
.\scripts\configure-secrets.ps1
```

单独更新校园网代理令牌：

```powershell
.\scripts\update-njau-proxy-token.ps1
```

Cloudflare Token 被意外粘贴为带 BOM 或首尾空白的文本时，可以单独重新录入：

```powershell
.\scripts\update-cloudflare-api-token.ps1
```

阿里企业邮返回 `526 Authentication failure` 时，请先在邮箱后台启用三方客户端登录并生成三方客户端安全密码，再单独更新 SMTP Secret。脚本会同时更新两个 Worker、GitHub Environment Secret 和 Repository Secret，并将 outbox 重置为下一轮 Cron 立即重试：

```powershell
.\scripts\update-smtp-password.ps1
```

管理员邮箱完成正常注册后，执行：

```powershell
.\scripts\promote-admin.ps1 -Environment production -Email <ADMIN_EMAIL>
```

补齐 `开发要求.md` 第 29 节列出的官方响应样本后，再逐项开启官方预约、签到和签退动作。

`data/` 和 `dirsearch/` 仅用于本地接口分析，已从版本库忽略。不要将任何明文 token 或密钥加入提交。
