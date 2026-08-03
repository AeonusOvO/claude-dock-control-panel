# ClaudeDock 控制面板

ClaudeDock 是面向 Windows 的开源 Electron 桌面控制面板，用图形界面管理多个项目的真实
PowerShell/ConPTY 终端、Claude Code 与 Codex 开发会话、模型接入、MCP、插件和软件更新。

当前代码版本为 **4.1.1**，许可证为 **Apache-2.0**。4.1.1 的正式稳定版必须同时通过可信
Authenticode 签名、GitHub Release 与国内 HTTPS 镜像一致性验收；在这些门禁完成前，本地构建
只用于开发和测试，不应被描述为正式签名发行版。

## 项目边界

- 每个项目拥有独立的 Windows PowerShell/ConPTY 会话，可以同时在后台运行。
- 每个项目可选择 Claude Code 或 Codex。ClaudeDock 只负责启动与显示必要状态，不读取或改写
  Codex 的 OAuth 凭据，也不修改 Codex、Claude Code 或 Windows 的系统级 API 路由。
- 模型/API 配置只注入 ClaudeDock 为当前项目启动的子进程。保存的密钥使用 Electron
  `safeStorage`（Windows 上为 DPAPI）加密，不写入项目、命令行或终端历史。
- “对话”工作台支持 Anthropic Messages 与 OpenAI Chat Completions 兼容接口；模型输出在界面中
  标记为“AI 生成”。本机聊天历史不是加密保险箱，敏感内容应及时删除。
- 外部应用代理仅接受用户明确提供的 HTTP/SOCKS5 地址，并只传给用户勾选的进程。ClaudeDock
  不提供第三方网络服务，不修改 Windows 系统代理、DNS、路由表或网卡，也不读取或迁移旧版网络
  配置。
- 网络预检只检查本机可见路径与服务商配置中的官方 DNS/HTTPS/TLS/CLI 端点，不请求第三方公网
  地址、地区、ASN 或网络信誉服务，也不根据用户位置作判断。

更完整的数据处理说明见 [隐私说明](docs/PRIVACY.md)，中国大陆公开发行边界见
[合规评估](docs/LEGAL_COMPLIANCE.md)。

## 主要能力

- 多项目终端、托盘后台运行、项目/对话历史与终端主题。
- Claude Code 官方安装、版本门禁、项目级服务商接入、连接实测和会话状态。
- Codex 官方 CLI/App Server 登录状态与项目启动；ChatGPT 登录凭据仍由 Codex 自身管理。
- 独立模型对话、Markdown/公式/代码、受限附件和隔离 Artifact 预览。
- Claude Code 插件、MCP、Claude Code Router 与 CC Switch 官方安装/导入边界。
- 应用更新、依赖许可清单、安全报告与可重复 CI 门禁。

设计和交互约束见 [design.md](design.md)，架构、安全与发布实现见
[technical.md](technical.md)。

## 安装与使用

正式版本发布后，从仓库的
[GitHub Releases](https://github.com/AeonusOvO/claude-dock-control-panel/releases) 下载
`ClaudeDock-Setup-<version>-x64.exe`。安装器支持选择安装目录和桌面快捷方式。

发布前请在 Windows 的文件属性或 PowerShell 中验证 Authenticode：

```powershell
Get-AuthenticodeSignature .\ClaudeDock-Setup-<version>-x64.exe | Format-List
```

只有 `Status` 为 `Valid`、签名主体与发行说明一致且时间戳/证书链受 Windows 信任时，才应作为
正式安装包使用。项目不会用自签名证书或 `NotSigned` 状态冒充正式签名。

启动后：

1. 从左侧添加一个项目文件夹；应用会为它创建独立终端会话。
2. 选择 Claude Code 或 Codex 作为项目开发引擎。
3. Claude Code 项目在“接入”中选择服务商、模型和认证方式；真实测试最多请求 1 个输出 token，
   可能产生少量供应商费用。
4. Codex 项目使用官方 ChatGPT 浏览器登录或设备码登录；ClaudeDock 不接触登录令牌。
5. 关闭主窗口默认只隐藏到系统托盘；从托盘菜单可彻底退出。

## 双通道安全更新

稳定版本同时发布到：

- GitHub Release：`https://github.com/AeonusOvO/claude-dock-control-panel/releases`
- 国内兜底镜像：`https://124.221.158.247/claudedock/windows/x64/`

每次发布只构建和签署一组 Windows 产物，再把完全相同的字节分发到两个通道：

- `ClaudeDock-Setup-<version>-x64.exe`
- `ClaudeDock-Setup-<version>-x64.exe.blockmap`
- `latest.yml`
- `release-manifest.json`
- `release-manifest.sig`

客户端固定 Ed25519 发布公钥，分别验证每个通道的签名 manifest、版本、文件大小与 SHA-512；随后
对合格来源进行小范围真实 `Range` 下载测速并选择更快来源。GitHub 不可访问时，镜像不依赖 GitHub
元数据仍可独立验证。若两个在线通道声明不一致、发生版本回退、跨主机重定向、超大元数据、伪造
部分响应或完整安装包摘要不符，更新会失败关闭并保留当前可运行版本。

镜像只接受精确的 HTTPS 公网 IP，拒绝 HTTP、用户信息、query、fragment、未授权 IP 与跨主机
重定向。公网 IP 的受信任 TLS 证书并不规避备案、接入商政策或其他适用监管要求。腾讯云现行规则
明确要求仅通过公网 IP 提供的中国内地互联网信息服务办理 ICP 备案，但其备案系统暂不支持直接使用
IP 备案；在维护者从属地通信管理局取得可执行结论前，该地址只保留 TLS 与健康检查，不公开稳定安装
包。部署、原子切换、回滚和验收细节见 [docs/UPDATE_MIRROR.md](docs/UPDATE_MIRROR.md)。

## 开发环境

- Windows 10 1809 或更高版本
- Node.js 24 或更高版本
- npm 11 或更高版本

```powershell
npm install
npm run dev
```

完整本地门禁：

```powershell
npm run lint
npm run format:check
npm run typecheck
npm test
npm run test:layout
npm run test:control-theme
npm run build
npm run dist
```

其他针对性命令：

```powershell
npm run test:conpty
npm run test:release-security
npm run test:visual
npm run check:licenses
npm audit
```

`npm run dist` 将 Windows x64 产物写入 `outputs/`：

```text
outputs/ClaudeDock-Setup-<version>-x64.exe
outputs/ClaudeDock-Setup-<version>-x64.exe.blockmap
outputs/latest.yml
outputs/win-unpacked/
```

`outputs/`、`dist/` 与本地安装包不提交 Git。

## 发布流程

任何影响用户软件或发布配置的修改都要同步更新 `package.json` 与 `package-lock.json` 的 SemVer，
完成验证、功能分支、PR 和 `main` 合并后，才可从 `main` 创建与 package version 完全一致的
`v<version>` 标签。

`.github/workflows/release.yml` 会：

1. 核对标签、`main` 提交和 package version，并运行完整验证与依赖审计。
2. 在 Windows runner 上只构建一次，使用受信任证书签署应用、卸载器和安装器并验证 Windows 链。
3. 生成 Ed25519 签名 release manifest，先上传 GitHub draft Release 并回读校验。
4. 把同一组文件上传镜像的版本化 staging；全部验证后才原子公开稳定元数据。
5. 从两个通道重新执行 GET、HEAD、Range、大小、SHA-512、缓存头和 manifest 签名检查；任一失败
   都阻止稳定发布并回滚。

工作流 Secret 只保存独立镜像部署身份、manifest 私钥和代码签名凭据，任何私钥、Token、证书密码
或管理凭据都不得进入仓库、安装包或客户端源码。

### Code signing policy

完整的 [Code signing policy](CODE_SIGNING_POLICY.md) 记录团队角色、构建来源、逐版本人工批准、
事故响应和当前审批状态。SignPath Foundation 批准后采用其要求的公开归属语：Free code signing
provided by [SignPath.io](https://signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/)。批准前的本地构建仍是未受信任签名的开发产物，不能据此
宣称正式签名已经完成。

## 目录

```text
assets/                  图标源与运行期公开配置
build/                   electron-builder / NSIS 自定义脚本
deploy/                  更新镜像的 Nginx、systemd 与部署脚本
docs/                    隐私、合规、镜像和发行说明
scripts/                 构建、许可、发布和验收脚本
src/main/                Electron 主进程与业务服务
src/preload/             受限 IPC 桥
src/renderer/            控制面板与终端界面
src/shared/              跨进程类型和纯函数
tests/                   单元、布局、主题与发布安全测试
outputs/                 本地安装包和解包产物（忽略）
```

## 安全与隐私要点

- 主窗口启用 `contextIsolation`、sandbox，关闭 renderer Node.js 集成；页面只加载项目内资源。
- Markdown 原始 HTML 不进入宿主 DOM；Artifact 需要用户显式运行并置于隔离 iframe。
- 自动更新拒绝降级、未签名 manifest、摘要不符和未经授权的下载主机。
- 项目秘密扫描覆盖当前工作树和完整 Git 历史；CI 也运行全历史扫描。
- 聊天历史和附件保存在当前 Windows 用户目录，属于本机明文可恢复数据；共享设备上应主动清理。
- 本地构建默认没有可信代码签名，Windows SmartScreen 可能显示未知发布者；只有发布工作流的可信
  Authenticode 验证通过后才能发布稳定版。
- 当前只发布 Windows x64。

## 贡献与支持

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，行为准则见
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。一般问题使用
[GitHub Issues](https://github.com/AeonusOvO/claude-dock-control-panel/issues)，安全漏洞按
[SECURITY.md](SECURITY.md) 私密报告。

维护者：**AeonusOvO**；公开联系电话：**13585928550**。

## 开源许可

ClaudeDock 源代码按 [Apache License 2.0](LICENSE) 开放。第三方依赖保留各自许可；发行包包含
[THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)，维护规则见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
