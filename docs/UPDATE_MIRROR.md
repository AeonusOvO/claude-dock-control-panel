# ClaudeDock 国内更新镜像

ClaudeDock 4.1.0 使用两个稳定更新入口：

- GitHub Release：`https://github.com/AeonusOvO/claude-dock-control-panel/releases`
- 国内兜底镜像：`https://124.221.158.247/claudedock/windows/x64/`

镜像是 4 Mbps、300 GB/月的低并发兜底源，不是唯一更新源。腾讯云在 2026-07-23 更新的
[《备案场景》](https://cloud.tencent.com/document/product/243/18910)中明确：仅通过公网 IP
提供非经营性互联网信息服务同样需要 ICP 备案，但腾讯云备案系统暂不支持直接使用 IP 备案，需联系
属地通信管理局咨询办理。当前服务器因此只保留 TLS、证书续期和健康检查的工程验证，不公开稳定安装
包；取得可接受的备案/接入结论前不得把镜像投入正式分发。禁止为提高可达性降级到 HTTP、自签名证书
或忽略 TLS 校验。

## 信任模型

每个稳定版本只构建并签署一次。两个渠道必须分发同一组字节完全一致的文件：

```text
ClaudeDock-Setup-<version>-x64.exe
ClaudeDock-Setup-<version>-x64.exe.blockmap
latest.yml
release-manifest.json
release-manifest.sig
```

`release-manifest.json` 包含稳定版本、发布时间、文件大小、完整 SHA-512、测速样本 SHA-512、两个固定
下载地址和公钥标识。GitHub Actions 中的 Ed25519 私钥对规范 JSON 字节生成 detached signature；客户端
只内置公钥。私钥只能存在于 GitHub Actions Secret 或合规签名服务中。

GitHub 和镜像各自都能独立提供已签名清单，因此 GitHub 暂时不可达时客户端仍可安全使用镜像。若两个
渠道同时可用但清单字节不一致，客户端失败关闭。签名清单不能替代 Windows Authenticode；正式安装器、
应用可执行文件和卸载器还必须由受信任代码签名证书签署并带可信时间戳。

## TLS 与 Certbot

镜像使用 Let’s Encrypt short-lived 公网 IP 证书，SAN 必须精确包含 `124.221.158.247`。Certbot 必须
为 5.4 或更高版本；当前部署使用 snap 安装的 5.7.0。首次签发流程为：

```text
certbot certonly --preferred-profile shortlived \
  --webroot --webroot-path /var/lib/letsencrypt \
  --ip-address 124.221.158.247
```

在生产签发前先使用 `--staging` 验证 ACME 路径。证书有效期约 160 小时，不能采用传统 60 天一次的
检查频率。服务器保留 Certbot 自带自动续期，另有每小时 systemd timer 验证剩余有效期、IP SAN、
Nginx 配置和本机 TLS 健康端点。deploy hook 在续期后执行 `nginx -t`、reload 和证书监控。续期失败或
证书不足 48 小时必须产生非零状态并进入运维告警；GitHub Actions 还会每 6 小时从公网独立验证并维护
告警 Issue。

签发和续期验收至少包括：

```text
certbot renew --dry-run
openssl x509 -in /etc/letsencrypt/live/124.221.158.247/fullchain.pem \
  -noout -issuer -dates -ext subjectAltName
```

Windows 验收必须由系统信任链完成，不能传入 `--insecure` 或关闭证书验证。`deploy/nginx/` 与
`deploy/systemd/` 保存可审查配置；修改线上 Nginx 前先备份完整配置和证书目录。

## HTTP 行为

Nginx 只为精确公网 IP 提供该路径，并满足：

- 80 端口只保留 ACME challenge，其余请求用 308 跳到同一 IP 的 HTTPS；
- 443 只允许 TLS 1.2/1.3，错误 Host 返回 421；
- 文件只允许 `GET` 和 `HEAD`，支持 `Range`、`206 Partial Content`、精确 `Content-Length` 和
  `Accept-Ranges: bytes`；
- `latest.yml`、manifest 和签名使用 `Cache-Control: no-store`；版本化安装器和 blockmap 使用
  `Cache-Control: public, max-age=31536000, immutable`；
- 元数据请求使用短超时和大小上限，下载连接有带宽/并发边界；
- 客户端只接受固定 IP、默认 443 和固定路径，拒绝用户信息、query、fragment、无限重定向和跨主机
  重定向。

## 原子部署与回滚

GitHub Actions 使用独立、锁定密码、仅能写入 incoming 目录的部署账号和专用 SSH 密钥。该账号不能
写发布目录，也不能修改 Nginx；它只被 sudoers 允许执行参数受限的 promote/rollback 脚本。长期管理
密钥、证书私钥、manifest 私钥和代码签名凭据不得进入仓库、客户端、Issue、PR、日志或 Release。

发布顺序如下：

1. 在 Windows runner 上从已验证的 `main` 标签执行完整测试，只构建一次安装产物。
2. 对应用可执行文件、生成的卸载器和最终安装器依次 Authenticode 签名并加可信时间戳。
3. 运行安装/卸载烟测和 `Get-AuthenticodeSignature` 验证链。
4. 生成并签署 release manifest，在本地核对 `latest.yml` 与所有文件的大小和 SHA-512。
5. 创建 GitHub draft Release，上传同一组文件，再完整下载并与本地逐字节比较。
6. 将同一组文件上传到服务器的版本化 incoming 目录。root 端再次验证 manifest、公钥、版本、路径、
   大小和 SHA-512，然后移动为不可变版本目录。
7. GitHub Release 发布成功后，服务器用原子符号链接切换 `current`；在此之前稳定 `latest.yml` 不可见。
8. 从两个公网入口重新执行 GET、HEAD、Range、缓存头、完整 SHA-512、签名和跨渠道一致性检查。
9. 任一步失败则阻止稳定发布、恢复旧 `current` 并撤销错误 Release。服务器至少保留最近两个稳定版本。

发布工作流所需 Secrets 至少包括独立镜像主机、端口、用户、SSH 私钥和 known_hosts，manifest 签名
私钥，以及 Windows 代码签名证书/服务凭据。Secret 名称与门禁逻辑以
`.github/workflows/release.yml` 为准。

## 客户端防护

客户端先验证清单，再接受更新版本和下载 URL；不会把能读取某个 `latest.yml` 当成信任依据。防护包括：

- 清单、签名和 `latest.yml` 大小上限；
- 严格 SemVer 稳定版和本地最高已接受版本，拒绝降级；
- 真实 206 样本必须同时满足状态、范围、长度和样本摘要；
- 下载完成后再次验证完整安装器的长度与 SHA-512，失败时保留当前可运行版本；
- electron-updater 会话只允许访问当前选定源的固定主机和无 query URL；
- UI 区分 GitHub、国内镜像、清单签名、元数据、样本与完整文件校验失败原因。

## 运维验收

每次发布和证书变更后至少执行：

- `npm run test:release-security`；
- `node scripts/verify-release-bundle.mjs <bundle>`；
- `node scripts/verify-release-channels.mjs <version>`；
- Windows 安装/卸载烟测和 Authenticode 验证；
- GitHub 不可用、清单篡改、安装包篡改、版本回退、伪造 Range、跨主机重定向和渠道不一致测试；
- Certbot 续期 dry-run、证书 IP SAN、Windows 信任链、Nginx reload hook 和监控 timer；
- 境内外独立节点的 HTTPS GET/HEAD/Range、超时、缓存头、大小与 SHA-512 检查。

4 Mbps 链路按约 132.5 MiB 安装包估算，理想单次下载约 4.6 分钟；300 GB/月的理论上限还要扣除
blockmap、重试、协议和系统流量。用户规模上升后应使用合规 CDN/对象存储或提高带宽，并重新评估
日志、隐私、备案和接入要求。
