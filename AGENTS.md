# ClaudeDock 项目规则

- 项目定位：Windows 桌面 PowerShell 控制面板；不得修改 Codex、Claude Code 或系统级 API 路由。
- 路由接管边界：只管理 Claude Code / Codex 的 CLI 会话。不得安装、卸载、终止或改写 Claude、Codex、
  CCR 的桌面 App；CCR RPC 保存配置必须保持 `applyProfile: false`，由 ClaudeDock 启动 CLI 时注入本机路由。
- 必读文档：`README.md`、`design.md`、`technical.md`。
- 入口：`src/main/main.ts`、`src/preload/preload.ts`、`src/renderer/main.ts`。
- 修改后至少运行：`npm run lint`、`npm run format:check`、`npm run typecheck`、`npm test`、
  `npm run test:layout`、`npm run test:control-theme`、`npm run build`。
- UI、运行方式或技术实现变化时，同步检查三个根目录文档。
- 生成目录：`dist/`、`outputs/`；Electron Builder 的安装包、校验元数据和解包目录统一输出到
  `outputs/`，不得再复制到项目根目录，生成目录和安装包均不提交 Git。
- 每次完成项目修改都必须更新 `package.json` 与 `package-lock.json` 中的版本号，不得沿用
  上一次发布版本。结合 SemVer 与项目发布尺度自主判断：不兼容或架构级变更升主版本，
  有明确发布价值的成组/重大新功能升次版本，小功能优化、修复、文档、构建或维护改动升
  修订版本；不要仅因为出现了新行为就机械升次版本，判断不确定时在最终说明中写明依据。
- 完成验证和版本更新后必须运行 `npm run dist`。确认
  `outputs/ClaudeDock-Setup-<version>-x64.exe` 以及配套的 blockmap、`latest.yml` 和
  `win-unpacked/` 均在 `outputs/` 中生成；不得把安装包或配套产物复制到项目根目录。
- 最终回复必须写明版本变更（旧版本 → 新版本）和本轮生成的安装包路径；若打包失败，必须说明
  失败原因和未生成的产物，不得把只有 `npm run build` 描述成已完成发布。
- 除首次骨架或紧急修复外，在 `codex/feature-*`、`codex/fix-*`、`codex/docs-*` 等短生命周期分支
  开发；验证后提交、推送并创建 PR，CI 成功后才合并 `main`。不要从非 `main` 的临时分支继续堆叠
  发布 PR。
- 会影响用户软件或发布配置的修改必须走完整发布闭环：版本号与 SemVer 一致、上述检查全部通过、
  从 `main` 创建完全匹配 `package.json` 的 `v<version>` 标签，并由 `.github/workflows/release.yml`
  构建一次、签名一次、同时发布 GitHub Release 与国内兜底镜像。纯分析或无文件变化不得制造空版本。
- 稳定 Release 必须包含同一构建产生的安装器、blockmap、`latest.yml`、独立签名的
  `release-manifest.json` 与 `release-manifest.sig`。发布流水线必须比较两个渠道的大小、SHA-512 和
  清单签名；服务器先写版本化临时目录并验证，再原子切换 `current`，任一渠道失败都不得公开稳定
  `latest.yml`，并至少保留最近两个稳定版本供回滚。
- 稳定发布前必须完成受信任 Authenticode 签名和时间戳，验证安装器、应用可执行文件、卸载器的
  Windows 信任链，并运行安装/卸载烟测、GitHub 更新、镜像更新、GitHub 不可用、清单/安装包篡改、
  版本回退、镜像不一致、TLS 续期 dry-run 与跨渠道 SHA-512 测试；不能把自签名或 `NotSigned`
  描述成正式签名。
- GitHub Actions 只使用独立镜像主机、用户、端口、部署私钥、manifest 签名私钥和代码签名服务凭据
  Secrets。任何私钥、Token、证书密码、管理凭据、非公开管理端点/用户名或本机凭据路径都不得进入
  仓库、Release、安装包、客户端源码、Issue、PR、日志或最终回复；客户端只固定 release manifest 公钥。
- 网络预检只允许访问服务商配置中的官方端点；不得恢复第三方公网地址、地区、ASN 或网络信誉请求，
  不得根据用户位置作判断。外部应用代理只传递用户填写的连接参数，不读取或迁移旧版网络配置。
- 国内镜像只允许精确的 `https://124.221.158.247/claudedock/windows/x64/`，不得降级到 HTTP、自签名
  证书或忽略 TLS。维护 Certbot `shortlived` IP 证书、自动续期、失败监控和 Nginx reload hook；
  公网 IP 下载服务不等于规避备案、接入商或其他适用监管要求。
- 公开仓库或正式发布前必须重新扫描 Git 全历史与工作树秘密、依赖漏洞/许可、大文件、隐私信息和发行
  包残留；核对 LICENSE、NOTICE、第三方许可、隐私/合规、SECURITY、贡献指南、行为准则、Issue 模板
  与发布说明。扫描或签名失败时保持仓库/Release 的安全状态并明确阻塞，不得绕过。
