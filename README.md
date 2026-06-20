# NJAU Libyy

南京农业大学图书馆研讨室预约辅助系统。当前架构已经迁移为国内服务器 Docker Compose 部署：React 前端、Node API、SQLite、定时任务和 Tailscale 校园网出口运行在同一个 Compose 栈内。

## 架构

- `app`：Node 22 服务，托管 `apps/web/dist` 静态前端和 `/api/v1/*` API。
- `tailscale`：官方 `tailscale/tailscale` 镜像，用作 `app` 的共享 network namespace。
- Compose 固定向 Tailscale 注入 `--reset --accept-routes=false --accept-dns=false`，启动时清理旧 prefs，且不接收 tailnet 路由或 DNS 配置，避免 `app` 的公网出站被 tailnet 路由或 MagicDNS 接管。`.env` 中的 `TS_EXTRA_ARGS` 只用于追加额外参数。
- `app` 使用 Playwright 官方 Chromium 的非 root 沙箱；Compose 加载 `docker/playwright-seccomp.json` 以允许 Chromium 创建隔离的 user namespace。
- `SQLite`：默认数据文件 `/data/njau-libyy.sqlite`，由 Compose volume 持久化。
- `Official Access Gateway`：所有官方 HTTP 和 Playwright 自动化统一经过该层；SQLite 保存分层快照与持久化 job，进程内执行器提供 SingleFlight、分读写通道限流和短暂等待。
- `scheduler`：Node 服务内每分钟执行自动预约、签到、签退、邮件 outbox 和清理任务。
- `SMTP`：Node TLS 直连阿里企业邮。

前端保持同源 API 访问，不需要跨域配置。你的反向代理只需要把公网域名转发到服务器本机 `127.0.0.1:3000`。

页面首次加载只读取 SQLite 快照。房间快照按日期全站共享，积分、预约同步和队伍积分按用户隔离；用户点击刷新后 API 返回 `jobId`，前端轮询 `/api/v1/official-jobs/:jobId`，任务完成后再读取最新快照。预约、取消、签到链接和签退同样进入持久化写队列，关键操作允许短暂等待，但不会因客户端断开而丢失任务。

默认 Compose 只监听 `127.0.0.1:3000`，适合 Nginx/Caddy 反向代理。如果确实要公网直接访问服务器 `3000` 端口，将 `.env` 中的 `APP_BIND_ADDR` 改为 `0.0.0.0` 后重新 `docker compose up -d`。

## 本地开发

```powershell
npm install
Copy-Item .env.example .env
npm run build
npm run dev
```

开发时如果只调前端：

```powershell
npm run dev:web
```

前端 dev server 会把 `/api` 代理到 `http://localhost:3000`。

## Docker Compose 部署

1. 复制环境变量模板：

```powershell
Copy-Item .env.example .env
```

2. 设置至少这些值：

- `TS_AUTHKEY`
- `APP_BASE_URL`
- `LIBYY_APP_SECRET`
- `CAS_CREDENTIAL_ENCRYPTION_KEY`（独立的 32 字节 base64url 密钥）
- `SMTP_PASSWORD`

`TOKEN_ENCRYPTION_KEY`、`SESSION_SECRET`、`PASSWORD_HASH_SECRET` 可留空，Node 运行时会使用内置兜底值启动。生产环境仍建议设置为稳定随机值，并在后续升级和数据迁移时保持不变。

可用以下命令生成独立的 CAS 密码加密密钥：

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).TrimEnd('=').Replace('+','-').Replace('/','_')
```

3. 确认 Tailscale tailnet 中已有能访问校园网的 subnet router，并在 Tailscale 管理端批准对应 route。不要把普通路由器节点配置成 `--exit-node`，除非它已经确认能稳定转发容器的全部公网出站流量。

4. 启动：

```powershell
docker compose up -d --build
```

5. 健康检查：

```powershell
Invoke-WebRequest http://127.0.0.1:3000/api/v1/health
```

## GitHub Actions 预构建并上传 R2

`main` 分支每次 push 后，GitHub Actions 会先执行 `npm run typecheck` 和 `npm run build`，然后构建生产 Docker 镜像，将镜像 tar 包、release compose 文件和 manifest 上传到 Cloudflare R2：

```text
https://cloud.way2api.fun/NJAU/latest/manifest.json
https://cloud.way2api.fun/NJAU/latest/docker-compose.yml
https://cloud.way2api.fun/NJAU/latest/env.example
https://cloud.way2api.fun/NJAU/latest/njau-libyy-app-<commit>.tar.gz
```

同时会保留一个按 commit 区分的版本目录：

```text
https://cloud.way2api.fun/NJAU/<commit>/
```

需要在 GitHub 仓库 Settings -> Secrets and variables -> Actions 中配置：

| Secret | 说明 |
| --- | --- |
| `CLOUDFLARE_R2_ACCOUNT_ID` | Cloudflare Account ID |
| `CLOUDFLARE_R2_ACCESS_KEY_ID` | R2 API Token 的 Access Key ID |
| `CLOUDFLARE_R2_SECRET_ACCESS_KEY` | R2 API Token 的 Secret Access Key |
| `CLOUDFLARE_R2_BUCKET` | R2 bucket 名称；不填时工作流默认使用 `cloud.way2api.fun` |

R2 token 需要具备目标 bucket 的对象读写权限。`cloud.way2api.fun` 需要在 Cloudflare R2 中绑定为该 bucket 的公开访问域名，否则服务器无法通过 HTTPS 直接下载。

## 服务器从 R2 产物自动更新

服务器不需要重新编译项目。首次准备目录：

```bash
apt-get update && apt-get install -y aria2 curl
mkdir -p /opt/NJAU-Libyy/scripts
cd /opt/NJAU-Libyy
curl --http1.1 -4 -fsSL https://cloud.way2api.fun/NJAU/latest/env.example -o .env.example
cp .env.example .env
nano .env
```

至少配置 `TS_AUTHKEY`、`APP_BASE_URL`、`LIBYY_APP_SECRET`、`SMTP_PASSWORD` 等生产变量。

下载更新脚本：

```bash
curl --http1.1 -4 -fsSL https://raw.githubusercontent.com/<你的用户名>/<你的仓库>/main/scripts/server-r2-update.sh -o /opt/NJAU-Libyy/scripts/server-r2-update.sh
chmod +x /opt/NJAU-Libyy/scripts/server-r2-update.sh
```

手动更新一次：

```bash
APP_DIR=/opt/NJAU-Libyy \
R2_PUBLIC_BASE_URL=https://cloud.way2api.fun/NJAU \
/opt/NJAU-Libyy/scripts/server-r2-update.sh
```

脚本会：

- 下载 `latest/manifest.json`
- 使用 `aria2c`、IPv4 和最多 16 个连接并行下载发布文件
- 下载预构建 Docker 镜像 tar.gz
- 下载 release 版 `docker-compose.yml`
- 下载 Playwright Chromium 沙箱所需的 `docker/playwright-seccomp.json`
- 备份当前 SQLite 到 `/opt/NJAU-Libyy/backups`
- 执行 `docker load`
- 先启动/保持 `tailscale`，再使用新镜像强制重建 `app` 容器
- 检查 `/api/v1/health`
- 健康检查成功后清理旧 Docker 镜像 tag 和旧镜像下载包；默认保留最近 2 个版本，可通过 `IMAGE_RETENTION_COUNT` 调整
- 健康检查成功后写入 `.deployed-version`，后续同版本会跳过

### systemd 定时自动更新

创建 service：

```bash
cat >/etc/systemd/system/njau-libyy-update.service <<'EOF'
[Unit]
Description=Update NJAU Libyy from R2 release artifact
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=APP_DIR=/opt/NJAU-Libyy
Environment=R2_PUBLIC_BASE_URL=https://cloud.way2api.fun/NJAU
ExecStart=/opt/NJAU-Libyy/scripts/server-r2-update.sh
EOF
```

创建 timer，每 3 分钟检查一次 R2 的 latest 产物：

```bash
cat >/etc/systemd/system/njau-libyy-update.timer <<'EOF'
[Unit]
Description=Poll NJAU Libyy R2 release artifact

[Timer]
OnBootSec=2min
OnUnitActiveSec=3min
Unit=njau-libyy-update.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now njau-libyy-update.timer
```

查看自动更新日志：

```bash
journalctl -u njau-libyy-update.service -f
```

## 关键环境变量

| 变量 | 说明 |
| --- | --- |
| `TS_EXTRA_ARGS` | 追加的 Tailscale 启动参数；Compose 已固定注入 `--reset --accept-routes=false --accept-dns=false`，通常保持为空 |
| `IMAGE_RETENTION_COUNT` | 自动更新脚本保留的 `njau-libyy-app:<commit>` 镜像版本数量，默认 `2` |
| `APP_BIND_ADDR` | Compose 端口绑定地址，默认 `127.0.0.1`；公网直连 3000 时设为 `0.0.0.0` |
| `LIBYY_API_BASE_URL` | 官方图书馆接口地址，默认 `https://libyy.njau.edu.cn` |
| `CAS_CREDENTIAL_ENCRYPTION_KEY` | 加密统一认证密码的独立 32 字节 base64url 密钥，必须配置且不得与 token 密钥相同 |
| `PLAYWRIGHT_PROFILE_DIR` | 每用户隔离的 Chromium profile 根目录，Compose 默认 `/data/playwright-profiles` |
| `PLAYWRIGHT_MAX_CONCURRENCY` | 同时运行的统一认证浏览器数量，默认 `2` |
| `OFFICIAL_READ_CONCURRENCY` | 官方只读请求与刷新 job 最大并发，默认 `3` |
| `OFFICIAL_WRITE_CONCURRENCY` | 官方写请求最大并发，默认 `1`，避免并发提交 |
| `OFFICIAL_REQUEST_MIN_INTERVAL_MS` | 官方请求启动间隔，默认 `150ms` |
| `OFFICIAL_JOB_POLL_INTERVAL_MS` | SQLite job 调度轮询间隔，默认 `250ms` |
| `SIGN_ROOM_SYSTEM_MAC_MAP` | 房间 id 到签到设备 `systemMac` 的 JSON 映射 |
| `SQLITE_PATH` | 容器内 SQLite 文件路径，Compose 默认 `/data/njau-libyy.sqlite` |
| `WEB_DIST_DIR` | React 构建产物目录，Compose 默认 `/app/apps/web/dist` |

## 校验

```powershell
npm run typecheck
npm run build
```

或一次执行：

```powershell
npm run check
```

## 数据迁移

旧 Cloudflare D1 数据需要先导出为 SQLite 可导入 SQL，再导入 Compose volume 中的数据库文件。迁移时保持相同的 `TOKEN_ENCRYPTION_KEY`，否则已加密的官方凭证、手机号和邮件 outbox payload 无法解密。

建议流程：

1. 停止旧服务写入。
2. 导出 D1 数据。
3. 在服务器上启动一次 Compose，让 migrations 创建完整 schema。
4. 停止 Compose。
5. 将导出的业务表数据导入 `/data/njau-libyy.sqlite`。
6. 重新启动 Compose。

## 前端设计

前端实现以 `DESIGN.md` 为最高视觉规范：白色画布、近黑主操作、浅灰卡片、pill 导航、8px 输入/按钮、12px 卡片和真实产品 UI 片段。首屏是登录与工作台入口，不做营销落地页。

`data/` 和 `dirsearch/` 仅用于本地接口分析，已从版本库忽略。不要将任何明文 token 或密钥加入提交。
