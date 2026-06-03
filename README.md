# NJAU Libyy

南京农业大学图书馆研讨室预约辅助系统。项目使用 Cloudflare Workers Static Assets 和 D1，提供三步账号配置、官方凭证绑定、房间时间片查询、单人预约、自动预约任务、小队、最近联系人、预约历史同步、取消预约、签到入口、自动签退和管理员查询能力。

## 当前边界

官方接口适配器依据浏览器 HAR 中的真实链路实现。以下能力保留显式门禁与配置保护：

- 多人官方预约提交：单人使用 `dictId=2&behaviorMode=4`，多人联约使用 HAR 确认的 `dictId=7&behaviorMode=1`，小队成员会自动接受官方邀请，最近联系人保持等待对方确认。
- Worker 自动签到：已支持按预约房间生成短效签到 key 并提交签到。当前 HAR 仅确认 room 2 的设备映射，production 默认开启自动签到，但未配置映射的房间会失败并记录原因，不会兜底使用其他房间设备。
- 签到入口：推荐配置 `SIGN_ROOM_SYSTEM_MAC_MAP`，值为房间 id 到 systemMac 的 JSON 映射。当前已确认 `{"2":"JWJA211231039"}`；旧的 `AUTHORIZED_SIGN_SYSTEM_MAC` 与 `AUTHORIZED_SIGN_ROOM_ID` 仅作为单房间兼容回退。
- 邮件发送：使用阿里企业邮 SMTP SSL，邮件先进入 `email_outbox`，再由 Cron 异步发送。

预约通过 `/api/studyroom/v1.1/reservation/reservation` 提交，并通过官方历史接口回读订单 ID。签到默认在预约开始前 15 分钟起由任一可用站内参与者尝试一次或多次，任意一人成功即可；自动签退默认在结束前 10 分钟由主预约人提交，随后回读官方状态避免重复请求。

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

项目只保留生产发布环境：

| 环境 | Worker | D1 | URL |
| --- | --- | --- | --- |
| production | `njau-libyy-production` | `njau-libyy-production` | `https://libyy.way2api.fun` |

GitHub Actions 会在 `main` 更新后自动执行 production D1 迁移并部署到 Cloudflare。`main` 可以直接修改并 push，不再要求通过 PR 发布。首次启用前，在仓库中设置：

- Repository variable：`CLOUDFLARE_ACCOUNT_ID`
- Repository secret：`CLOUDFLARE_API_TOKEN`
- production Environment secrets：`LIBYY_APP_SECRET`、`NJAU_PROXY_TOKEN`、`TOKEN_ENCRYPTION_KEY`、`SESSION_SECRET`、`PASSWORD_HASH_SECRET`、`SMTP_PASSWORD`
- 签到房间映射变量：`SIGN_ROOM_SYSTEM_MAC_MAP`，当前默认包含 `{"2":"JWJA211231039"}`；补齐其他房间后可扩大自动签到覆盖范围。
- 可选兼容签到入口 secrets：`AUTHORIZED_SIGN_SYSTEM_MAC`、`AUTHORIZED_SIGN_ROOM_ID`

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

production 已默认开启官方预约、多人预约、签到入口、自动签到和自动签退。当前自动签到只承诺 room 2；未配置当前预约房间映射时，系统不会使用其他房间设备兜底，以避免生成错误房间的签到链接或 key。

`data/` 和 `dirsearch/` 仅用于本地接口分析，已从版本库忽略。不要将任何明文 token 或密钥加入提交。
