# ClaudeDock 技术说明

## 技术栈

- Electron 43：桌面窗口、系统托盘、目录选择与进程生命周期。
- TypeScript 6、Vite 8：主进程编译和渲染资源构建。
- `@lydell/node-pty` 1.2 beta：通过 Windows ConPTY 创建真实伪终端，并提供按平台预编译
  原生模块。
- xterm.js 6 + `@xterm/addon-unicode11`：终端渲染、键盘输入与中文宽字符计算。
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
        ├── ClaudeSessionManager ── 当前项目 JSONL 元数据 / 定向恢复与删除
        ├── WorkspaceStore ── 项目列表 / 最后激活项目的原子 JSON 持久化
        ├── ClaudeGatewayDetector ── 本机端口 / 安装 / Claude 设置只读发现
        ├── ClaudeRouterManager ── CCR 3.x 本机 RPC / Provider / 网关 / 安装与卸载
        ├── ClaudePluginManager ── Claude CLI 插件目录 / 市场 / 安装与更新
        ├── SoftwareUpdates ── Claude Code / Router 版本检测与安装源
        ├── WindowsCommand ── 原生命令及 npm PowerShell shim 的安全 argv 调用
        ├── ClaudeConnectionTest ── Anthropic /v1/messages 分阶段实测
        ├── Tray 聚合状态与项目菜单
        └── 原生目录选择器、路径验证
```

### 设计系统跨文件耦合（关键约束）

以下值必须跨文件同步，不一致会导致视觉错位或色块跳变：

- **`--titlebar-h` (48px)** ↔ `src/main/main.ts:818` `titleBarOverlay.height`
- **`--toolbar-h` / `--footer-h`** ↔ `.terminal-shell` 网格行 ↔ `.workbench-scrim` / `.claude-workbench` 的 `top`/`bottom`（共 3 处）
- **`--surface-canvas`** ↔ `src/main/main.ts:809` `backgroundColor` ↔ `body` 背景色
- **`--surface-1`** ↔ `src/main/main.ts:817` `titleBarOverlay.color` ↔ `.titlebar` 背景色
- **`--surface-terminal`** ↔ `.terminal-shell` 背景色 ↔
  `src/shared/terminal-themes.ts` 默认主题背景（不一致会出现接缝）
- **`--text`** ↔ `src/main/main.ts:818` `titleBarOverlay.symbolColor`（Windows 标题栏按钮颜色）

xterm 主题集中在 `src/shared/terminal-themes.ts`，renderer 只保存主题 ID 到
`localStorage` 并把选中 palette 应用到全部终端实例。三套内置 palette 都必须保持深色背景；
`letterSpacing: 0` 是 TUI 边框对齐的必需值。

### 关键取舍

- **拒绝 Win11 `backgroundMaterial: 'mica'/'acrylic'`**：半透明桌面色调与需要接近纯黑对比度的终端直接冲突，且在非 Win11 上降级不可预测。
- **遮罩层不用 `backdrop-filter`**：遮罩覆盖在持续刷新的 xterm canvas 上，背景模糊会在 Claude 流式输出时每帧强制 GPU 合成，造成性能问题。

## 渲染进程与 IPC

- 渲染进程不启用 Node.js，只能调用 preload 暴露的固定方法。
- 主进程验证 IPC 发送方、会话标识、字符串长度、终端尺寸和目录是否真实存在。
- `TerminalWorkspace` 维护项目 ID、活动项目和多个 `TerminalSession`；每个会话拥有独立 PTY。
- PTY 输出携带会话 ID 推送到渲染进程，并写入对应 xterm.js 实例；只有活动实例可见。
- 添加目录会记住该项目并创建首个会话；同一路径可由项目层级继续新开多个独立对话。
- 切换项目不重启 PTY；关闭项目才会终止对应进程，且不会影响其他会话。
- `WorkspaceStore` 把已添加项目与最后激活路径保存到
  `userData/claude/workspace.json`。写入采用临时文件加重命名；启动恢复不会改写原来的
  最后激活项，项目切换和关闭后再同步状态。
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
   通过 Claude Code 官方 `--settings` 参数临时合并，不改变用户、项目或系统设置。命令行
   settings 优先于用户设置，因此会同时写入无秘密的 `env` 覆盖：固定当前项目的标准基址
   与模型，并把 `ANTHROPIC_API_BASE_URL`、`CLAUDE_AGENT_API_BASE_URL`、
   `CCR_CLAUDE_CODE_MODEL`、`CODEXL_CLAUDE_CODE_MODEL` 和 Router 模型发现开关清空，防止
   旧 CCR profile 把真实会话重新指向已停止的 `3456`。
3. 主进程重建当前 PowerShell，并在 PTY 创建时注入路由与解密后的凭据；密钥不会出现在
   命令行、临时 settings、xterm.js 输入或 PowerShell 历史中。显式凭据环境变量优先于
   用户级 `apiKeyHelper`；Claude 退出后命令会清理所有受管环境变量与第三方路由别名。
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

- `ClaudeGatewayDetector` 每次最多缓存 3 秒，renderer 在“接入”页打开期间每 6 秒刷新。它用
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
- npm 版 CCR 必须由其安装环境中的系统 Node 运行。ClaudeDock 会从 npm 前缀旁和
  `where.exe node` 的结果中选择绝对 `node.exe`，并用一次不访问数据库的原生绑定加载探针
  验证它可以加载 CCR 的 `better_sqlite3.node`。禁止再用 Electron 的 `process.execPath`
  加 `ELECTRON_RUN_AS_NODE` 启动 CCR，因为 Electron 与系统 Node 可能具有不同的
  `NODE_MODULE_VERSION`。
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
- CCR 3.x 运行期按 Provider 名称解析 `preferredProvider`。兼容读取时同时接受旧配置中的
  Provider ID，以便正确显示首选状态；编辑、设为首选或删除时会把该字段规范化为当前
  Provider 名称。
- Provider 名称和模型路由只接受可安全组成 `provider/model` 的字符；远程上游必须为
  HTTPS，本机回环地址允许 HTTP，URL 禁止用户信息、查询参数和片段。Provider 密钥不会
  回显，编辑时可显式保留原值。
- “用于当前项目”会取得 CCR 当前 API 端点、路由模型和 Router 客户端密钥；密钥直接交给
  `ClaudeConfigStore` 用 Windows DPAPI 保存，不经过 renderer。最终只影响 ClaudeDock 为
  当前项目启动的 Claude Code 子进程。
- `router-repair-from-project` 只接受当前项目的 HTTPS Anthropic 直连、`apiKey` 认证和
  已加密保存凭据。主进程把规范化基址转换为完整 `/v1/messages` Provider，使用
  `applyProfile: false` 保存，确认 `3456` 启动成功后才把项目切到 Router；凭据不跨 IPC。
  Bearer、无认证、已有 Provider 或项目已指向 `3456` 时拒绝自动复制并引导手动配置。
- CCR 返回 `No available models` 或 Provider 列表为空时，主进程将其映射为中文原因和
  下一步，不向 renderer 透传英文错误；其他错误在显示前会净化 Bearer 与 `sk-` 形态。
- 如果现有 3458 管理服务返回 `better-sqlite3` ABI 不匹配，状态会携带
  `runtimeMismatch` 并显示编译/运行时 ABI。用户点击修复后，主进程仅在错误模式明确匹配时
  终止 `service.json` 中已通过 service token/identity 校验的单一 PID，等待它退出，再用
  兼容系统 Node 执行 `start --no-open --gateway`；不会按映像名批量杀进程，数据库、
  Provider、CCR profile 和 Codex 均不改写。`ccr_web_token` 也会在错误净化时隐藏。
- 部分错误服务在真正访问 SQLite 前会先返回空配置。为避免再次误报“No available
  models”，主进程还会用 `tasklist.exe` 按 service PID 核对进程映像；只有映像名与当前
  ClaudeDock/Electron 可执行文件完全相同时才提前标记 `runtimeMismatch`，官方 CCR 桌面
  进程和系统 `node.exe` 不受影响。`tasklist` 原始字节同时尝试 UTF-8 与 Windows
  GB18030 解码，以覆盖中文产品名；结果按 PID 缓存，避免轮询重复创建进程。
- 启动操作优先复用现有管理服务并调用 `startGateway`；服务未运行时用检测到的官方 CLI
  或桌面程序启动。停止只调用 `stopGateway`，保留管理服务，便于继续编辑 Provider。
- 一键安装从 `api.github.com/repos/musistudio/claude-code-router/releases/latest` 读取
  官方发布元数据，只接受标签版本与文件名一致的 Windows `.exe`。下载限制 250 MiB、最长
  10 分钟，并按 Release 的 `size` 与 `sha256:` digest 校验后缓存到
  `userData/claude/router-installers/`；随后仅打开标准安装向导，Windows UAC、SmartScreen
  和安装确认仍由用户处理。
- 另一条安装路径通过固定包名 `@musistudio/claude-code-router@latest` 调用 npm；来源只能
  是 `https://registry.npmjs.org` 或 `https://registry.npmmirror.com`，registry 以本次
  argv 参数传入，不写入用户 npm 配置。安装状态区分 desktop/npm/mixed。
- 卸载前只停止经 `service.json` token 与 identity 校验的 CCR 服务；npm 版调用固定包名的
  全局卸载，桌面版只启动其安装目录中的已知卸载程序。Provider 配置目录默认保留，便于用户
  更换安装来源后继续使用；没有可信卸载程序时引导到 Windows“已安装的应用”。

### 软件与插件更新

- `SoftwareUpdates` 从 npm 官方 registry 读取 Claude Code 与 Router 的 `latest` 元数据；
  官方源失败时再读 npmmirror。结果缓存 5 分钟，接入页轮询只在缓存到期后产生网络请求。
- Claude Code 的官方原生路径使用固定的 `claude update`；未安装时使用固定 winget ID
  `Anthropic.ClaudeCode`。npm 与 npmmirror 路径使用固定包名，均不拼接用户输入到 shell。
- `ClaudePluginManager` 调用 `claude plugin list --json --available` 与 marketplace JSON
  接口。插件标识、市场名和市场来源分别经过格式校验；变更后强制刷新目录。CLI 返回版本或
  source SHA 时与市场记录比较并标记更新，用户也可刷新市场后批量执行官方 `plugin update`。
- `src/shared/plugin-localization.ts` 不调用外部翻译接口。它按安全、测试、API、数据、运维、
  前端等可追踪关键词生成中文能力概括；renderer 保留英文原文折叠区，插件 ID 始终使用 CLI
  返回值，搜索同时覆盖原文、中文概括与分类。该概括属于项目自研规则，不是插件作者译文。
- Windows 上 `claude`/`npm` 常由 `.ps1` shim 提供。`WindowsCommand` 先用固定 PowerShell
  查询 `Get-Command` 的绝对 `Source`，再通过 `-File` 与独立 argv 调用；stdin 显式连接
  NUL，避免 Claude CLI 把匿名管道当作慢输入等待。`.cmd` 只在同目录存在配套 `.ps1` 时
  转用该脚本，不启用字符串 shell。

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
- 每次测试按“规范化配置 + 凭据 SHA-256”生成内存指纹，只在当前项目保存的配置与凭据完全
  匹配时显示到会话页；不会持久化凭据摘要。最小请求通过是一个时间点信号，不能证明上游
  持续在线，也不能覆盖 Claude Code 后续的流式内容、工具调用和更大请求。

### 会话路由健康

- `ClaudeProjectState.routeHealth` 统一表达连接测试、Router 状态与真实会话三种来源，包含
  success/warning/error、检查时间、说明及是否阻止启动。renderer 在会话页显示健康卡，
  新错误同时触发一次 toast。
- 只有当前项目的基址确实是本机回环 `http://*:3456` 时，启动前才读取 CCR 状态；Provider
  为空或 gateway 非 running 会在重启 PowerShell 前阻断，并引导到接入页。远程直连和其他
  本机端口不会被无关 CCR 故障影响。
- `ClaudeRuntime.consumeTerminalOutput` 保留最多 4 KiB 的短期诊断窗口，只识别 Claude
  Code 明确输出的 `API Error:`。ConnectionRefused、401/403、404 与模型错误映射为可读
  原因；通用错误在截断前清除 Bearer 与 `sk-` 形态。诊断窗口、终端正文和提示词都不落盘。
- 新会话启动会清除旧运行错误；当后续 statusLine 指标时间晚于错误时也视为恢复。若同一
  配置先通过 1-token 测试、后在真实会话失败，健康卡会明确解释“测试成功不代表持续可用或
  完整兼容”，避免把两种结果误认为矛盾。

### 会话、上下文与用量

- Claude Code 的一个 conversation 是一个 session，并与启动目录绑定。新运行 `claude`
  创建新 session；`--continue` 续接当前目录最近的 session；`--resume` 打开会话选择器；
  `/clear` 保存旧会话并用空上下文创建新 session。
- Claude Code 会把当前项目的会话 JSONL 存在 `~/.claude/projects/<project>/`。ClaudeDock
  不复制、索引或向 renderer 返回正文；历史列表读取 JSONL 结构时只提取元数据，运行中用量
  仍只显示 Claude Code `statusLine` 提供的结构化数字。
- 历史会话列表只进入当前工作目录编码后对应的项目目录，并只读取目录顶层 UUID 命名的
  `.jsonl` 文件。标题优先级为 `customTitle > aiTitle > sessionName > slug`，避免把随机
  slug 当作用户可读名称；其余只提取 session ID、时间、模型和 usage 等元数据，不跨项目
  枚举。单文件超过 50 MiB 时跳过。渲染层只在项目文件夹的折叠层级中展示历史，不在工作台
  重复生成第二份列表。
- 历史右键重命名先验证项目路径、UUID、文件类型、50 MiB 上限和 1–60 字符标题，再向对应
  JSONL 追加 `type: "custom-title"` 记录，不重写正文。运行中重命名先更新工作区标题；若该
  PTY 正在运行 Claude Code，再发送白名单 `/rename <title>` 让 Claude 元数据同步更新。
- 定向恢复把经过 UUID 校验的 session ID 交给统一的 PowerShell 命令构造器，因此继续保留
  参数单引号转义、`--no-chrome`、凭据环境清理和不可见退出标记。删除同样限定为当前项目
  目录下的精确 `<session-id>.jsonl` 文件。
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
`/memory`、`/resume`、`/compact`、`/rename`、`/theme`、`/doctor`、`/help`、`/clear`。参数最长
500 字符且禁止换行；只有工作台已知正在运行的 Claude 会话可以接收。`/clear` 的二次确认
在渲染层完成。

### PowerShell 键盘与剪贴板

- 每个应用内 PowerShell 启动时把控制台输入、输出和管道编码设为无 BOM UTF-8，仅为该进程
  加载 PSReadLine，并把 `Ctrl+J` 绑定到 `AddLine`；renderer 将 `Shift+Enter` 转为 LF，
  因此多行输入不需要修改用户 profile 或外部终端。
- xterm 的键盘处理在自定义快捷键前放行 `isComposing`/keyCode 229，避免截断 Windows 中文
  输入法组合事件；Unicode 11 addon 负责 CJK 宽字符单元格计算。renderer 不再依赖可能滞后
  的状态快照丢弃 `onData`，主进程 PTY 仍是最终写入边界。
- 会话内 Backspace 处理器检测光标前是否为 PSReadLine 多行换行符：是则删除该换行并回退
  光标，否则调用标准 `BackwardDeleteChar`。该绑定不会写入用户 profile。
- xterm 有选区时 `Ctrl+C` 通过主进程 `clipboard` API 复制；无选区时仍发送控制字符中断。
  `Ctrl+V` 从主进程读取最多 5 MiB 文本并写入当前 PTY。右键菜单复用同一受限 API，并提供
  全选和只清除 xterm 显示。
- 控制栏与工作台宽度写入 renderer `localStorage`；这只保存像素宽度，不包含项目、命令或
  终端内容。窗口缩到 900px 以下时会重新夹紧宽度；CSS 在 900/850px 和 700px 高度设置
  独立断点，避免工具栏、状态栏、插件操作区和安装来源控件重叠。

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
  定向修改与秘密净化、官方安装包元数据校验、运行期 API 错误识别与路由阻断、连接测试
  结果映射、工作区持久化、当前项目会话解析与删除边界，并在 Windows PowerShell 中用模拟
  statusLine JSON 验证指标采集脚本；同时覆盖插件目录合并、输入校验、会话标题优先级与
  `custom-title` 写入、终端主题约束、PowerShell 启动脚本语法和软件语义版本比较。
- `tests/renderer-html.test.ts` 使用 Prettier 的严格 HTML 解析器检查渲染入口，同时验证 ID
  唯一性和 `requiredElement` 启动依赖，防止浏览器容错解析掩盖 UI 结构损坏。
- `npm run test:layout` 使用隐藏 Electron 窗口在 820×640、900×640、1180×760 三种尺寸
  轮换项目/接入、插件的已安装/可安装/市场三个面板及工作台三页，检查交互控件矩形相交、
  关键容器横向溢出和文档级 overflow；遮罩层与抽屉的有意叠放不计为控件重叠。
- `npm run test:visual` 在本地生成 820px 插件页与重命名弹窗 PNG 到 `dist/visual-qa/`，用于
  人工核对主题选择器、窄宽响应式和弹窗层级；图片属于构建产物。
- `npm run build`：生成图标、编译主进程并构建渲染资源。
- `npm run dist`：构建 Windows x64 NSIS 安装包；Electron Builder 的 `directories.output`
  固定为 `outputs/`，安装程序、Blockmap、更新元数据和解包产物均直接写入该目录，不再执行
  二次复制或向项目根目录发布。
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
- Windows 10 1809 之前没有所需 ConPTY API，不在支持范围；最小窗口为 820 × 640。
- 应用自身的自动更新、代码签名和退出后的 PTY 恢复尚未实现；Claude Code、Router 与插件
  的检测/更新已经实现，但不等同于 ClaudeDock 安装包自更新。

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
- xterm.js GitHub（IME、CJK 与主题能力）：
  <https://github.com/xtermjs/xterm.js>
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
- Claude Code changelog（`/theme` 与自定义主题）：
  <https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md>
- Claude Code 官方安装与更新：
  <https://code.claude.com/docs/en/installation>
- Claude Code 插件发现与管理：
  <https://code.claude.com/docs/en/discover-plugins>
- Claude Code 插件市场：
  <https://code.claude.com/docs/en/plugin-marketplaces>
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
- Claude Code Router CLI 安装：
  <https://musistudio.github.io/claude-code-router/docs/cli/installation/>
- PowerShell PSReadLine 多行编辑：
  <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_line_editing>
- npmmirror registry：
  <https://developer.aliyun.com/article/878125>
- Node.js 原生模块 ABI（`process.versions.modules`）：
  <https://nodejs.org/api/process.html#processversions>
- `better-sqlite3` 原生模块与 Electron 故障排查：
  <https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md>
- Anthropic 地区限制更新（2025-09-04）：
  <https://www.anthropic.com/news/updating-restrictions-of-sales-to-unsupported-regions>
- Anthropic 当前支持地区：
  <https://www.anthropic.com/supported-countries>
- 隐藏检测披露与移除报道：
  <https://www.washingtonpost.com/national-security/2026/07/06/why-anthropic-alleges-chinese-firms-are-distilling-knowledge-claude/>
  <https://www.scmp.com/news/china/article/3359901/anthropic-hits-back-after-china-warns-claude-code-backdoor-risks>
- Anthropic 质量问题复盘：
  <https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues>
