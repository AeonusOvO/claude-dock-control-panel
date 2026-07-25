# ClaudeDock 控制面板

ClaudeDock 是一个面向 Windows 的桌面控制面板，用于在图形界面中同时管理多个项目的
真实 PowerShell 伪终端、项目级 Claude Code 模型/API 接入、会话上下文与常用斜杠命令，
并通过系统托盘查看后台状态。

## 功能边界

- 每个项目拥有独立的 Windows PowerShell/ConPTY 会话，可同时在后台运行。
- 项目列表支持添加、切换和关闭项目；终端输出与滚动缓冲在项目切换后仍会保留。
- 将文件夹拖入窗口或使用目录选择器即可添加项目；重复添加同一路径会切回已有会话。
- 关闭主窗口后驻留系统托盘，可从托盘恢复、切换/添加项目或控制当前终端。
- 每个项目可以独立选择 Anthropic 官方接入或 Anthropic Messages API 兼容网关；DeepSeek
  等非 Claude 模型需要 LiteLLM 一类转换层，不能把原生 OpenAI 兼容地址直接当作
  Claude Code 地址。
- Claude 工作台提供新建、继续最近和选择历史三种会话入口，并把 `/context`、`/usage`、
  `/model`、`/permissions`、`/compact` 等常用斜杠命令变成可点击操作。
- 通过 Claude Code 官方 `statusLine` 数据实时显示上下文窗口、输入/输出 token、会话估算
  费用、持续时间、模型和会话 ID；不解析易变的终端绘制文本。
- 模型/API 路由只注入 ClaudeDock 为当前项目启动的进程，不修改 Codex、Claude Code
  全局配置或 Windows 系统级 API 路由。
- 不劫持任意已经打开的外部 PowerShell 窗口；应用创建并接管自己的 ConPTY 会话。

## 开发环境

- Windows 10 1809 或更高版本
- Node.js 24 或更高版本
- npm 11 或更高版本
- Claude Code 2.1.197 或更高版本（ClaudeDock 受保护启动的最低版本）

安装依赖并启动开发模式：

```powershell
npm install
npm run dev
```

常用命令：

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run dist
```

`npm run dist` 在 `release/` 完成 Windows x64 打包，并把最终安装程序
`ClaudeDock-Setup-<version>-x64.exe` 同时发布到项目根目录与 `outputs/` 本地交付目录。

## 日常使用

1. 启动 ClaudeDock 后，首个 PowerShell 会话会自动连接并显示当前用户目录。
2. 把项目文件夹拖到窗口任意位置，或点击“添加项目”；应用会为它新建独立会话，不会停止
   已经运行的其他项目。
3. 在左侧项目列表切换当前项目；点击项目行右侧的关闭按钮会终止并移除该项目会话。
4. 点击“打开 Claude 工作台”，先在“接入”页为当前项目选择官方或兼容网关、模型和认证
   方式，再保存。API 凭据通过 Windows 安全存储加密，界面不会回读明文。
5. 在“会话”页选择“新建安全会话”“继续最近会话”或“选择历史会话”；启动会重建当前项目
   的 PowerShell，以便只通过子进程环境注入路由和密钥，因此会终止该终端中原有的进程。
6. Claude 响应后，“会话”页实时显示当前上下文和用量；“命令”页可以执行白名单中的
   Claude Code 斜杠命令。`/clear` 会开启空上下文的新会话，执行前会二次确认。
7. 点击窗口关闭按钮只会隐藏面板，所有会话继续在后台运行；右键系统托盘图标可以恢复
   窗口、切换/添加项目、控制当前终端或彻底退出。

安装时可自行选择 `D:\ClaudeDock` 等目标路径，并可在“安装选项”页面勾选或取消
“在桌面创建快捷方式”（默认勾选）。

## 目录

```text
assets/              图标矢量源及生成图标
build/               electron-builder/NSIS 安装器自定义脚本
scripts/             清理、图标生成等工程脚本
src/main/            Electron 主进程、项目工作区、Claude 运行时与 PowerShell 会话管理
src/preload/         受限的渲染进程桥接 API
src/renderer/        控制面板界面与 xterm.js 终端
src/shared/          跨进程类型和纯函数
tests/               单元测试
assets/runtime/      Claude Code statusLine 本地指标采集脚本
outputs/             安装包与本地交付说明，不纳入 Git
ClaudeDock-Setup-*.exe  根目录中的最终安装包，不纳入 Git
```

## 安全与限制

- 界面只加载项目自带的本地内容，关闭 Node.js 集成并启用上下文隔离和沙箱。
- 用户在终端中输入的命令拥有当前 Windows 用户的权限，应用不会替用户审查命令。
- ClaudeDock 不把密钥写入项目、命令行或终端历史；保存的凭据使用 Electron
  `safeStorage`（Windows DPAPI）加密。受保护启动结束后会从 PowerShell 环境清理所有
  Claude 路由和凭据变量。
- 第三方接入固定 `ANTHROPIC_BASE_URL` 与主/小模型别名，同时关闭遥测、错误上报、反馈、
  调查问卷以及 WebFetch 的 Anthropic 域名预检；这能阻断已知的非必要 Anthropic 流量，
  但不能替用户审计第三方网关，也不能证明网关没有在服务端替换模型。
- ClaudeDock 拒绝受保护启动已披露含隐藏地区/代理检测逻辑的 Claude Code
  2.1.91–2.1.196。Anthropic 当前仍不向中国大陆/香港及受不支持地区控制的实体提供官方
  服务；本项目不会伪造位置、绕过地区限制或保证官方账号可用。
- 经中转时，项目代码、提示词和输出会经过该网关。只使用有明确数据处理、日志和模型路由
  说明的服务，不要把生产代码交给来源不明的低价中转。
- 关闭项目会终止该项目的 PowerShell 进程；切换项目不会影响其他项目的运行。
- 项目会话只在本次应用运行期间保留，彻底退出后不会恢复终端进程或历史缓冲。
- Claude Code 自己会按项目目录把会话明文保存在 `~/.claude/projects/`，默认约 30 天；
  ClaudeDock 不复制对话正文，只保存 statusLine 提供的数字指标。
- 本地构建默认没有代码签名，Windows SmartScreen 可能显示未知发布者提示。
- 当前仅打包 Windows x64。
- `@lydell/node-pty` 提供与上游 node-pty API 兼容的按平台预编译包，避免最终用户安装
  Visual Studio C++ 构建组件。

维护者：本项目当前由本地使用者维护。
