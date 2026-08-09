# ClaudeDock 最终技术筛查清单

> 静态扫描基准：2026-08-09 当前工作树。本文用于最终技术筛查，不替代动态测试、签名验证或发布审计。

## 1. 扫描口径

已纳入：

- 第一方生产代码：`src/main`、`src/shared`、`src/renderer`
- 运行时资源：`assets/runtime`
- CI、构建、签名、发布、部署：`.github`、`scripts`、`deploy`、`package.json`
- 测试：`tests`
- 根目录及 `docs` 中的维护文档
- Agent 指令、系统提示词、subagent 定义和可复制提示词模板

未作为当前有效实现计入：

- `.git`、`node_modules`、`dist`、`outputs`、`release`、`coverage`、`.vite`
- 外部 checkout/vendor，如 `v2rayN-*`
- EXE、安装包、PDB 等生成物
- 当前工作树中已删除的 `roadmap.md`、`当前版本需改进的bug.md`
- 未跟踪的 diff/snapshot 文件仅列为历史材料，不视为生产实现

状态定义：

- **执行阻断**：生产代码实际抛异常、取消请求、拒绝操作或返回 `allowed: false`
- **安全回退**：不继续危险路径，回退到可信默认值、原生权限提示或离线数据
- **发布门禁**：命令非零退出，阻止 CI、签名、发布或部署
- **测试证据**：验证安全契约；测试文件本身不是运行时门禁
- **文档指令**：约束维护者或 Agent，文档本身不执行
- **历史材料**：只说明历史变化

---

## 2. 生产运行期安全门禁

| 文件路径                                                   | 核心函数或具体表述                                                                                                                                                                                 | 失败时的阻断行为                                                                                                                                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/main.ts:1027-1069`                               | `validateSender`、`validateSessionId`、`validatePtyGeneration`                                                                                                                                     | **执行阻断**：未知 Renderer IPC 抛出 `Rejected IPC from an unknown renderer.`；非法 session/generation 拒绝继续                                                                           |
| `src/main/main.ts:2263-2347`                               | Native conversation 启动参数、project、UUID、model、permission、owner 校验                                                                                                                         | **执行阻断**：任一身份或能力不匹配时抛异常，并释放未提交的 route reservation                                                                                                              |
| `src/main/main.ts:5483-5567`                               | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；`setWindowOpenHandler`；`will-navigate`                                                                                       | **执行阻断**：新窗口返回 `deny`；离开允许页面的导航调用 `preventDefault()`                                                                                                                |
| `src/main/main.ts:5807-5848`                               | 独立更新 session、可信更新源过滤                                                                                                                                                                   | **执行阻断**：不属于已选择可信源的更新 URL 返回 `{ cancel: true }`                                                                                                                        |
| `src/renderer/index.html:5-8`                              | 主页面 CSP：`default-src 'self'`、受限 `img-src`、`frame-src`、`object-src`                                                                                                                        | **执行阻断**：浏览器拒绝不符合 CSP 的远程脚本、对象、普通远程 iframe 和图片                                                                                                               |
| `assets/runtime/release-manifest-public-key.pem:1-3`       | 固定 Ed25519 release manifest 公钥                                                                                                                                                                 | 数据文件本身不执行；其他私钥生成的签名无法通过 manifest verifier                                                                                                                          |
| `assets/runtime/update-sources.json:1-19`                  | GitHub Release 与精确 HTTPS IP 镜像定义                                                                                                                                                            | 非法或被篡改的配置不会自动取得信任；加载器拒绝或回退编译时官方源                                                                                                                          |
| `src/main/application-update-manifest.ts:94-355`           | `compareApplicationVersions`、`parseManifestFile`、`verifyReleaseManifest`、`assertReleaseVersionFloor`、`readHighestTrustedVersion`、`recordHighestTrustedVersion`、`verifyDownloadedReleaseFile` | **执行阻断**：非稳定 SemVer、schema/key/source/timestamp/file 不合法、Ed25519 失败、版本低于当前或最高可信 floor、size/SHA-512 不匹配均抛异常                                             |
| `src/main/application-update-sources.ts:105-507`           | `parseSource`、`urlAllowedForSource`、`strictFetch`、`readBoundedBody`、`loadTrustedCandidate`、`selectApplicationUpdateSource`、`verifyDownloadedApplicationUpdate`                               | **执行阻断**：只允许 HTTPS/443、无 credentials/query/fragment 的固定 host/path；重定向逐跳重验；双渠道 manifest bytes 不一致或无可信候选时抛异常                                          |
| `src/main/application-updater.ts:57-259`                   | `autoDownload = false`、`autoInstallOnAppQuit = false`、`allowPrerelease = false`、`allowDowngrade = false`、`checkAndDownload`、`installDownloaded`                                               | **执行阻断**：禁止预发行版和降级；manifest、版本或安装器完整性失败进入 `error`；未达到 downloaded 状态不能安装                                                                            |
| `src/shared/provider-profiles.ts:51-333`                   | `PROVIDER_PROFILES`、`validateProviderProfile`、`blockingVersionRuleFor`；Claude Code 最低安全版本 `2.1.197`                                                                                       | **执行阻断**：非法 profile 在初始化时抛异常；命中 blocked version 或低于最低版本时拒绝启动                                                                                                |
| `src/main/provider-connectivity-probe.ts:98-568`           | `classifyNetworkError`、`probeDns`、`probeApplicationEndpoint`、`probeCliEndpoint`、`probeClientVersion`                                                                                           | **执行阻断/诊断**：TLS、证书、DNS rewrite、private-address、非法 redirect、HTML interception、最低版本失败会标记 required probe failed                                                    |
| `src/main/risk-decision-engine.ts:135-321`                 | TLS、redirect、captive portal、required endpoint、Claude SOCKS proxy 风险决策                                                                                                                      | **执行阻断**：关键网络条件或 required probe failed/unknown/skipped 返回 `allowed: false`、`status: 'blocked'`                                                                             |
| `src/main/network-preflight-service.ts:58-139`             | `run`                                                                                                                                                                                              | **执行阻断，fail-closed**：内部异常转换为风险分数 100、critical signal、`allowed: false`                                                                                                  |
| `src/main/provider-access-guard.ts:23-34`                  | `ProviderAccessGuard.assertAllowed`                                                                                                                                                                | **执行阻断**：失败抛出 `ProviderAccessBlockedError`，Provider 操作不继续                                                                                                                  |
| `src/main/electron-application-request.ts:15-95`           | `createElectronApplicationRequest`                                                                                                                                                                 | **执行阻断**：HTTP downgrade、redirect 超限、非法 redirect、超时或请求错误时 abort/reject                                                                                                 |
| `src/shared/connection-endpoint.ts:48-133`                 | `parseConnectionAddress`、`normalizeConnectionBaseUrl`                                                                                                                                             | **执行阻断**：禁止 credentials/query/fragment；非 loopback 地址必须 HTTPS；拒绝把 OpenAI endpoint 用作 Claude Anthropic base URL                                                          |
| `src/main/claude-configuration.ts:168-285`                 | `evaluateClaudeInstallation`、`normalizeClaudeConfig`                                                                                                                                              | **执行阻断**：`blocked-version`、`update-required` 时不可启动；非法模型、协议、认证、endpoint 抛异常；ChatGPT bridge 必须是 loopback + Bearer token                                       |
| `src/main/claude-runtime.ts:1638-1661,1761-1816`           | 启动前安装安全状态、connection snapshot、credential、provider、model 校验                                                                                                                          | **执行阻断**：安全状态必须是 `ready`；配置或连接快照变化、凭据或模型不合法时抛异常，不提供旧版本 fallback                                                                                 |
| `src/main/codex-runtime.ts:389-415,603-613`                | `validateLoginUrl`；安装状态和登录 URL 校验                                                                                                                                                        | **执行阻断**：Codex 未安装、URL 非 HTTPS 或不属于可信 OpenAI/ChatGPT host 时拒绝打开                                                                                                      |
| `src/main/github-release-routes.ts:22-116`                 | `buildGitHubReleaseRoutes`、`finalUrlAllowed`                                                                                                                                                      | **执行阻断**：只接受 GitHub HTTPS release URL 和可信 final host/path；非法 route 返回 `undefined`                                                                                         |
| `src/main/download-engine.ts:301-1009`                     | `DownloadEngine.start`、`acceptItem`、`complete`、`isAllowedUrl`、`isRecoverableEntry`、`verifyPartial`                                                                                            | **执行阻断**：要求 HTTPS、host/path allowlist、size cap、userData 路径牢笼；未 claim 下载调用 `preventDefault()`；非法 redirect/超限取消并删除 partial；字节数或 SHA-256 不符不 rename    |
| `src/main/codex-installer.ts:27-151`                       | `parseCodexReleaseInstaller`、`latest`、`installLatest`                                                                                                                                            | **执行阻断**：只接受官方 GitHub metadata、稳定 tag、精确 `install.ps1`、size/SHA-256；验证失败不执行 PowerShell                                                                           |
| `src/main/managed-chatgpt-gateway.ts:144-1022`             | `limitedResponseBody`、`parseCliProxyApiRelease`、`archiveEntriesAreSafe`、`extractRelease`、`processMatchesState`、`stopPersistedProcess`                                                         | **执行阻断**：拒绝 archive traversal、过大响应、hash/size 不符、staging 越界；只绑定 `127.0.0.1`；`safeStorage` 不可用时拒绝明文 key；不能证明进程身份时拒绝复用、切换或终止              |
| `src/main/cc-switch-adapter.ts:40-352`                     | `parseCcSwitchRelease`、`downloadLatestInstaller`、`removeGuardedDataDirectory`                                                                                                                    | **执行阻断**：只接受稳定 tag、MSI、GitHub path、SHA-256/size；缓存也重新验证；删除路径不在已知 AppData 目录时抛异常                                                                       |
| `src/main/proxy/application-proxy-store.ts:50-210`         | Proxy normalization、`ApplicationProxyStore.save`、credential decrypt                                                                                                                              | **执行阻断/安全回退**：非法 host/port/scope 拒绝；Claude CLI 不支持的 SOCKS 配置拒绝；`safeStorage` 不可用时拒绝保存密码；损坏配置回退 disabled defaults                                  |
| `src/main/proxy/application-proxy.ts:66-95`                | `parseApplicationProxyCandidate`                                                                                                                                                                   | **执行阻断**：仅允许 HTTP/SOCKS5；禁止 URL credentials/path/query/fragment；端口非法时返回 `undefined`                                                                                    |
| `src/main/claude-config-store.ts:198-305`                  | credential bounds、`safeStorage`、解密、`0600` 原子写                                                                                                                                              | **执行阻断**：禁止明文持久化；解密失败要求重新输入；临时文件成功后才 rename                                                                                                               |
| `src/main/chat-config-store.ts:42-213`                     | `normalizeChatBaseUrl`、`validateInput`、credential persistence/decrypt                                                                                                                            | **执行阻断**：拒绝远程 HTTP、URL credential/query/fragment、非法认证和 action；`safeStorage` 不可用时不保存凭据                                                                           |
| `src/main/conversation-recovery-store.ts:255-429`          | prompt 大小、`safeStorage`、digest、delivery state、journal 原子写                                                                                                                                 | **执行阻断**：加密失败时不发送也不明文落盘；delivery state 不确定时拒绝自动重发                                                                                                           |
| `src/main/chat-service.ts:82-199,859-918,1231-1234`        | 消息/附件限制；`validateRuntimeConfig`、`fetchWithRedirectPolicy`                                                                                                                                  | **执行阻断**：只允许 same-origin、credential-free 的 307/308；拒绝 301/302/303 method rewrite 和跨 origin 凭据泄露；响应超限取消 stream                                                   |
| `src/main/image-safety.ts:75-119`                          | `inspectSafeImage`                                                                                                                                                                                 | **执行阻断**：拒绝 SVG/XML-SVG；按 magic bytes 识别 PNG/GIF/JPEG/WebP；扩展名、尺寸或 4000 万像素上限不符时抛异常                                                                         |
| `src/main/chat-attachment-store.ts:279-564`                | draft ownership、`prepareSources`、`importPreparedSources`                                                                                                                                         | **执行阻断**：要求 absolute、regular、non-symlink、realpath、size/type/image 校验和 copy stability；失败清理当前 batch                                                                    |
| `src/main/native-attachment-store.ts:23-261`               | UUID/name/byte gate、`importFiles`、`get`、`importPrepared`                                                                                                                                        | **执行阻断**：最大 32 MiB；拒绝 symlink、非 regular、大小变化或不安全图片；损坏或替换时抛异常                                                                                             |
| `src/renderer/markdown.ts:258-767`                         | KaTeX `strict: 'error'`、`trust: false`；`safeExternalUrl`；allowlisted DOM renderer                                                                                                               | **执行阻断/安全降级**：不安全链接和 raw HTML 不生成活动内容，降级为文本；remote image 不自动加载；数学渲染失败显示原文                                                                    |
| `src/main/artifact-service.ts:187-578`                     | `registerArtifactScheme`、`guardFrameNavigation`、`handleProtocolRequest`、`installWebRequestAudit`、`loadSettings`                                                                                | **执行阻断**：自定义 scheme 不绕过 CSP；导航离开隔离文档时 `preventDefault()`；非法请求返回 400/404/410；网络关闭时 `{ cancel: true }`。损坏设置 fail-closed 为关闭网络                   |
| `src/renderer/artifact.ts:141-321`                         | 精确 custom URL；`sandbox="allow-scripts"`、无 `allow-same-origin`；`onMessage`                                                                                                                    | **执行阻断**：event source、JSON-RPC shape/size 不合法时忽略；iframe 无同源宿主权限                                                                                                       |
| `src/main/claude-permission-bridge.ts:39-269`              | `validWireRequest`、随机 named pipe/token、`respond`、`receive`                                                                                                                                    | **执行阻断**：active request、session、generation、suggestion ID、token、endpoint ownership 必须匹配；stale/unowned/超 64 KiB/非法 JSON 时关闭 socket                                     |
| `assets/runtime/claude-permission-hook.ps1:13-60`          | 输入 1 MiB 上限、tool/suggestion 校验、named-pipe 认证、600 秒等待                                                                                                                                 | **安全回退**：error/timeout 不生成 allow，回退 Claude Code 原生权限提示；明确不自动放行                                                                                                   |
| `assets/runtime/claude-web-search-guard.ps1:8-26`          | 专用 subagent 放行；其他主线程调用返回拒绝并 `exit 2`                                                                                                                                              | **混合策略**：合法但非专用 agent 的 WebSearch/WebFetch 被阻断；malformed JSON 刻意 `exit 0`，属于兼容性 fail-open                                                                         |
| `src/main/claude-agent-adapter.ts:224-227,320-360,915-980` | owner、permission capability、slash command、附件校验、`AskUserQuestion` 例外                                                                                                                      | **执行阻断**：未授权 `bypassPermissions`、未知 slash command、附件变化或越界时抛异常；`dontAsk` 下未被当前提示词明确要求的交互直接 deny                                                   |
| `src/main/conversation-owner-registry.ts:48-182`           | `claim`、owner/generation 验证、transfer transaction                                                                                                                                               | **执行阻断**：同 runtime/project/UUID 的第二个 owner 返回 `conflict`；身份变化时抛异常；rollback 不覆盖新 owner                                                                           |
| `src/main/runtime-process-registry.ts:253-452`             | `terminate`、`terminateSession`、`verifyTarget`、`verifiedSubtree`                                                                                                                                 | **执行阻断**：PID/start time、owner、generation、root/descendant、process type 必须可证明；无法证明时不 kill                                                                              |
| `src/main/claude-router-manager.ts:1344-1577`              | `stopCliService`、`readServiceAccess`、`requireActiveService`、`saveConfigWithoutProfileTakeover`、`rpcWithAccess`                                                                                 | **执行阻断**：Desktop-owned、unknown-owned、main process 或 ClaudeDock 自身拒绝终止；服务必须 loopback + token + 已验证 identity；强制 `applyProfile: false`；RPC 禁止 redirect、响应有界 |
| `src/main/mcp-manager.ts:337-565`                          | preview expiry、原文件 SHA-256、backup、atomic write、`restoreBackup`、remote MCP/stdio validation                                                                                                 | **执行阻断/安全回退**：preview stale 或文件变化时抛异常；写入失败 rollback；backup 越界拒绝；remote MCP 必须 HTTPS；非法 stdio command 不执行；registry 失败回退 curated offline entries  |
| `src/main/session-operation-coordinator.ts:46-128`         | `run`、`runLatest`、`cancel`                                                                                                                                                                       | **执行阻断**：同 session 只允许一个 terminal-mutating lease；busy/stale/invalidated 抛异常；replacement 等旧操作 cleanup 后重新校验                                                       |
| `src/main/main-process-operation-coordinator.ts:68-465`    | `ProjectRuntimeSwitchCoordinator`、`SessionConfigTransactionCoordinator`、`runOwnedConfigTransaction`                                                                                              | **执行阻断**：runtime switch 时禁止 development operation；writer 串行；tentative save 阻止 sibling launch；stale save 取消；rollback 不覆盖新配置                                        |
| `src/main/rollback-coordinator.ts:8-33`                    | `RollbackCoordinator`                                                                                                                                                                              | **事务门禁**：commit/rollback 后再添加步骤会抛异常；rollback once-only、逆序执行                                                                                                          |
| `src/main/route-lifecycle-coordinator.ts:34-72`            | reservation token、active usage gate                                                                                                                                                               | **生命周期阻断**：stale token 或 route 仍在使用时返回 `false`，不停止 route                                                                                                               |

---

## 3. CI、构建、签名、发布和部署门禁

| 文件路径                                                    | 核心函数或具体表述                                                                                                                         | 失败时的阻断行为                                                                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json:51-61,107-164`                                | `test:release-security`、`verify`、`pack`、`dist`；Windows SHA-256 signing algorithm、RFC3161 timestamp、NSIS                              | 命令失败非零退出；普通本地构建不必然强制签名，正式 release 由 workflow 的 `forceCodeSigning` 强制                                                           |
| `.github/workflows/ci.yml:14-58`                            | Gitleaks 全历史扫描、`npm audit --audit-level=high`、Windows `npm run verify`                                                              | **发布门禁**：任一步非零则 CI job 失败                                                                                                                      |
| `.gitleaks.toml:1-15`                                       | 窄范围 synthetic credential allowlist                                                                                                      | 不匹配 allowlist 的 secret finding 继续阻断 Gitleaks                                                                                                        |
| `.gitleaksignore:1-3`                                       | 两条历史 synthetic finding fingerprint                                                                                                     | 仅豁免指定 finding，不是通用 secret 绕过                                                                                                                    |
| `scripts/assert-no-bundled-claude.cjs:10-38`                | 扫描 unpacked tree 和 `app.asar` 中的第二份 `claude.exe`                                                                                   | **发布门禁**：发现重复 Claude executable 时抛异常                                                                                                           |
| `scripts/generate-release-manifest.mjs:21-132`              | stable SemVer、Ed25519 private key、key ID、UTC timestamp、SHA-512、canonical manifest、detached signature                                 | **发布门禁**：版本、私钥、文件集合、hash 或 metadata 失败即停止生成                                                                                         |
| `scripts/verify-release-bundle.mjs:56-205`                  | Ed25519、schema/source/version/timestamp、精确 artifact set、regular nonsymlink、size/SHA-512、`--against`                                 | **发布门禁**：签名、完整性、文件集合或对比差异均非零退出                                                                                                    |
| `scripts/verify-release-channels.mjs:6-250`                 | HTTPS-only、固定 URL/path、redirect/body bounds、双渠道 manifest bytes、HEAD/GET/Range/sample/cache headers                                | **发布门禁**：渠道不一致、redirect 不可信、TLS/HTTP、文件/hash/range/sample 异常时阻断                                                                      |
| `scripts/verify-authenticode.ps1:14-95`                     | `Assert-TrustedSignature`；`Valid`；exact signer subject；Code Signing EKU；timestamp；安装/卸载烟测                                       | **发布门禁**：安装器、应用 EXE、卸载器任一签名、发布者、EKU、时间戳、安装或卸载失败均 `throw`                                                               |
| `.github/workflows/release.yml:40-206`                      | stable version、exact tag、tag commit=`origin/main`、完整 secrets；签名、manifest、双渠道 staging、原子 promotion、补偿 rollback           | **发布门禁**：缺 secret、tag 不一致、已有 stable release、byte compare 或部署失败时停止；失败阶段恢复 mirror pointer，并删除或重新 draft GitHub publication |
| `deploy/server/claudedock-promote:4-72`                     | SemVer/run ID；staging owner；immutable version；精确五文件；regular、nonsymlink、root-owned、one hard link；signed bundle；原子 `current` | **部署门禁**：输入错误 exit `64`，状态/所有权/文件错误 exit `65`；验证完成前不切换公开版本                                                                  |
| `deploy/server/claudedock-rollback:4-25`                    | target 仅 `bootstrap` 或 stable SemVer；固定公钥和 expected version 重新验证；原子 symlink                                                 | **部署门禁**：目标非法或历史 release 无法重新验证时不回滚                                                                                                   |
| `deploy/server/claudedock-deploy.sudoers:1-3`               | deploy account 只允许 root 执行 promote/rollback                                                                                           | **权限门禁**：部署账号不能借此执行其他 root 命令                                                                                                            |
| `deploy/server/claudedock-cert-monitor:4-23`                | 证书至少剩余 48 小时；精确 IP SAN `124.221.158.247`；`nginx -t`；本地 HTTPS 真证书验证                                                     | **证书门禁/告警**：失败记录 error 并 exit `1`                                                                                                               |
| `deploy/server/claudedock-certbot-deploy-hook:4-6`          | `set -euo pipefail`、Nginx config test、reload、立即运行 cert monitor                                                                      | **部署门禁**：任一步失败中止证书 deploy hook                                                                                                                |
| `deploy/systemd/claudedock-certificate-monitor.service:1-8` | 调用证书 monitor                                                                                                                           | monitor 非零时 systemd unit 标记 failed                                                                                                                     |
| `deploy/systemd/claudedock-certificate-monitor.timer:4-8`   | 每小时 persistent 检查、randomized delay                                                                                                   | 只负责调度；不直接阻断已运行客户端                                                                                                                          |
| `deploy/nginx/claudedock-ip.conf:27-97`                     | 真实证书/key；TLS 1.2/1.3；session tickets off；错误 Host `421`；仅 GET/HEAD；`no-store`/`nosniff`；rate limit                             | **服务器阻断**：错误 Host、method 和 route 由 Nginx 拒绝；TLS 配置错误由部署前 `nginx -t` 阻断                                                              |
| `deploy/nginx/claudedock-ip-bootstrap.conf:6-14`            | bootstrap 只服务 ACME challenge                                                                                                            | **服务器阻断**：其他请求返回 `404`                                                                                                                          |
| `.github/workflows/mirror-monitor.yml:26-70`                | TLS、48 小时有效期、IP SAN、HTTPS health；alert issue                                                                                      | **监控门禁**：失败建立/更新告警 Issue 并 exit `1`                                                                                                           |

---

## 4. 实际运行时提示词和 Agent 指令

项目中存在一组运行时注入提示词，但它由显式开关控制且默认关闭。

| 文件路径                                           | 核心函数或具体表述                                                                                                                                                                                                     | 失败或不满足条件时的行为                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/main/claude-web-research.ts:7-19`             | 定义 session-local `claudedock-web-research` subagent。Agent prompt：`You are ClaudeDock web research worker. Perform only the delegated internet research... Do not edit files and do not delegate to another agent.` | 该 agent 仅拥有 `WebSearch`、`WebFetch`，没有 `Agent`、文件编辑或 shell 工具；不能继续递归委派 |
| `src/main/claude-web-research.ts:21-27`            | `CLAUDEDOCK_WEB_RESEARCH_SYSTEM_PROMPT`：要求主会话把在线检索完整委派给 `claudedock-web-research`，禁止主线程直接使用 WebSearch/WebFetch，并保持主线程 effort 不变                                                     | 属于模型层路由约束；若模型仍直接调用 web tool，由 PowerShell guard 再做确定性阻断              |
| `src/main/claude-runtime.ts:1973-1985`             | 仅在 `webResearchIsolation` 为真时传入 `agents` 和 `appendSystemPrompt`                                                                                                                                                | 开关关闭时传入 `{}`，不会注册 subagent，也不会附加 system prompt                               |
| `src/main/advanced-settings-store.ts:5-14,28-46`   | `webResearchIsolation: false` 默认值                                                                                                                                                                                   | **默认无注入**；设置缺失或损坏也回退为 `false`                                                 |
| `src/main/claude-configuration.ts:453-486`         | `ClaudeLaunchExtensions`；通过 `--agents` 和 `--append-system-prompt` 注入                                                                                                                                             | extensions 为空时不产生两个 CLI 参数；未使用 `--agent` 替换 Claude Code 默认行为               |
| `assets/runtime/claude-web-search-guard.ps1:17-26` | 非专用 agent 直接调用 web tool 时输出委派纠正指令                                                                                                                                                                      | **执行阻断**：合法非专用调用 `exit 2`；专用 agent `exit 0`                                     |
| `src/main/claude-agent-adapter.ts:249-274,320-360` | Native Agent SDK 会话把用户提交的 text/image blocks 原样送入 `prompt` async queue                                                                                                                                      | 未发现该路径额外拼接隐藏 system prompt；未知 `/command` 会被阻止作为普通提示词发送             |
| `src/main/claude-agent-adapter.ts:187-208,915-980` | 使用中英文 regex 判断当前用户提示词是否明确要求选择题/选项；`dontAsk` 下只对此开放一次 `AskUserQuestion`                                                                                                               | 未明确请求时返回 deny 消息；一次例外使用后立即消费，防止连续追问                               |
| `src/main/claude-permission-bridge.ts:193-201`     | 权限卡说明：`${toolName} 正在请求权限；具体工具输入保留在 Claude 原生终端中。`                                                                                                                                         | 不是 system prompt；bridge 验证失败时不显示可信 permission interaction                         |
| `tests/claude-web-research.test.ts:8-25`           | 验证 agent 固定 high effort、继承主模型、仅有 WebSearch/WebFetch，以及 system prompt 要求 `MUST delegate`                                                                                                              | **测试证据**：断言失败使测试非零                                                               |
| `tests/claude-configuration.test.ts:345-388`       | 验证开关打开时添加 `--agents`/`--append-system-prompt`，关闭时完全不添加                                                                                                                                               | **测试证据**：防止默认会话意外注入                                                             |

### 运行时提示词结论

1. 第一方生产代码中，明确的完整 system prompt/subagent prompt 主要集中在 `src/main/claude-web-research.ts`。
2. 默认会话不注册该 subagent，也不附加该 system prompt；`webResearchIsolation` 默认是 `false`。
3. Native Agent SDK 路径会将用户输入作为 user message 转发；静态扫描未发现该路径另行拼接隐藏 system prompt。
4. `claude-web-search-guard.ps1` 中的文本是工具拒绝后的纠正指令，不是主 system prompt。
5. 权限卡、错误信息、选择题标题等是 UI/工具反馈文本，不应误归类为模型 system prompt。

---

## 5. 包含完整提示词或 Agent 指令的文档

| 文件路径                             | 核心函数或具体表述                                                                                                                       | 失败时的阻断行为                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `AGENTS.md:1-51`                     | 仓库级 Agent 指令；包括不得修改 Desktop App、`applyProfile: false`、验证命令、版本、打包、发布、签名、secret 和镜像要求                  | **文档指令**：Agent 应停止越界修改或失败发布；文件本身没有程序化 enforcement           |
| `AGENTS.md:49-51`                    | “扫描或签名失败时保持仓库/Release 的安全状态并明确阻塞，不得绕过”                                                                        | **维护者门禁**：要求明确停止发布                                                       |
| `staged-repair-prompts.md:17-356`    | 总控提示词：“你现在是 ClaudeDock 项目的主要修复工程师……”；要求读取调用链、先写失败测试、最小根因修复、全量验证、版本、安装包、提交和推送 | **提示词门禁**：无法复现、验证失败或基线冲突时要求停止，不得声称修复                   |
| `staged-repair-prompts.md:357-400`   | 阶段 0 基线检查：“只检查，不修改文件，不提交、不 bump、不 push、不 dist”                                                                 | **提示词门禁**：基线报告完成后停止；需要关闭运行中的应用时必须先询问                   |
| `staged-repair-prompts.md:404-936`   | 阶段 1～11：持久化、网络、下载、MCP、Router、退出、更新、generation、permission、Renderer、Markdown/Artifact                             | **提示词门禁**：一次只处理当前阶段；越界、无法证明、需要产品决策或验证失败时停止       |
| `staged-repair-prompts.md:940-1020`  | 阶段 12 最终回归和发布审计，包含完整验收矩阵                                                                                             | **提示词门禁**：无代码变化时不制造空版本；验证失败不得宣称发布完成                     |
| `staged-repair-prompts.md:1024-1103` | 三个动态复现提示词；禁止只凭静态代码或人工单元测试修改生产代码                                                                           | **提示词门禁**：仅复现和报告，不修改、不 bump、不提交、不 push、不打包；等待批准后再修 |

---

## 6. 包含提示词、system prompt 或 subagent 行为说明的文档

这些文件描述提示词行为，但不是完整、直接执行的提示词模板。

| 文件路径                                                                                   | 核心表述                                                                                                                | 分类                   |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `README.md:8-11,42-44,58-60,152-155`                                                       | 用户提示词独立气泡；仅当当前提示词明确要求选项时允许结构化选择；默认不附加 system prompt/subagent；联网隔离开启时才附加 | 说明性文档             |
| `design.md:9-11,31-34,60-63,327-363,434-436,581-585`                                       | prompt UI、`dontAsk`、默认无系统提示词、多行 prompt、联网检索隔离                                                       | 产品设计契约           |
| `technical.md:15-16,86-87,164-166,361-362,488-491,1271-1309,1433-1469,1532-1549,1819-1851` | prompt 不落盘、多行 prompt、不注入隐藏提示词、`--agents`、`--append-system-prompt`、WebSearch guard                     | 架构说明               |
| `docs/releases/5.0.0-rc.6.md:16`                                                           | 用户提示词右侧强调色气泡                                                                                                | 历史说明               |
| `docs/releases/5.0.0-rc.7.md:8-9`                                                          | 当前提示词明确要求选项时允许结构化选择卡                                                                                | 历史说明               |
| `docs/releases/5.0.0-rc.8.md:11-12`                                                        | 引用 `staged-repair-prompts.md` 的总控和阶段提示词                                                                      | 索引                   |
| `docs/releases/5.0.0-rc.9.md:10`                                                           | 默认会话不附加 system prompt/subagent，显式隔离时才启用                                                                 | 历史说明               |
| `docs/LEGAL_COMPLIANCE.md:30-32`                                                           | 维护者不集中接收用户提示词                                                                                              | 合规说明               |
| `docs/cli-command-catalog.md`                                                              | `/agents`、`/subagents`、`/fewer-permission-prompts` 等 CLI 命令                                                        | 不是自然语言提示词模板 |

提示词文件筛查结论：

- 仓库中没有根目录 `CLAUDE.md`。
- 实际仓库级 Agent 规则文件是大写的 `AGENTS.md`。
- 完整可复制提示词主要集中在 `AGENTS.md` 和 `staged-repair-prompts.md`。
- 实际运行时注入提示词集中在 `src/main/claude-web-research.ts`。
- `README.md`、`design.md`、`technical.md` 主要描述提示词和注入机制，不是完整模板。
- `node_modules/*/AGENTS.md` 属于第三方依赖内容，未计入第一方提示词。

---

## 7. 安全、签名、回滚和证书文档

| 文件路径                                                                      | 核心函数或具体表述                                                                                                                            | 失败时的阻断行为                                     |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `README.md:96-103,261-285,337-349,376-385`                                    | Authenticode、双源签名更新、downgrade/redirect/channel mismatch 拒绝、Electron isolation、服务器 rollback                                     | **文档契约**：README 本身不执行                      |
| `CODE_SIGNING_POLICY.md:25-70`                                                | trusted Authenticode chain、exact publisher、timestamp、多层签名、双渠道 byte equality                                                        | **文档门禁**：不满足时不得称为 trusted stable binary |
| `SECURITY.md:23-31`                                                           | 漏洞报告和安全范围                                                                                                                            | 规定报告流程，无运行时阻断                           |
| `CONTRIBUTING.md:6-25`                                                        | verification；禁止 credential/private key/certificate password；漏洞私下报告                                                                  | **人工流程门禁**：违反时应拒绝合入                   |
| `.github/PULL_REQUEST_TEMPLATE.md:9-22`                                       | verification、risk/rollback、无 secrets/installers checklist                                                                                  | 人工 checklist，CI 不自动解析勾选项                  |
| `docs/UPDATE_MIRROR.md:11-121`                                                | trust model；禁止 HTTP/self-signed/TLS bypass；双渠道不一致 fail-closed；原子发布/回滚                                                        | **文档契约**                                         |
| `docs/LEGAL_COMPLIANCE.md:11-121`                                             | pinned signature、固定 HTTPS IP mirror、anti-downgrade、certificate monitor；Authenticode/compliance approval                                 | **正式发布文档门禁**                                 |
| `docs/PRIVACY.md:42-61`                                                       | 更新请求、signed manifest sample、双渠道冲突拒绝、CLIProxyAPI asset verification                                                              | 隐私和信任边界说明                                   |
| `technical.md:379-503,537-702,721-835,936-1103,1149-1175,1236-1266,1372-1468` | IPC、generation、permission、process ownership、download、safeStorage、redirect、attachment、Artifact、gateway、version gate、update security | **架构契约**：实际阻断点在生产代码                   |
| `design.md:33-34,359-413,532-660,707-806`                                     | permission refusal、Markdown allowlist、Artifact isolation、transaction rollback UI、blocked/warning/allowed UI、更新状态                     | **产品设计契约**                                     |
| `docs/plan-2.0.0.md`                                                          | 早期安全和架构规划                                                                                                                            | 规划材料，不作为当前实现证据                         |

历史发布说明：

- `docs/releases/4.1.0.md`
- `docs/releases/4.6.0.md`
- `docs/releases/4.6.1.md`
- `docs/releases/4.6.2.md`
- `docs/releases/5.0.0-rc.1.md`
- `docs/releases/5.0.0-rc.2.md`
- `docs/releases/5.0.0-rc.6.md`
- `docs/releases/5.0.0-rc.7.md`
- `docs/releases/5.0.0-rc.8.md`
- `docs/releases/5.0.0-rc.9.md`

以上均为**历史材料**，不承担当前运行时阻断。

---

## 8. 安全测试证据

测试失败会使对应测试命令非零，并在被 `npm run verify` 或 CI 调用时阻断 CI；测试文件本身不是生产运行时门禁。

### 8.1 更新、下载和安装器

| 文件路径                                           | 覆盖内容                                                |
| -------------------------------------------------- | ------------------------------------------------------- |
| `tests/application-update-manifest.test.ts:82-123` | manifest 签名、版本 floor、文件完整性                   |
| `tests/application-update-sources.test.ts:158-329` | trusted source、redirect、双渠道一致性、artifact sample |
| `tests/application-updater.test.ts:71-175`         | 禁止降级、downloaded 前独立校验                         |
| `tests/download-integrity.test.ts:51-82`           | size/hash 完整性                                        |
| `tests/download-engine.test.ts:15-273`             | HTTPS、redirect、partial、恢复、路径和 SHA-256          |
| `tests/download-contracts.test.ts:26-74`           | 下载契约和可信 URL                                      |
| `tests/github-release-routes.test.ts:27-38`        | GitHub final URL allowlist                              |
| `tests/electron-application-request.test.ts:6-46`  | downgrade、redirect、timeout                            |
| `tests/codex-installer.test.ts:19-56`              | Codex release metadata 和 SHA-256                       |
| `tests/cc-switch-adapter.test.ts:10-65`            | MSI metadata、cache integrity、guarded cleanup          |
| `tests/managed-chatgpt-gateway.test.ts:61-361`     | archive traversal、safeStorage、hash、process identity  |
| `tests/managed-chatgpt-cutover.test.ts:10-22`      | verified gateway cutover                                |

### 8.2 网络、Provider 和 Endpoint

| 文件路径                                                   | 覆盖内容                                    |
| ---------------------------------------------------------- | ------------------------------------------- |
| `tests/provider-profiles.test.ts:8-43`                     | Provider profile schema 和版本阻断规则      |
| `tests/provider-connectivity-probe.test.ts:30-111`         | TLS、DNS、redirect、HTML interception、版本 |
| `tests/network-preflight-service.test.ts:51-78`            | 预检内部错误 fail-closed                    |
| `tests/risk-decision-engine.test.ts:47-178`                | blocked/warning/allowed 决策                |
| `tests/connection-endpoint.test.ts:9-100`                  | HTTPS/loopback/URL credentials              |
| `tests/application-proxy.test.ts:35-185`                   | HTTP/SOCKS5、scope、credential persistence  |
| `tests/claude-configuration.test.ts:32-70,223-310`         | blocked version、endpoint、auth、bridge     |
| `tests/claude-runtime-diagnostics.test.ts:175-245,296-417` | runtime 安全状态、configuration snapshot    |
| `tests/codex-runtime.test.ts:51-202`                       | 安装状态和可信登录 URL                      |
| `tests/router-kernel.test.ts:32-39`                        | Router kernel 边界                          |

### 8.3 凭据、内容、附件、Artifact 和权限

| 文件路径                                           | 覆盖内容                                                    |
| -------------------------------------------------- | ----------------------------------------------------------- |
| `tests/chat-config-store.test.ts:33-119`           | HTTPS、safeStorage、decrypt                                 |
| `tests/chat-service.test.ts:26-73,237-269,678-752` | 输入限制、redirect policy、response cap                     |
| `tests/image-safety.test.ts:12-22`                 | magic bytes、SVG 拒绝、像素上限                             |
| `tests/chat-attachment-store.test.ts:32-175`       | symlink、realpath、ownership、atomic import                 |
| `tests/native-attachment-store.test.ts:24-42`      | 附件稳定性、损坏检测                                        |
| `tests/markdown-render.test.ts:38-232`             | raw HTML、安全 URL、KaTeX trust、remote image               |
| `tests/artifact-service.test.ts:139-403`           | custom protocol、CSP、network cancel、navigation            |
| `tests/artifact-renderer.test.ts:73-272`           | iframe sandbox、message source/shape                        |
| `tests/claude-permission-bridge.test.ts:31-62`     | token、generation、stale request                            |
| `tests/claude-web-search-guard.test.ts:28-57`      | subagent 放行、主线程拒绝、malformed fail-open              |
| `tests/native-conversation-service.test.ts:33-264` | Native conversation ownership、permission、stream lifecycle |
| `tests/conversation-owner-registry.test.ts:14-73`  | owner conflict 和 transfer rollback                         |

### 8.4 事务、Router、MCP 和 generation

| 文件路径                                                   | 覆盖内容                                           |
| ---------------------------------------------------------- | -------------------------------------------------- |
| `tests/mcp-manager.test.ts:18-86`                          | preview hash、stale apply、backup rollback         |
| `tests/claude-router-manager.test.ts:71-332`               | service identity、loopback/token、stop ownership   |
| `tests/router-profile-boundary.test.ts:9-28`               | `applyProfile: false` 边界                         |
| `tests/cli-only-guard.test.ts:29-50`                       | 不接管 Desktop App                                 |
| `tests/rollback-coordinator.test.ts:4-27`                  | once-only、逆序 rollback                           |
| `tests/session-operation-coordinator.test.ts:12-184`       | lease、stale generation、replacement cleanup       |
| `tests/main-process-operation-coordinator.test.ts:94-1012` | runtime switch、config transaction、owned rollback |
| `tests/main-config-transaction-integration.test.ts:32-108` | tentative save 与 sibling launch                   |
| `tests/session-operation-integration.test.ts:14-140`       | session mutating operation 串行化                  |
| `tests/session-generation.test.ts:23-148`                  | stale generation 结果不能覆盖新状态                |

---

## 9. 历史或生成型 diff 材料

| 文件路径                  | 筛查结论                                                         |
| ------------------------- | ---------------------------------------------------------------- |
| `commit-diff-snapshot.md` | 未跟踪历史 diff，可能包含旧 prompt/security 文本；不作为当前实现 |
| `commit-7b8b733.diff.txt` | 未跟踪历史 commit diff；不作为当前实现                           |
| `commit-7b8b733-raw.diff` | 未跟踪原始 diff snapshot；不作为当前实现                         |

---

## 10. 容易误判的关键词命中

| 文件或模式                                           | 实际含义                            | 筛查结论                                    |
| ---------------------------------------------------- | ----------------------------------- | ------------------------------------------- |
| `src/main/network-path-resolver.ts`                  | 观察或解析网络路径状态              | 不直接决定 `allowed: false`，不是主要阻断点 |
| `src/main/software-updates.ts`                       | 展示软件更新可用性的版本比较        | 不是 release manifest trust floor           |
| `src/main/model-speed-capabilities.ts`               | `blocked` 表示模型/速度 eligibility | 不等同于安全版本阻断                        |
| `build/installer.nsh` 中的 `Abort`                   | NSIS 页面或安装控制流               | 不是签名、证书或供应链信任校验              |
| Renderer 中普通 `blocked`、`disabled`、`cancelled`   | UI busy、按钮状态、用户取消         | 不应误判为主进程安全边界                    |
| `docs/cli-command-catalog.md`                        | CLI 命令目录                        | 不是提示词模板                              |
| `THIRD_PARTY_NOTICES.md`、`THIRD_PARTY_LICENSES.txt` | 第三方许可文本                      | 不属于第一方安全实现                        |
| `v2rayN-*/README.md`                                 | 外部参考 checkout                   | 排除                                        |
| `work/pr-body.md`                                    | ignored working document            | 排除                                        |
| `node_modules/*/AGENTS.md`                           | 第三方包内 Agent 指令               | 排除                                        |

---

## 11. 最终筛查需要重点确认的例外

1. **客户端和服务器的“回滚”语义不同**
   - 客户端 updater：禁止 downgrade，候选版本不得低于当前版本或最高可信 floor。
   - 服务器：允许切换到经固定公钥重新验证的历史 stable release。
   - 配置事务：允许 rollback，但不能覆盖由更新 generation/owner 写入的新状态。

2. **Web Search guard 不是完全 fail-closed**
   - 合法但非专用 subagent 的调用被 `exit 2` 拒绝。
   - malformed JSON 刻意 `exit 0`，属于兼容性 fail-open。
   - 这是本次扫描中最明确的安全例外，最终评审应确认该取舍仍符合产品要求。

3. **Web research system prompt 是条件注入**
   - `webResearchIsolation` 默认关闭。
   - 关闭时没有 ClaudeDock subagent，也没有 appended system prompt。
   - 开启后才形成“模型提示词路由 + PreToolUse guard”双层控制。

4. **Artifact 网络设置有特殊默认值**
   - 首次没有设置文件时，网络默认开启。
   - 设置文件损坏或不可读时，网络 fail-closed 为关闭。
   - 只有 durable save 成功后才更新内存状态。

5. **更新源测速不等于信任建立**
   - `sampleArtifact` 失败主要影响测速或 route 选择。
   - Ed25519、版本 floor、manifest bytes 和最终 SHA-512 才是信任依据。
   - 多个有效渠道提供不同 manifest bytes 时整体阻断。

6. **证书和镜像 monitor 主要是发布/运维门禁**
   - 失败会使 workflow/systemd unit 失败并建立告警 Issue。
   - 不会直接终止已启动的客户端或取消已开始的下载。

7. **测试和文档不能替代执行代码**
   - 测试仅证明预期行为。
   - `README.md`、`technical.md`、`design.md`、`AGENTS.md` 本身不执行阻断。
   - 最终技术筛查应以生产函数和 release workflow 为主，测试和文档作为证据链。

---

## 12. 扫描结论

- 供应链信任主链由固定 Ed25519 公钥、严格 manifest schema、版本 floor、双渠道 byte equality 和最终 SHA-512 构成。
- Authenticode、时间戳、证书 IP SAN、镜像原子 promotion 主要由发布和部署门禁执行。
- 运行时高风险操作普遍使用 sender、owner、generation、PID/start-time、路径牢笼或 safeStorage 进行 fail-closed 校验。
- 第一方完整提示词主要位于 `AGENTS.md`、`staged-repair-prompts.md` 和 `src/main/claude-web-research.ts`。
- 当前最值得单独评审的例外是 malformed WebSearch Hook payload 的兼容性 fail-open 行为。

本清单是静态分析结果；生成本文件时尚未以该清单替代测试、构建、签名、发布或安装烟测。
