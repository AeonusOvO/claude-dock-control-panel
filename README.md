# ClaudeDock 控制面板

ClaudeDock 是一个面向 Windows 的桌面控制面板，用于在图形界面中同时管理多个项目的
真实 PowerShell 伪终端、项目级 Claude Code 模型/API 接入、会话上下文与常用斜杠命令，
并通过系统托盘查看后台状态。

## 功能边界

- 每个项目拥有独立的 Windows PowerShell/ConPTY 会话，可同时在后台运行。
- 项目列表支持添加、切换和关闭项目；终端输出与滚动缓冲在项目切换后仍会保留。
- 将文件夹拖入窗口或使用目录选择器即可添加项目；重复添加同一路径会切回已有会话。
- 关闭主窗口后驻留系统托盘，可从托盘恢复、切换/添加项目或控制当前终端。
- 每个项目可以独立选择 Anthropic 官方接入、Anthropic Messages API 兼容服务或本地
  模型转换器。带 `/v1/chat/completions` 的 OpenAI 格式地址不能直接填给 Claude Code；
  服务商若另行提供 `/v1/messages` 则可以直连。DeepSeek 官方现已提供
  `https://api.deepseek.com/anthropic` 直连接口。
- “接入”页自动发现 Claude Code Router（默认模型接口 `3456`、管理页 `3458`）、
  LiteLLM（常用端口 `4000`）、当前项目保存的本机地址，以及现有 Claude Code
  用户/项目设置；检测只回传地址和“是否有凭据”，不回传凭据内容。
- 可粘贴服务商提供的 cURL，自动识别 OpenAI/Anthropic 协议、接口、模型和认证头，并给出
  “可直连”或“先配置本地转换器”的明确下一步。
- 可在“接入”页一键获取 Claude Code Router 官方 Windows 安装程序、启动/停止模型网关、
  打开完整管理页，并可视化新增、编辑、删除 Provider。OpenAI cURL 可一键写入 Router，
  同时把 Router 路由接入当前 ClaudeDock 项目。
- 可按 Claude 官方建议主动发送最多 1 个输出 token 的 `/v1/messages` 测试，分别显示
  端点、身份认证和模型响应结果；后台自动检测不会发起付费模型请求。
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
4. 点击“打开 Claude 工作台”→“接入”。应用会先自动显示本机已有的 Router、LiteLLM 和
   外部 Claude 配置；如果发现 Claude Code Router，应把 `3456` 视为模型接口，
   `3458` 只视为浏览器管理页。
5. 如果服务商给了一段 cURL，直接粘到“把服务商给你的 cURL 粘进来”：
   - 识别为 **Anthropic `/v1/messages`**：点击“自动填入可直连配置”。
   - 识别为 **OpenAI `/v1/chat/completions`**：如果已安装 Router，可点击
     “一键写入 Router 并接入当前项目”；应用会新增或更新 Provider、设为首选，并把
     `provider/model` 路由保存为当前项目的 ClaudeDock 接入。
   - cURL 中的 Bearer 上游密钥交给 Router；如果 Router 自己启用了访问保护，
     ClaudeDock 需要填写的是另一把 Router 访问密钥，二者不要混用。
6. 没有 Router 时，点击“一键获取官方安装包”。ClaudeDock 会从 CCR 官方 GitHub
   Release 下载 Windows 安装程序，核对 Release 声明的文件大小与 SHA-256 后打开标准
   安装向导；安装与 Windows UAC 仍由用户确认。完成后点击“重新检测”。
7. “Provider 配置”支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic
   Messages 三种上游。可逐项编辑地址、模型和密钥，也可只点“用于当前项目”复用已保存
   的上游凭据。
8. 点击“真实测试端点、密钥和模型”。测试最多请求 1 个输出 token，可能产生极少量费用；
   三项全部通过后再保存。API 凭据通过 Windows 安全存储加密，界面不会回读明文。
9. 不想安装转换器时，也可选择 Anthropic 官方、DeepSeek 官方 Anthropic 接口，或服务商
   明确提供的其他 `/v1/messages` 地址。DeepSeek 官方预设会填入
   `https://api.deepseek.com/anthropic` 和当前文档中的模型示例。
10. 在“会话”页选择“新建安全会话”“继续最近会话”或“选择历史会话”；启动会重建当前项目
    的 PowerShell，以便只通过子进程环境注入路由和密钥，因此会终止该终端中原有的进程。
11. Claude 响应后，“会话”页实时显示当前上下文和用量；“命令”页可以执行白名单中的
    Claude Code 斜杠命令。`/clear` 会开启空上下文的新会话，执行前会二次确认。
12. 点击窗口关闭按钮只会隐藏面板，所有会话继续在后台运行；右键系统托盘图标可以恢复
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
- 自动发现每 6 秒检查已知本机端口，只发送不带凭据的连通性/模型列表探测；它不会扫描全部
  端口，也不会自动调用远程模型。只有用户点击“真实测试”后才会向当前表单地址发送
  1-token 请求。
- cURL 分析发生在本地 renderer 中，不写日志；分析结果永远不显示完整密钥。cURL 输入框
  在当前项目切换或一键导入成功后清空。已经粘贴到对话、工单或其他第三方位置的密钥仍应
  立即撤销。
- Router 管理凭据只在 Electron 主进程读取并用于本机回环 RPC，不会传给 renderer。
  Provider 列表只显示“是否已配置密钥”。保存 Provider 时只改 CCR 的 `Providers` 和
  `preferredProvider`，不会应用或改写 CCR 中的 Codex profile、Claude profile 或系统代理。
- Router 安装需要访问 GitHub。ClaudeDock 只接受官方仓库当前 Release 中命名匹配的
  Windows `.exe`，限制最大 250 MiB，并在打开前校验文件大小与 SHA-256；安装程序本身仍
  可能因未签名或发布者信誉不足触发 Windows SmartScreen。
- 关闭项目会终止该项目的 PowerShell 进程；切换项目不会影响其他项目的运行。
- 项目会话只在本次应用运行期间保留，彻底退出后不会恢复终端进程或历史缓冲。
- Claude Code 自己会按项目目录把会话明文保存在 `~/.claude/projects/`，默认约 30 天；
  ClaudeDock 不复制对话正文，只保存 statusLine 提供的数字指标。
- 本地构建默认没有代码签名，Windows SmartScreen 可能显示未知发布者提示。
- 当前仅打包 Windows x64。
- 自动发现覆盖 Claude Code Router 的默认 `3456/3458`、LiteLLM 的常用 `4000` 和当前
  项目已保存的本机端口；自定义端口或改名进程可能需要手动填写。
- `@lydell/node-pty` 提供与上游 node-pty API 兼容的按平台预编译包，避免最终用户安装
  Visual Studio C++ 构建组件。

维护者：本项目当前由本地使用者维护。
