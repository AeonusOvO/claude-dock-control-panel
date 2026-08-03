# ClaudeDock 自建更新镜像部署指南

ClaudeDock 4.0.0 支持 GitHub Release 与一个或多个自建 HTTPS 静态源自动择优。镜像不是业务 API，
不需要数据库；它只需要可靠地公开同一 Release 的更新元数据和文件。

## 启用前需要维护者提供

1. 专用域名，例如 `updates.example.com`，以及将其解析到服务器的 DNS 权限；
2. 域名和服务器的 ICP 备案/接入商要求确认，及服务器安全组 443 入站权限；
3. HTTPS 证书方案（推荐 ACME 自动续期）和告警联系人；
4. GitHub Actions 使用的最小权限 SSH/SFTP 部署账号与独立部署密钥；
5. 是否通过 CDN、预计并发/下载量、日志保留期限和隐私联系人；
6. Windows 代码签名证书的发布者主体及 CI Secret 名称。

不要发送或提交日常管理员私钥。应在服务器创建只能写更新目录的部署账号和专用密钥，私钥只保存到
GitHub Actions Secrets。客户端、仓库、Issue、日志和 `update-sources.json` 都不能包含私钥或 Token。

## 文件布局

推荐公开基础地址：

```text
https://updates.example.com/claudedock/windows/x64/
├── latest.yml
├── ClaudeDock-Setup-4.0.0-x64.exe
└── ClaudeDock-Setup-4.0.0-x64.exe.blockmap
```

三个文件必须来自同一次 `electron-builder` 发布。先上传到版本化临时目录，核对大小和摘要后再原子切换
公开目录；禁止先发布 `latest.yml` 再上传安装包。至少保留最近两个已签名版本用于回滚。

## HTTP 要求

- 只接受 HTTPS；客户端会忽略 HTTP、带账号密码、query 或 fragment 的基础地址。
- 匿名 `GET`/`HEAD` 可用，支持 `Range` 和 `206 Partial Content`，返回正确 `Content-Length`。
- 不使用 Cookie、登录页、验证码、JavaScript 跳转或目录索引。
- `latest.yml` 使用 `Cache-Control: no-cache, no-store, must-revalidate`；带版本号的 `.exe` 和
  `.blockmap` 可使用 `Cache-Control: public, max-age=31536000, immutable`。
- 正确返回 MIME 类型；限制请求方法；监控证书到期、4xx/5xx、Range、带宽和磁盘空间。

最小 Nginx 位置示例（域名、根目录和证书路径按实际环境替换）：

```nginx
server {
    listen 443 ssl http2;
    server_name updates.example.com;

    ssl_certificate     /etc/letsencrypt/live/updates.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/updates.example.com/privkey.pem;

    location = /claudedock/windows/x64/latest.yml {
        root /srv/claudedock/public;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        try_files $uri =404;
    }

    location /claudedock/windows/x64/ {
        root /srv/claudedock/public;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        limit_except GET HEAD { deny all; }
        try_files $uri =404;
    }
}
```

## 客户端配置

服务器通过下列验收后，才在 `assets/runtime/update-sources.json` 增加：

```json
{
  "id": "china-mirror",
  "label": "中国大陆更新镜像",
  "provider": "generic",
  "baseUrl": "https://updates.example.com/claudedock/windows/x64/",
  "allowedHosts": ["updates.example.com"]
}
```

GitHub 源必须保留且排在配置中。每次用户开始应用更新时，客户端先读取 GitHub 的规范 `latest.yml`，
再读取所有镜像元数据；只有版本、`path` 和 SHA-512 完全相同的镜像才参与 256 KiB 真实安装包采样，
随后把 `electron-updater` feed 切到实测速率最快的来源。若 GitHub 元数据不可验证，客户端回落到 GitHub，
不会单独信任镜像。

## 发布与验收

发布流水线至少完成：

1. `npm ci`、lint、类型检查、测试、构建和 Windows 打包；
2. 校验 Git 标签、`package.json`、`latest.yml` 和文件名版本一致；
3. 验证安装包 Windows 签名和 `latest.yml` SHA-512；
4. 发布 GitHub Release；
5. 用最小权限账号同步三份文件到镜像临时目录；
6. 从境内外节点分别验证 HTTPS、HEAD、Range、SHA-512 和完整下载；
7. 原子切换公开目录，再监控错误率与带宽。

当前已审计服务器为 2 核、2 GB、50 GB SSD、4 Mbps、300 GB/月。它可承载静态镜像，但 4 Mbps 只适合
低并发兜底；约 132.5 MiB 安装包理想满速下载约 4.6 分钟，300 GB 理论上约 2,200 次完整下载/月，
实际容量更低。用户规模上升后应使用合规 CDN/对象存储或提高带宽。
