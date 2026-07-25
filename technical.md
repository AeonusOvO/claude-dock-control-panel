# ClaudeDock 技术说明

## 技术栈

- Electron 43：桌面窗口、系统托盘、目录选择与进程生命周期。
- TypeScript 6、Vite 8：主进程编译和渲染资源构建。
- `@lydell/node-pty` 1.2 beta：通过 Windows ConPTY 创建真实伪终端，并提供按平台预编译
  原生模块。
- xterm.js 6：终端渲染和键盘输入。
- Vitest、ESLint、Prettier：测试和静态检查。
- electron-builder：Windows NSIS 安装包。

依赖版本以 `package.json` 和 `package-lock.json` 为唯一事实来源。

## 架构与数据流

```text
Renderer (xterm.js / UI)
        │ 受限 IPC
        ▼
Preload contextBridge
        │ 参数过滤
        ▼
Electron Main ── TerminalWorkspace ─┬─ TerminalSession ── node-pty ── PowerShell / ConPTY
        │                           ├─ TerminalSession ── node-pty ── PowerShell / ConPTY
        │                           └─ …
        │
        ├── ClaudeRuntime ── 版本门禁 / 临时 settings / statusLine 指标
        │        └── ClaudeConfigStore ── safeStorage / 项目级接入配置
        ├── ClaudeGatewayDetector ── 本机端口 / 安装 / Claude 设置只读发现
        ├── ClaudeRouterManager ── CCR 3.x 本机 RPC / Provider / 网关 / 官方安装包
        ├── ClaudeConnectionTest ── Anthropic /v1/messages 分阶段实测
        ├── Tray 聚合状态与项目菜单
        └── 原生目录选择器、路径验证
```

- 渲染进程不启用 Node.js，只能调用 preload 暴露的固定方法。
- 主进程验证 IPC 发送方、会话标识、字符串长度、终端尺寸和目录是否真实存在。
- `TerminalWorkspace` 维护项目 ID、活动项目和多个 `TerminalSession`；每个会话拥有独立 PTY。
- PTY 输出携带会话 ID 推送到渲染进程，并写入对应 xterm.js 实例；只有活动实例可见。
- 添加目录会创建新会话；同一路径（忽略大小写）只保留一个会话并直接激活。
- 切换项目不重启 PTY；关闭项目才会终止对应进程，且不会影响其他会话。
- 托盘从 `WorkspaceState` 计算错误/运行聚合图标、运行数量和项目切换菜单。

## Claude Code 接入与会话

### 项目级路由

- ClaudeDock 以规范化绝对项目路径作为配置键；非敏感配置和加密凭据保存在 Electron
  `userData/claude/project-profiles.json`，不写入仓库中的 `.claude/settings*.json`。
- Anthropic 官方接入支持 Claude Code 现有登录或 `ANTHROPIC_API_KEY`。兼容网关设置
  `ANTHROPIC_BASE_URL`，并支持 `X-Api-Key`、Bearer Token 或本机无认证三种模式。
- 网关模式会把 `ANTHROPIC_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL` 和
  `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` 全部固定到用户选择的模型，避免 Claude Code
  的后台小模型或别名请求意外离开所选模型。启动时同时使用 `--model` 提高可观察性。
- 带 `/v1/chat/completions` 的服务是 OpenAI Chat Completions 格式，不能直接满足
  Claude Code 的 Anthropic `/v1/messages`、流式内容块和工具调用语义，必须经
  Claude Code Router、LiteLLM 或服务商自己的协议转换层。
- DeepSeek 官方目前另行提供 Anthropic 格式，基址为
  `https://api.deepseek.com/anthropic`；因此 DeepSeek 官方预设可以直连，默认示例模型
  更新为 `deepseek-v4-pro`。官方兼容表仍列出图片、文档、部分 MCP/代码执行结果等不支持
  或忽略字段，界面不会把“Anthropic 格式兼容”描述成完整 Claude 功能等价。
- 远程中转只接受 HTTPS；HTTP 仅允许 `localhost`、`127.0.0.1` 或 `::1`，URL 不允许嵌入
  用户名、密码、查询参数或片段。

### 安全启动

1. 主进程用固定 PowerShell 诊断命令解析 `claude --version`。2.1.91–2.1.196 直接阻止，
   其他低于 2.1.197 的版本要求升级；当前验证环境为 2.1.220。
2. `ClaudeRuntime` 为项目会话生成 `userData/claude/runtime/<session-id>/settings.json`，
   通过 Claude Code 官方 `--settings` 参数临时合并，不改变用户、项目或系统设置。
3. 主进程重建当前 PowerShell，并在 PTY 创建时注入路由与解密后的凭据；密钥不会出现在
   命令行、xterm.js 输入或 PowerShell 历史中。Claude 退出后命令会清理所有受管环境变量。
4. 非必要流量保护固定启用：
   `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`、`DISABLE_TELEMETRY=1`、
   `DISABLE_ERROR_REPORTING=1`、`DISABLE_FEEDBACK_COMMAND=1`、
   `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1` 和 `DO_NOT_TRACK=1`。网关模式还关闭自动更新。
5. 临时 settings 设置 `skipWebFetchPreflight: true`，避免 WebFetch 在第三方模型接入时仍把
   域名发往 `api.anthropic.com`。这会同时取消 Anthropic 的域名安全块列表检查，因此
   WebFetch 的最终风险仍由 Claude Code 权限提示和用户判断承担。

`safeStorage` 在 Windows 使用操作系统凭据保护能力；若不可用，保存密钥会失败关闭，而不是
回退到明文。渲染进程只能获得 `credentialConfigured` 布尔值，从不获得已保存密钥。

### 自动发现与新手接入

- `ClaudeGatewayDetector` 每次最多缓存 3 秒，renderer 在工作台打开期间每 6 秒刷新。它用
  短连接检查 Claude Code Router 默认 `3456/3458` 与 LiteLLM 常用 `4000`，不会枚举或扫描
  全部本机端口。
- CCR 的识别依据包括 `ccr` 命令、旧版
  `~/.claude-code-router/config.json`、新版 Windows
  `%APPDATA%/claude-code-router/{config.sqlite,gateway.config.json}`，以及默认端口状态。
  只检查配置文件是否存在，不读取 SQLite 中的密钥或上游凭据。
- 对 `3456/4000` 的后台探测只执行不带凭据的 `GET /v1/models`：`200` 表示可访问，
  `401/403` 表示接口已运行但需要网关访问密钥。管理页 `3458` 只做 TCP 存活判断。
- 检测会只读解析用户 `~/.claude/settings.json`、项目 `.claude/settings.json` 和
  `.claude/settings.local.json` 的 `env` 块，只向 renderer 传递净化后的
  `ANTHROPIC_BASE_URL` 与凭据是否存在的布尔值；密钥值从不跨 IPC。
- `src/shared/claude-curl.ts` 在本地 renderer 中解析 cURL 的 URL、`model`、Bearer 或
  `x-api-key`。URL 的用户信息、查询参数和片段不会进入结果；解析文本不写日志。切换项目会
  清空 cURL 输入与内存中的解析结果；一键导入 Router 成功后也会立即清空。
- OpenAI cURL 可由用户主动一键写入 CCR Provider；上游密钥只发给本机 CCR 管理 RPC，
  Router 客户端密钥只由主进程写入 ClaudeDock 的 DPAPI 配置。两类密钥不会互相代用。
- 帮助按钮仅允许打开 Claude/DeepSeek/LiteLLM/CCR 官方文档域名；本机管理页仅允许
  `http://localhost|127.0.0.1|::1:3458`，其他任意外链会被主进程拒绝。

### Router 安装与 Provider 管理

- `ClaudeRouterManager` 支持 Claude Code Router 3.x。它优先从 `where.exe ccr` 与标准 npm
  全局目录定位 CLI，也识别官方桌面版的标准 Windows 安装位置；不遍历磁盘或猜测任意程序。
- 正在运行的 CCR 会在 `%APPDATA%/claude-code-router/service.json` 记录本机管理端点、
  Web token 与 service token。主进程只接受 `http://localhost|127.0.0.1|::1` 回环地址，
  校验 service identity 后调用 `POST /api/ccr/rpc`；token 和原始配置永不跨 IPC。
- 状态、Provider 列表与操作结果只向 renderer 返回净化后的 URL、模型和
  `credentialConfigured` 布尔值。RPC 响应限制为 8 MiB，超时或错误消息会再次清除已知
  token 与凭据。
- Provider 保存先结构化克隆 CCR 的完整配置，只修改 `Providers` 与
  `preferredProvider`，然后调用 `saveConfig(config, { applyProfile: false })`。未知字段、
  媒体能力、Codex/Claude profile 与 proxy 原样保留；删除也只移除目标 Provider。项目不会
  调用 CCR 的 profile 应用或系统代理方法，因此不会修改 Codex、Claude Code 全局设置或
  Windows 系统代理。
- Provider 名称和模型路由只接受可安全组成 `provider/model` 的字符；远程上游必须为
  HTTPS，本机回环地址允许 HTTP，URL 禁止用户信息、查询参数和片段。Provider 密钥不会
  回显，编辑时可显式保留原值。
- “用于当前项目”会取得 CCR 当前 API 端点、路由模型和 Router 客户端密钥；密钥直接交给
  `ClaudeConfigStore` 用 Windows DPAPI 保存，不经过 renderer。最终只影响 ClaudeDock 为
  当前项目启动的 Claude Code 子进程。
- 启动操作优先复用现有管理服务并调用 `startGateway`；服务未运行时用检测到的官方 CLI
  或桌面程序启动。停止只调用 `stopGateway`，保留管理服务，便于继续编辑 Provider。
- 一键安装从 `api.github.com/repos/musistudio/claude-code-router/releases/latest` 读取
  官方发布元数据，只接受标签版本与文件名一致的 Windows `.exe`。下载限制 250 MiB、最长
  10 分钟，并按 Release 的 `size` 与 `sha256:` digest 校验后缓存到
  `userData/claude/router-installers/`；随后仅打开标准安装向导，Windows UAC、SmartScreen
  和安装确认仍由用户处理。

### 连接实测

- `ClaudeConnectionTest` 根据基址追加 `/v1/messages`；用户若粘贴完整
  `/v1/messages`，保存时会先规范化为基址。测试请求固定 `max_tokens: 1`、非流式和
  单字符提示，只有用户点击后才执行。
- Bearer 对应 `Authorization: Bearer`，API Key 对应 `x-api-key`。返回标准
  `msg_` ID 和 `content` 数组才算三项全部通过；`401/403` 定位为认证错误，
  `404` 提示可能误填 OpenAI 地址，`400/422` 作为“端点与认证基本可用、模型或字段需处理”
  的警告。
- 主进程最多读取 64 KiB 错误体，只抽取 180 字符的结构化错误消息并再次清除当前凭据；
  成功响应正文不返回 renderer。15 秒超时或网络错误只回传分阶段诊断。
- 已保存凭据从 `safeStorage` 解密后仅用于该次测试；表单新输入可在保存前测试。测试结果
  不包含凭据或模型回复文本。

### 会话、上下文与用量

- Claude Code 的一个 conversation 是一个 session，并与启动目录绑定。新运行 `claude`
  创建新 session；`--continue` 续接当前目录最近的 session；`--resume` 打开会话选择器；
  `/clear` 保存旧会话并用空上下文创建新 session。
- Claude Code 会把当前项目的会话 JSONL 存在 `~/.claude/projects/<project>/`。ClaudeDock
  不复制或解析正文；它只显示 Claude Code `statusLine` 提供的结构化数字。
- `assets/runtime/claude-statusline.ps1` 从 stdin 接收官方 statusLine JSON，原子写入模型、
  session ID、上下文窗口、输入/输出 token、估算费用、持续时间和改动行数。主进程每秒读取
  变更并通过受限 IPC 推送。
- 上下文占用使用 `context_window.used_percentage × context_window_size`，而不是累计所有
  历史请求。Claude Code 会在接近窗口上限时自动 compact；界面的“实时”表示每次 statusLine
  刷新后的最新状态，不代表逐 token 流式计数。
- 费用是 Claude Code 客户端本地估算：订阅用户不等同于账单，第三方模型若缺少定价元数据
  也可能为空或不准确。网关在服务端替换模型无法由客户端进行密码学证明；界面只能核对
  statusLine 报告的运行模型与锁定模型是否一致。

### 斜杠命令可视化

渲染进程提交命令名称与可选参数，主进程只接受固定白名单：
`/context`、`/usage`、`/status`、`/model`、`/permissions`、`/mcp`、`/agents`、`/hooks`、
`/memory`、`/resume`、`/compact`、`/rename`、`/doctor`、`/help`、`/clear`。参数最长
500 字符且禁止换行；只有工作台已知正在运行的 Claude 会话可以接收。`/clear` 的二次确认
在渲染层完成。

## 安全策略

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- 内容安全策略只允许本地脚本和样式；开发模式额外允许本机 Vite 连接。
- 禁止任意页面跳转、弹窗和未授权 IPC 通道。
- 不保存终端输入或命令历史；API 密钥只以 Windows `safeStorage` 密文持久化，终端不会收到
  含密钥的文本命令。PowerShell 自身行为不在应用持久化范围内。
- 原生 `node-pty` 只在主进程加载；`node-pty` 与需要由外部 PowerShell 执行的
  `assets/runtime/claude-statusline.ps1` 均在打包时从 ASAR 解包。

## 构建、测试与调试

- `npm run dev`：并行监听主进程与 Vite 渲染进程并启动 Electron。
- `npm run lint`：检查 TypeScript 源码。
- `npm run typecheck`：分别检查渲染端和主进程类型。
- `npm test`：运行目录/工作区、Claude 配置与版本门禁、cURL 协议识别、Router 配置
  定向修改与秘密净化、官方安装包元数据校验、连接测试结果映射，并在 Windows PowerShell
  中用模拟 statusLine JSON 验证指标采集脚本。
- `npm run build`：生成图标、编译主进程并构建渲染资源。
- `npm run dist`：构建 Windows x64 NSIS 安装包，并由 `scripts/publish-installer.mjs`
  将最终安装程序同时复制到项目根目录与 `outputs/` 本地交付目录。
- `build/installer.nsh`：在辅助安装器的目录页后插入桌面快捷方式复选框；取消勾选时在
  electron-builder 完成默认快捷方式步骤后删除该快捷方式；静默安装未经过选项页时沿用打包器默认行为。

CI 在 `windows-latest` 上执行 lint、格式、类型、测试和构建，不发布安装包。

`npm audit --omit=dev` 当前为 0 个生产依赖漏洞。完整审计仍会报告 electron-builder 最新版
依赖树中的构建期问题；这些开发依赖不会进入生产 ASAR，后续应随打包器上游修复升级。

## 关键取舍与限制

- 采用“应用自建并控制 PTY”，而不是注入或劫持外部控制台；后者不稳定且扩大权限边界。
- Windows 原生模块采用 `@lydell/node-pty` 的预编译分发；API 与微软 node-pty 上游保持
  同源，避免要求本机安装 Spectre 缓解 C++ 库。
- 项目工作区以应用进程生命周期为边界，不持久化会话列表、终端进程或 xterm.js 缓冲。
- 保存或切换 Claude 接入不会热修改已运行 PowerShell 的环境；受保护启动会重建当前项目
  终端。这是避免把密钥写入可见终端输入和历史的有意取舍。
- Windows 10 1809 之前没有所需 ConPTY API，不在支持范围。
- 代码签名、自动更新和退出后的会话恢复尚未实现。

## 地区限制与“降智”调研结论（截至 2026-07-25）

- Anthropic 于 2025-09-04 明确扩大地区限制：不只限制不支持地区内的使用，也限制由中国等
  不支持地区实体直接或间接控股超过 50% 的组织。当前支持地区页面仍未列出中国大陆和香港；
  因此“现在已完全取消封禁风险”不成立。
- 2026 年 7 月披露的逆向分析显示，Claude Code 2.1.91–2.1.196 在检测到自定义代理时检查
  `Asia/Shanghai` / `Asia/Urumqi` 时区及部分中国域名/AI 实验室标识，并把结果编码进发送给
  模型的系统提示。Anthropic 工程师称这是打击未授权转售和模型蒸馏的实验；相关逻辑随后被
  移除，报道和中国国家漏洞库均建议升级到 2.1.196 之后的版本。
- 没有找到可复现证据证明 Anthropic 曾按中国用户或中国模型定向降低回答能力。原始披露者
  把“未来可能定向降级”作为风险推测，而非已验证行为。Anthropic 另有一次公开复盘，确认
  2025 年的服务端路由、输出损坏和编译器问题曾导致广泛质量下降，但未称其针对中国用户，
  且其中部分问题未影响第三方平台。
- 因此项目把“官方地区/账号限制”“已确认的隐藏检测”“通用质量问题”和“未证实的定向降智”
  分开处理：版本门禁应对已确认检测，严格路由与非必要流量关闭缩小外传面，模型/上下文显示
  帮助发现不一致；项目不会通过伪造时区、IP、身份或其他方式规避服务条款。

## 外部依据

- Electron Security：
  <https://www.electronjs.org/docs/latest/tutorial/security>
- Electron Tray：
  <https://www.electronjs.org/docs/latest/api/tray>
- Electron `webUtils.getPathForFile`：
  <https://www.electronjs.org/docs/latest/api/web-utils>
- node-pty：
  <https://github.com/microsoft/node-pty>
- `@lydell/node-pty` 预编译分发：
  <https://github.com/lydell/node-pty>
- xterm.js addons：
  <https://xtermjs.org/docs/guides/using-addons/>
- Claude Code LLM gateway：
  <https://code.claude.com/docs/en/llm-gateway>
- Claude Code 连接网关与官方 1-token 验证：
  <https://code.claude.com/docs/en/llm-gateway-connect>
- Claude Code 网关协议：
  <https://code.claude.com/docs/en/llm-gateway-protocol>
- Claude Code 环境变量：
  <https://code.claude.com/docs/en/env-vars>
- Claude Code settings 与 `--settings` 优先级：
  <https://code.claude.com/docs/en/settings>
- Claude Code 模型配置：
  <https://code.claude.com/docs/en/model-config>
- Claude Code sessions：
  <https://code.claude.com/docs/en/sessions>
- Claude Code commands：
  <https://code.claude.com/docs/en/commands>
- Claude Code statusLine：
  <https://code.claude.com/docs/en/statusline>
- Claude Code 数据与 WebFetch 预检：
  <https://code.claude.com/docs/en/data-usage>
- LiteLLM Anthropic `/v1/messages` 统一端点：
  <https://docs.litellm.ai/docs/anthropic_unified/>
- DeepSeek 官方 Anthropic API：
  <https://api-docs.deepseek.com/guides/anthropic_api/>
- Claude Code Router 仓库、Windows 图形版与默认端口：
  <https://github.com/musistudio/claude-code-router>
- Claude Code Router 官方 Releases：
  <https://github.com/musistudio/claude-code-router/releases>
- Claude Code Router 基础配置：
  <https://musistudio.github.io/claude-code-router/docs/cli/config/basic/>
- Anthropic 地区限制更新（2025-09-04）：
  <https://www.anthropic.com/news/updating-restrictions-of-sales-to-unsupported-regions>
- Anthropic 当前支持地区：
  <https://www.anthropic.com/supported-countries>
- 隐藏检测披露与移除报道：
  <https://www.washingtonpost.com/national-security/2026/07/06/why-anthropic-alleges-chinese-firms-are-distilling-knowledge-claude/>
  <https://www.scmp.com/news/china/article/3359901/anthropic-hits-back-after-china-warns-claude-code-backdoor-risks>
- Anthropic 质量问题复盘：
  <https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues>
