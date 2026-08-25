# ClaudeDock 控制面板

Windows 桌面 Electron 控制面板，用图形界面管理多个项目的 PowerShell/ConPTY 终端、Claude Code 与
Codex 会话、模型接入、路由、MCP、插件和更新。

当前版本 **5.0.0-rc.20**，仅发布 Windows x64。

## 功能

**项目与终端**

- 每个项目一个独立 PowerShell/ConPTY 会话，可并行后台运行。
- 每个项目选择 Claude Code 或 Codex 作为开发引擎。
- 关闭主窗口隐藏到系统托盘；托盘退出前列出正在运行的终端与忙碌操作。

**Claude Code**

- 「新建安全会话」「继续最近」「选择历史」默认进入真实终端；结构化原生对话通过终端工具栏的
  「原生对话」显式进入。
- 原生对话基于 Claude Agent SDK，解析用户本机的 `claude` 命令，不捆绑第二份 Claude Code。
- 消息流保留 Markdown 块顺序、代码围栏、工具状态、计划、权限、提问、MCP 表单、图片和后台任务；
  同一轮次的 token 增量按稳定消息 ID 聚合。
- `(runtime, normalized project, UUID)` 单一 owner 防止同一对话被原生会话、历史恢复和安全终端
  重复占用。
- 按接入与模型隔离的「速度」菜单：官方 Claude 使用原生 Fast，受管 GPT 请求 `service_tier=fast`。
- 「资源」菜单聚合上下文、官方额度窗口和供应商余额，并可声明上下文窗口（自动 / 100 万 / 20 万 /
  自定义）。
- 运行中可切换模型、effort、权限模式与思考程度；控件由同一能力 revision 原子更新。

**Codex**

- 官方 CLI / App Server 登录状态与项目启动；ChatGPT 登录凭据由 Codex 自身管理。
- Codex 5.0 RC 使用原生 TUI，只复用能力与所有权接口。

**模型接入**

- 项目级服务商接入、认证方式选择、自动发现、连接实测（最多 1 个输出 token）。
- OpenAI 协议上游需要格式转换时自动安装并托管 CCR CLI，用户不选择路由内核。
- 实验性「ChatGPT 订阅（ClaudeDock 托管）」：一次点击完成 Claude Code 检测、CLIProxyAPI 官方
  Release 校验安装、OpenAI 官方授权、回环网关启动、实时模型选择与项目保存。
- 密钥使用 Electron `safeStorage`（Windows DPAPI）加密，不写入项目、命令行或终端历史。

**独立对话**

- 支持 Anthropic Messages 与 OpenAI Chat Completions 兼容接口。
- 受限图片附件；Markdown 原始 HTML 降级为文本，Artifact 是唯一显式 HTML 执行入口。
- 最多 50 个对话，每个 100 条消息，保存在当前 Windows 用户目录。

**外部应用代理**

- 接受用户提供的 HTTP/SOCKS5 地址，按 CLI / 应用自身网络 / 独立对话三个作用域分发。
- 不修改 Windows 系统代理、DNS、路由表或网卡。

**扩展与更新**

- Claude Code 插件、MCP、Claude Code Router 与 CC Switch 的安装/导入。
- 标题栏统一更新中心聚合 ClaudeDock、Claude Code、Router 与插件更新。
- 「任务与下载」显示动作、对象、阶段、队列和已用时间；只在存在真实字节总量时显示百分比、
  速度与 ETA。下载历史保留最多 100 条终态元数据。

## 安装

从 [GitHub Releases](https://github.com/AeonusOvO/claude-dock-control-panel/releases) 下载
`ClaudeDock-Setup-<version>-x64.exe`。安装器支持选择安装目录和桌面快捷方式。

启动后：

1. 新配置会自动打开五步入门向导；先独立选择 Claude Code / Codex 引擎，再选择官方订阅、国产模型或 API。
2. 国产模型使用紧凑选择框细分 DeepSeek、千问、GLM 等，不要求先理解路由内核。
3. ClaudeDock 检测本机环境，再通过 Windows 文件夹选择器打开第一个工作区。
4. 进入工作区后，ClaudeDock 沿既有自动流程补齐组件、选择路由、发现模型、真实测试并保存。
5. 之后可从「接入」按“选择模型 → 配置与验证”两步更换来源；设置中可重新打开入门向导。

## 自动更新

应用内「检查所有更新」由 electron-updater 读取打包进应用的腾讯云 COS 通用 HTTPS feed：

```text
https://claudedock-1304375868.cos.ap-shanghai.myqcloud.com/updates/windows/x64/
```

每次发布包含安装包、同名 `.blockmap` 和当前通道清单：`5.0.0-rc.N` 使用 `rc.yml`，稳定版使用
`latest.yml`。检查本身不下载；用户确认后才下载，完成后再次确认才重启安装。

`5.0.0-rc.15` 是 COS 更新链的手动引导版本。已安装 rc.14 或更早版本的用户需要从
[GitHub Releases](https://github.com/AeonusOvO/claude-dock-control-panel/releases) 手动安装 rc.15 一次；
之后的 RC 版本从 COS `rc.yml` 更新。旧安装包内嵌的 GitHub feed 不能远程改写。

更新器按通道清单的 SHA-512 校验下载字节并拒绝降级。SHA-512 只证明安装包与所读取清单一致；
当前清单和安装包均未签名，不能据此证明发布者身份。控制 COS feed 的主体仍可同时替换清单和安装包。

## 开发

要求 Windows 10 1809+、Node.js 24+、npm 11+。详见 [docs/how-to/develop.md](docs/how-to/develop.md)。

```powershell
npm install
npm run dev
```

| 命令                                    | 作用                                       |
| --------------------------------------- | ------------------------------------------ |
| `npm run lint`                          | ESLint 检查 `src`、`tests`、`scripts`      |
| `npm run lint:deps`                     | dependency-cruiser 分层、循环与孤儿检查    |
| `npm run format:check`                  | Prettier 检查                              |
| `npm run typecheck`                     | 分别检查渲染端与测试、主进程、preload 类型 |
| `npm test`                              | Vitest 单元与契约测试                      |
| `npm run test:layout`                   | 布局测试                                   |
| `npm run test:control-theme`            | 控件主题测试                               |
| `npm run test:conpty`                   | ConPTY 集成测试                            |
| `npm run test:visual`                   | 真实 Electron 视觉检查                     |
| `npm run test:runtime-soak`             | 24 小时真实时间合成测试                    |
| `npm run test:runtime-soak:accelerated` | 加速版 soak                                |
| `npm run build`                         | clean 后先生成源码身份，再构建三进程       |
| `npm run dist`                          | 打包 Windows x64 安装包                    |
| `npm run release:manifest`              | 校验源码身份、NSIS payload、更新链与产物   |
| `npm run release`                       | clean exact commit 上重装、跑门禁并打包    |
| `npm run release:publish:cos`           | 发布已验证产物到 COS                       |

`npm run dist` 产物写入 `outputs/`；`npm run release:manifest` 另生成本地发布报告：

```text
outputs/ClaudeDock-Setup-<version>-x64.exe
outputs/ClaudeDock-Setup-<version>-x64.exe.blockmap
outputs/<channel>.yml
outputs/release-manifest.json
outputs/win-unpacked/
```

`outputs/` 与 `dist/` 不提交 Git。最终候选的 `npm run release` 要求 clean exact HEAD 且 `outputs/` 除跟踪的
空 `.gitkeep` 外为空；它依次执行 `npm ci`、lint、format check、全部 typecheck、全量 Vitest、
dependency-cruiser、`npm run dist`、源码身份复核和 manifest，不执行上传。

## 目录

```text
assets/         图标源与运行期公开配置
build/          electron-builder / NSIS 自定义脚本
docs/           文档
scripts/        构建与验收脚本
src/main/       Electron 主进程与业务服务
src/preload/    受限 IPC 桥
src/renderer/   控制面板与终端界面
src/shared/     跨进程类型和纯函数
tests/          单元、布局与主题测试
outputs/        本地安装包与解包产物（忽略）
```

## 文档

完整地图见 [docs/README.md](docs/README.md)。

| 文档                                                                           | 内容                               |
| ------------------------------------------------------------------------------ | ---------------------------------- |
| [docs/explanation/architecture.md](docs/explanation/architecture.md)           | 进程边界、分层、状态所有权、数据流 |
| [docs/explanation/design.md](docs/explanation/design.md)                       | 设计系统与交互约束                 |
| [docs/reference/technical.md](docs/reference/technical.md)                     | 各功能域的实现细节与技术约束       |
| [docs/reference/project-layout.md](docs/reference/project-layout.md)           | 目录结构与依赖规则                 |
| [docs/reference/ipc-contract.md](docs/reference/ipc-contract.md)               | 196 个 IPC 通道与 API 方法映射     |
| [docs/reference/cli-command-catalog.md](docs/reference/cli-command-catalog.md) | Claude / Codex 斜杠命令清单        |
| [docs/how-to/](docs/how-to/)                                                   | 开发、验证、发布                   |
| [docs/adr/](docs/adr/)                                                         | 决策记录                           |
| [docs/releases/](docs/releases/)                                               | 发布说明                           |
| [docs/archive/](docs/archive/)                                                 | 历史路线图、规格与缺陷清单         |
| [AGENTS.md](AGENTS.md)                                                         | 项目规则                           |

## 运行时约束

- 主窗口启用 `contextIsolation`、`sandbox`，关闭 renderer Node.js 集成；页面只加载项目内资源。
- 不安装、卸载、终止或改写 Claude、Codex、CCR 的桌面 App；检测到桌面版后台时拒绝接管。
- 不读写 Codex 的 OAuth 凭据，不修改 Codex、Claude Code 或 Windows 的系统级 API 路由。
- 聊天历史与附件保存在当前 Windows 用户目录，是本机明文数据。
- 本地构建没有代码签名，Windows SmartScreen 可能显示未知发布者。

## 参与与反馈

- 缺陷和功能建议：[GitHub Issues](https://github.com/AeonusOvO/claude-dock-control-panel/issues)
- 贡献流程：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全漏洞私密报告：[SECURITY.md](SECURITY.md)
- 社区行为：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## 许可证

ClaudeDock 采用 [Apache License 2.0](LICENSE) 开源。版权及归属声明见 [NOTICE](NOTICE)。

该许可证允许个人和商业使用、修改与再分发，但不授予 ClaudeDock 名称、标识或其他商标的使用权。
