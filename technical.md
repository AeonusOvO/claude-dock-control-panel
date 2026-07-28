# ClaudeDock 技术说明

## 技术栈

- Electron 43：桌面窗口、系统托盘、目录选择与进程生命周期。
- TypeScript 6、Vite 8：主进程编译和渲染资源构建。
- `@lydell/node-pty` 1.2 beta：通过 Windows ConPTY 创建真实伪终端，并提供按平台预编译
  原生模块。
- xterm.js 6 + `@xterm/addon-unicode11` + `@xterm/addon-webgl`：终端渲染、键盘输入与中文
  宽字符计算；WebGL 渲染器负责大量输出时的绘制性能，丢失上下文时回退 DOM 渲染器。
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
        ├── ChatConfigStore ── safeStorage / 全局独立对话配置
        ├── ChatService ── Anthropic/OpenAI HTTP + SSE 流式适配与取消
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

- **`--titlebar-h` (48px)** ↔ `src/main/main.ts:1373` / `:1392` `titleBarOverlay.height`（两处：
  切换主题与创建窗口）
- **`--toolbar-h` / `--footer-h` / `--composer-h`** ↔ `.terminal-shell` 网格行 ↔
  `.workbench-scrim` / `.claude-workbench` 的 `top` / `bottom`。`--composer-h` 由渲染层实测输入框
  高度后写回，抽屉的 `bottom` 是 `calc(var(--footer-h) + var(--composer-h))`；输入框自动增高时
  抽屉底边随之上移，不会盖住输入框。
- **`--surface-canvas`** ↔ `src/main/main.ts:1370` `setBackgroundColor` / `:1383`
  `backgroundColor` ↔ `body` 背景色
- **`--surface-1`** ↔ `src/main/main.ts:1372` / `:1391` `titleBarOverlay.color` ↔ `.titlebar` 背景色
- **`--text-hi`** ↔ `src/main/main.ts:1374` / `:1393` `titleBarOverlay.symbolColor`
  （Windows 标题栏按钮颜色）

#### 主题令牌桥

主题的作用域是**整个外壳**，不只是 xterm palette。`src/shared/terminal-themes.ts` 的每套主题
除 `palette`（22 个 xterm 字段）外还有 `shell`（22 个外壳字段），
`SHELL_CSS_VARIABLES` 是「shell 字段 → CSS 自定义属性」的映射表，是这套机制唯一的接线点：

1. `applyTerminalTheme`（`src/renderer/main.ts`）遍历映射表写
   `documentElement.style.setProperty(...)`，并设 `dataset.theme`；`styles.css` 里所有
   `var(--…)` 因此一起换色。启动时以 `announce = false` 调用一次。
2. 原生窗口边框由 Windows 绘制，CSS 到不了，所以渲染层再调 `ui:set-theme` IPC；主进程
   `applyWindowTheme`（`main.ts:1368`）执行 `setBackgroundColor` + `setTitleBarOverlay`。
   **只改 CSS 会留下用户看到的那圈深色边框。**
3. 主题 ID 存进 `WorkspaceStore`（`StoredWorkspace.terminalTheme`，version 仍为 1，
   `load()` 用 `isTerminalThemeId` 校验）。`createWindow()` 在第一帧之前读它决定初始
   `backgroundColor` / `titleBarOverlay`，冷启动不会闪出错色外框。

新增主题只需补 `shell` 字面量；新增可主题化的属性需要同时补 `TerminalThemeShell` 字段、
`SHELL_CSS_VARIABLES` 条目和 `:root` 默认值——`tests/design-tokens.test.ts` 会检查这三者齐全，
并要求该属性在 `styles.css` 正文里至少被引用一次（否则是死令牌）。

`tests/design-tokens.test.ts` 同时守住「主题能生效」的前提：`:root` 之外不允许 hex 字面量、
不允许带色相的 `rgb()`/`rgba()`、`font-family` 只能是两个字体令牌或 `inherit`、不允许写死
`font-size`。半透明色用 `color-mix(in srgb, var(--token) n%, transparent)`。
一次性的批量替换脚本保留在 `scripts/tokenize-colors.cjs`（按 CSS 属性判角色、
alpha 令牌先合成到 `--surface-2` 再比色、打印 CIE76 色差报告，`--write` 才落盘）。

`letterSpacing: 0` 是 TUI 边框对齐的必需值。状态三色（`--ok-*` / `--warn-*` / `--bad-*`）
刻意不进主题——语义色跨主题保持一致。

#### 终端输出与输入的性能路径

- xterm 在 `createTerminalView` 里 try/catch 加载 `@xterm/addon-webgl`，并监听
  `onContextLoss` → `dispose()` 回退 DOM 渲染器。加载失败不影响会话可用性。
- **主进程侧合并**：`queueTerminalOutput`（`main.ts:105`）按会话攒 8ms（`OUTPUT_FLUSH_MS`）
  或 64KB（`OUTPUT_FLUSH_BYTES`）发一次 `terminal:data`。IPC 往返次数是卡顿主因。
  `consumeTerminalOutput` 仍逐块调用——它跨块跟踪退出标记，合并后的缓冲会导致漏判。
  `before-quit` 清理全部待发定时器。
- **渲染层侧合并**：同名的 `queueTerminalOutput`（`src/renderer/main.ts:2341`）按
  `requestAnimationFrame` 把队列合成一次 `terminal.write`，缓冲上限 512KB（超限丢弃最旧
  分块，xterm 的 scrollback 随后也会丢掉它们）。销毁视图的两处（`renderWorkspace` 清理过期
  会话、`beforeunload`）都要 `cancelAnimationFrame(view.pendingFrame)`。
- **可见后布局**：活动 xterm 的容器在 `terminal.open()` 前就带
  `project-terminal--active`；会话切换、宽度变化、`ResizeObserver`、窗口重新获得焦点或从
  后台恢复时，`scheduleActiveTerminalFit` 会用带 generation 的四个连续绘制帧做有界重试。
  `fitActiveTerminal` 在容器未连接、未激活或矩形为 0 时直接返回，避免把隐藏态的错误网格
  回传给 PTY。
- **全局指针捕获收口**：两个宽度分隔条共用 `activeResizeCleanups`。正常抬起、系统取消、
  `lostpointercapture`、窗口失焦、页面隐藏和重新聚焦都会调用幂等清理，显式
  `releasePointerCapture` 并移除 `body.is-resizing`。这是窗口内所有按钮、下拉框、textarea
  偶发同时失去命中响应的统一修复边界。
- **确认框不越过 renderer 焦点边界**：Electron/Chromium 在 Windows 关闭原生 JavaScript
  `alert` / `confirm` 后存在 DOM 控件无法重新获得焦点的问题；xterm 的中文组合输入又依赖
  隐藏 textarea，因此会出现“英文原始按键仍可输入，但中文和主输入框都卡住”的不对称症状。
  renderer 统一用本地 `<dialog>` 实现二次确认，关闭后在下一绘制帧恢复打开前的控件，
  不再调用原生 JavaScript 对话框。
- **激活时状态自愈**：窗口重新获得焦点或页面从后台变为可见时，renderer 除了重新适配 xterm
  外，还通过 `getWorkspace()` 获取一次主进程真值并重新渲染。这样即使隐藏/恢复期间漏掉阶段
  事件，主输入框也不会因旧的非 `running` 快照长期保持 `disabled`。
- 输入框的 `Ctrl+A` / `Shift+←→` / 拖选 / `Ctrl+Z` / IME 全部是 `<textarea>` 原生行为，
  **没有对应代码**。需要实现的只有发送、历史与自动增高，见
  `src/shared/composer-input.ts` 与 `src/shared/composer-history.ts`。
  `buildTerminalSubmission` 用 `\x0a` 连接多行、末尾补 `\r`，与 `terminal-session.ts` 里
  PSReadLine 的 `Ctrl+j`(AddLine) 绑定成对存在：改一处必须改另一处，否则多行提示词会被
  逐行当成独立命令执行。输出区内的 `Ctrl+A` 由 `attachCustomKeyEventHandler` 映射到
  `terminal.selectAll()`（否则会被 PSReadLine 解释成「移到行首」）。

### 关键取舍

- **拒绝 Win11 `backgroundMaterial: 'mica'/'acrylic'`**：半透明桌面色调与需要接近纯黑对比度的终端直接冲突，且在非 Win11 上降级不可预测。
- **遮罩层不用 `backdrop-filter`**：遮罩覆盖在持续刷新的 xterm canvas 上，背景模糊会在 Claude 流式输出时每帧强制 GPU 合成，造成性能问题。
- **输入用 `<textarea>` 而不是在 xterm 里做行编辑**：`Ctrl+A`、`Shift+←/→`、拖选、`Ctrl+Z`、
  IME 全部由浏览器免费提供且行为正确；在终端画布里模拟它们意味着自己实现一个编辑器，
  并且要和 PSReadLine 抢同一批按键。代价是终端不再是唯一输入入口，需要为 Claude Code 的
  TUI 保留直接聚焦输出区的能力。
- **主题存在主进程而不只在 `localStorage`**：原生窗口边框在第一帧就要有颜色，此时渲染进程
  还没运行，只靠 `localStorage` 一定会闪一下错色外框。

## 渲染进程与 IPC

- 渲染进程不启用 Node.js，只能调用 preload 暴露的固定方法。
- 主进程验证 IPC 发送方、会话标识、字符串长度、终端尺寸和目录是否真实存在。权限模式只接受
  六个已知取值，模型选项 ID 只接受 `current` 或 `history:<id>` 形态，重启入参逐字段校验；
  这些值最终都会影响启动命令或写进运行中的终端，所以一律在主进程重新核对，不信任 renderer。
- `TerminalWorkspace` 维护项目 ID、活动项目和多个 `TerminalSession`；每个会话拥有独立 PTY。
- `TerminalWorkspace` 构造出来是空的，也允许一直是空的：会话总是属于用户选定的文件夹，
  冷启动和关掉最后一个对话之后都没有活动会话。`getActiveStatus()` 因此返回
  `TerminalStatus | undefined`，`OperationResult.status` 也是可选字段，渲染层要判空。
  用 `homedir()` 兜底会造出一个以 Windows 用户名命名、用户从没打开过的项目。
- PTY 输出携带会话 ID 推送到渲染进程，并写入对应 xterm.js 实例；只有活动实例可见。
- 添加目录会记住该项目并创建首个会话；同一路径可由项目层级继续新开多个独立对话。
- `directory:choose` 从 IPC sender 解析真实所属 `BrowserWindow`，并仅在活动 cwd 仍是可访问
  目录时把它设为 `defaultPath`，否则回退到用户目录。带父窗口的原生对话框若因 Windows
  owner handle 状态失败，会无父窗口重试一次；失败原因通过结构化结果返回，不与后续
  `project:add` 错误混淆。
- 切换项目不重启 PTY；关闭项目才会终止对应进程，且不会影响其他会话。
- `WorkspaceStore` 把已添加项目、最后激活路径与所选主题保存到
  `userData/claude/workspace.json`。写入采用临时文件加重命名；启动恢复不会改写原来的
  最后激活项，项目切换和关闭后再同步状态。`terminalTheme` 是可选字段，`load()` 用
  `isTerminalThemeId` 校验后才采用，因此写入未知主题 ID 只会回退到默认主题而不破坏文件，
  version 保持 1。
- 托盘从 `WorkspaceState` 计算错误/运行聚合图标、运行数量和项目切换菜单。

### 全局设置 IPC

- `app:get-settings` 从真实运行时读取 `app.getVersion()`、Windows 登录项状态和
  `WorkspaceStore` 主题；语言当前固定为唯一已提供的 `zh-CN`。renderer 不维护版本常量。
- `app:set-launch-at-login` 只接受布尔值，调用 Electron `app.setLoginItemSettings()` 后再次
  读取实际状态返回。打包版本使用 `process.execPath`；开发版本额外传入 `app.getAppPath()`，
  避免登录项只启动空 Electron。
- 主题继续复用 `ui:set-theme` 与 `WorkspaceStore.terminalTheme`，全局设置和终端工具栏只
  是两个 UI 入口。全局设置“接入”分类移动的是原高级工具的同一组 DOM 节点，仍使用原草稿
  快照与即时操作边界，没有新增第二套 Router/诊断状态。

### 独立模型对话

- `ChatConfigStore`（`src/main/chat-config-store.ts`）把单一独立 profile 原子写入
  `userData/claude/chat-profile.json`。renderer 只能读取协议、基址、模型、认证方式和
  `credentialConfigured`；密钥用 Electron `safeStorage` 加密，安全存储不可用时拒绝明文
  降级。该文件和项目级 `project-profiles.json` 没有共享键或联动逻辑。
- 基址校验只允许远程 HTTPS，本机 `localhost` / `127.0.0.1` / `::1` 可以使用 HTTP；拒绝
  URL 用户信息、查询和片段。模型名、凭据长度与换行、credential action 均在主进程重验。
- `ChatService`（`src/main/chat-service.ts`）只在 Electron 主进程使用 Node `fetch`。Anthropic
  协议补全 `/v1/messages`、发送 `x-api-key` 和 `anthropic-version`，并解析
  `content_block_delta`；OpenAI 兼容协议补全 `/v1/chat/completions`、支持 Bearer，并解析
  `choices[0].delta.content`。中转若返回非 SSE JSON，则提取对应协议的普通文本响应。
- renderer 通过 `chat:start` 发起，主进程用 `requestId → AbortController` Map 管理 120 秒
  超时与 `chat:stop`；`chat:stream` 只推送 start/delta/done/error/aborted，不推送请求头或
  凭据。每次最多 100 条消息、单条 200,000 字符、请求合计 1,000,000 字符、响应
  2,000,000 字符；错误文案再次替换可能回显的凭据。
- 首期聊天消息只存在 renderer 内存，不写磁盘、不读取项目文件，也不创建 PTY。新对话清空
  当前运行期数组；应用退出后正文自然消失。持久化历史需要先增加“隐私与数据”保留/删除规则，
  不在本轮隐式开启。

## Claude Code 接入与会话

### 项目级路由

- ClaudeDock 以规范化绝对项目路径作为配置键；非敏感配置和加密凭据保存在 Electron
  `userData/claude/project-profiles.json`，不写入仓库中的 `.claude/settings*.json`。
- `ClaudeConnectionHistoryStore`（`src/main/claude-connection-history.ts`）在
  `userData/claude/connection-history.json` 按项目保存最近 20 条接入配置，写入同样是
  临时文件加 `renameSync`、权限 `0600`；文件损坏时 `load()` 回落到空存储而不是抛错。
  项目键用小写后的绝对路径，因为 Windows 路径大小写不敏感。
  凭据以 `safeStorage.encryptString(...)` 的 base64 存放；`decrypt` 在安全存储不可用时返回
  `undefined` 而不是抛错，所以恢复出来的记录顶多是“没有凭据”，不会变成明文。
- 判重用 `apiKeyHelperPolicy`、认证方式、地址、凭据、主/快速模型、预设和 provider 的
  SHA-256 指纹，
  只和最新一条比较：相同就不新增。指纹**刻意不含 `gatewayState`**——它描述的是保存那一刻
  机器的状态而不是用户填的配置，网关在 running/stopped 之间反复跳会把同一份配置刷成一堵墙。
  网关状态仍然逐条存下来，恢复时能看到当时的情况。
- `saveConfig` 成功后才记历史，且整个记录过程包在 try/catch 里：配置已经保存了，
  少一条历史不值得让保存失败。`applyConnectionHistory` 走的是同一个 `saveConfig`，
  所以恢复和手工保存的路径完全一致。历史条目 ID 由主进程用
  `/^history-[a-z0-9]{1,16}-[a-z0-9]{1,16}$/` 校验后才接受。
- renderer 将历史作为接入主流程组件固定在服务商选择与模型表单之间，不把它移动进全局设置
  `<dialog>`。每条恢复按钮显式渲染 `baseUrl`（接口/网关）、`gatewayEndpoint`（与基址不同时）、
  `model`、`modelFast`、认证方式、`apiKeyHelperPolicy`、凭据布尔值和保存时网关状态；列表在
  360px 高度内独立滚动，长地址和模型名允许断行。
- Anthropic 官方接入支持 Claude Code 现有登录或 `ANTHROPIC_API_KEY`。兼容网关设置
  `ANTHROPIC_BASE_URL`，并支持 `X-Api-Key`、Bearer Token 或本机无认证三种模式。
- 接入配置分别保存 `model` 与 `modelFast`。主模型写入 `ANTHROPIC_MODEL`、
  `ANTHROPIC_CUSTOM_MODEL_OPTION`、Opus 与 Sonnet 别名；快速模型写入
  `ANTHROPIC_DEFAULT_HAIKU_MODEL` 与 `ANTHROPIC_SMALL_FAST_MODEL`。旧配置缺少快速模型时
  自动回落到主模型；启动时同时使用 `--model` 提高可观察性。
- 带 `/v1/chat/completions` 的服务是 OpenAI Chat Completions 格式，不能直接满足
  Claude Code 的 Anthropic `/v1/messages`、流式内容块和工具调用语义，必须经
  Claude Code Router、LiteLLM 或服务商自己的协议转换层。
- DeepSeek 官方目前另行提供 Anthropic 格式，基址为
  `https://api.deepseek.com/anthropic`；因此 DeepSeek 官方预设可以直连。官方兼容表仍列出
  图片、文档、部分 MCP/代码执行结果等不支持
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
   旧 CCR profile 把真实会话重新指向已停止的 `3456`。项目级 `apiKeyHelperPolicy` 默认为
   `prefer-claudedock`：仅当认证方式是显式 API Key / Auth Token 时，在该临时高优先级 settings
   写入空 `apiKeyHelper`，让本次 ClaudeDock 会话只使用安全存储中解密后注入的凭据；`inherit`
   则不写覆盖，保留 Claude Code 自己的 helper。现有登录和无认证模式不会停用 helper。
   同一份 settings 里注册两个本地脚本：
   statusLine 指标采集和 `PostCompact` 完成信号，都只写本地 JSON，不外发。
3. 主进程重建当前 PowerShell，并在 PTY 创建时注入路由与解密后的凭据；密钥不会出现在
   命令行、临时 settings、xterm.js 输入或 PowerShell 历史中。认证策略属于端点指纹的一部分，
   修改后必须重启 PTY，不能把旧会话当作同一端点热切模型；Claude 退出后命令会清理所有受管
   环境变量与第三方路由别名。
4. 非必要流量保护固定启用：
   `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`、`DISABLE_TELEMETRY=1`、
   `DISABLE_ERROR_REPORTING=1`、`DISABLE_FEEDBACK_COMMAND=1`、
   `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1` 和 `DO_NOT_TRACK=1`。网关模式还关闭自动更新。
5. 临时 settings 设置 `skipWebFetchPreflight: true`，避免 WebFetch 在第三方模型接入时仍把
   域名发往 `api.anthropic.com`。这会同时取消 Anthropic 的域名安全块列表检查，因此
   WebFetch 的最终风险仍由 Claude Code 权限提示和用户判断承担。
6. 启动命令按项目的 `allowBypassPermissions` 追加
   `--allow-dangerously-skip-permissions`（把 `bypassPermissions` 加进 `Shift+Tab` 循环，
   但不以该模式启动），需要以特定模式启动时另加 `--permission-mode <mode>`。两者不叠加：
   直接以 `bypassPermissions` 启动时不再附加 `--allow-` 变体。这个开关的默认值是开启，
   但「预置」和「激活」是两件事——ClaudeDock 不会替用户进入完全允许模式。

`safeStorage` 在 Windows 使用操作系统凭据保护能力；若不可用，保存密钥会失败关闭，而不是
回退到明文。渲染进程只能获得 `credentialConfigured` 布尔值，从不获得已保存密钥。

### 自动发现与新手接入

- `src/shared/claude-providers.ts` 是接入目录的单一事实来源：21 个预设统一声明分组、基址、
  认证方式、主/快速模型、控制台、文档、密钥提示和风险说明。`ClaudePreset` 直接派生自目录
  ID；主进程 IPC 用目录 ID 集合校验，外链白名单从目录 URL 主机派生，避免 renderer、主进程
  与文档手写三份漂移。原有 `anthropic / deepseek / gateway / custom` ID 保持兼容。
- `normalizeClaudeConfig` 用目录分组推导 `provider`：官方组进入 `anthropic`，其余进入
  `gateway`；未知的旧预设按可验证配置迁移到 `custom`，无效基址或模型则安全回到默认配置。
- renderer 用 `selectedProviderId | undefined` 驱动三步 UI。点击不同服务商会清空未保存
  凭据、旧测试结果与修复建议；再次点击同一服务商进入 `undefined`，同时隐藏服务商说明、
  配置表单、测试结果和修复卡。Router/cURL 选择把原有完整工具节点移动到第二步，其他时候
  移回“全局设置 → 接入”，没有缩减或复制原功能。
- 五个服务商分组由独立 `Set<ClaudeProviderGroupId>` 保存折叠状态；每次切换只更新当前分组
  的 `data-collapsed`、ARIA 与 `inert`，CSS 用可插值的网格行和透明度过渡。服务商卡片网格
  用命名容器查询在 `<290 / 290–469 / >=470px` 切换一、二、三列，因此响应侧栏实际拖拽
  宽度，而不依赖整个窗口的媒体查询。进入“接入”页时调用纯函数
  `collapsedClaudeProviderGroups`，根据已选或已保存 preset 重建折叠集合，只保留其所在组展开；
  项目配置尚未返回时先全折叠，`renderClaudeState` 到达后只补做一次正确展开。
- 全局设置的“接入”分类使用原生模态 `<dialog>` 和唯一一组原有工具节点，认证来源选择由同一快照
  机制管理 `apiKeyHelperPolicy`。打开时保存服务商草稿及模态层
  内所有 `input/select/textarea` 的值与勾选状态；“取消”、关闭按钮和 `Esc` 恢复快照，
  “完成”保留当前输入。Router 安装/卸载/启停与 Provider 保存仍走既有即时 IPC，不能伪装
  成可回滚事务，界面在操作区上方明确说明这一边界。接入历史不属于高级诊断工具，因此不进入
  快照范围，也不会随 Router/cURL 工具节点移动。
- Kimi 开放平台与 Kimi Code 会员分为两个目录项，明确阻止密钥/基址混用；SiliconFlow 按其
  Claude Code 文档使用 `apiKey`（`x-api-key`）；Ollama 使用不落盘的 `ollama` 占位令牌。
- `ClaudeGatewayDetector` 每次最多缓存 3 秒，renderer 在“接入”页打开期间每 6 秒刷新。它用
  短连接检查 Claude Code Router 默认 `3456/3458` 与 LiteLLM 常用 `4000`，不会枚举或扫描
  全部本机端口。
- `BackgroundTaskCoordinator` 为安装检测、Router 状态、网关扫描、软件更新和连接实测提供
  两个并发槽。相同 key 的并发请求共用同一个 Promise，用户触发的连接实测会排在尚未开始的
  后台刷新之前；`AsyncRefreshCache` 让安装、Router 和更新检查在 TTL 内复用结果，并防止旧
  请求覆盖操作后的新状态。这些工作本身是异步网络/子进程 I/O，采用限流队列比额外占用
  Worker Thread 更合适。
- renderer 完成首屏工作区 hydration 后用零延时任务启动统一更新检查，不阻塞终端启动：
  `SoftwareUpdates` 读取 Claude Code/Router 元数据，插件侧在独立 Claude CLI 子进程中先刷新
  marketplace 再读取目录。标题栏按钮复用同一路径并强制刷新；两条路径都不会调用模型。
- CCR 的识别依据包括 `ccr` 命令、旧版
  `~/.claude-code-router/config.json`、新版 Windows
  `%APPDATA%/claude-code-router/{config.sqlite,gateway.config.json}`，以及默认端口状态。
  只检查配置文件是否存在，不读取 SQLite 中的密钥或上游凭据。
- 对 `3456/4000` 的后台探测只执行不带凭据的 `GET /v1/models`：`200` 表示可访问，
  `401/403` 表示接口已运行但需要网关访问密钥。管理页 `3458` 只做 TCP 存活判断。
- 检测会只读解析用户 `~/.claude/settings.json`、项目 `.claude/settings.json` 和
  `.claude/settings.local.json` 的 `env` 块与 `apiKeyHelper` 是否为非空字符串，只向 renderer
  传递净化后的 `ANTHROPIC_BASE_URL`、静态凭据及 helper 是否存在的布尔值；helper 命令和密钥值
  都不跨 IPC。
- `src/shared/claude-curl.ts` 在本地 renderer 中解析 cURL 的 URL、`model`、Bearer 或
  `x-api-key`。URL 的用户信息、查询参数和片段不会进入结果；解析文本不写日志。切换项目会
  清空 cURL 输入与内存中的解析结果；一键导入 Router 成功后也会立即清空。
- OpenAI cURL 可由用户主动一键写入 CCR Provider；上游密钥只发给本机 CCR 管理 RPC，
  Router 客户端密钥只由主进程写入 ClaudeDock 的 DPAPI 配置。两类密钥不会互相代用。
- 帮助按钮仅允许打开服务商目录、Claude/LiteLLM/CCR 声明的文档与控制台域名；本机管理页仅允许
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
- 卸载是「彻底清除」，目的是把机器恢复到真正未安装的状态，让用户可以换来源重装。步骤固定：
  1. 只停止经 `service.json` token 与 identity 校验的 CCR 服务（`stopGateway` +
     对该 PID 发 `SIGTERM`），等待 600ms 让守护进程释放 SQLite 句柄。
  2. npm 版走 `removeCliInstallation`：先按固定包名 `npm uninstall --global`；包目录仍存在时
     再按检测到的安装目录 `npm uninstall --global --prefix <installDirectory>`；仍存在才直接
     `rmSync(packageRoot)` 并删除同目录的 `ccr` / `ccr.cmd` / `ccr.ps1` shim。
     **`npm uninstall --global` 只能触及当前 npm prefix 下的包**，CCR 装在
     `D:\ClaudeCode` 而 prefix 是 `%APPDATA%\npm` 时前两步都无效，第三步才是必需的。
  3. 桌面版找到已知卸载程序就 detached 启动；找不到不再抛错中断整个流程，改为继续清数据并
     在返回消息里引导用户去 Windows“已安装的应用”移除。
  4. 删除 `%APPDATA%\claude-code-router` 整个目录（内容清单见 `ROUTER_DATA_ENTRIES`：
     `config.sqlite` / `api-keys.sqlite` / `usage.sqlite` / `gateway.config.json` /
     `service.json` / `gateway-proxy-preload.cjs` / `claude-app-gateway-backup.json` /
     `global-profile-takeover.json` / `bin` / `provider-icons` / `raw-trace-spool`），
     以及本应用的安装包缓存，并失效 `serviceRuntimeCache`。
     **Provider 配置与上游密钥由此不可恢复**，renderer 的确认弹窗必须明说这一点。
- 递归删除的路径由 `routerDataDirectory(appData)` 计算：非绝对路径、basename 不是
  `claude-code-router`、或父目录不等于传入的 APPDATA 时返回 `undefined` 而不删除。这样被
  篡改的 `APPDATA` 无法扩大删除范围，`~/.claude` 下 Claude Code 与 Codex 自己的配置也永远
  触及不到（符合「不得修改 Codex、Claude Code 或系统级 API 路由」）。
- `canUninstall` 是 `Boolean(cli || desktop || 数据目录存在)`：程序已经没了、只剩孤立配置目录
  时，清理入口依然可达。

### 软件与插件更新

- `SoftwareUpdates` 从 npm 官方 registry 读取 Claude Code 与 Router 的 `latest` 元数据；
  官方源失败时再读 npmmirror。结果缓存 5 分钟，接入页轮询只在缓存到期后产生网络请求。
- `src/shared/update-actions.ts` 把检测结果纯函数化为 `hidden / install / update`：状态尚未
  返回时不显示操作；目标未安装时显示安装；只有已安装且 `updateAvailable` 为真时显示更新。
  插件“更新全部”同样要求 `updatesAvailable > 0`，单插件更新按钮则直接受该插件的
  `updateAvailable` 控制。
- 标题栏 `refresh-updates` 是唯一的主动更新检查入口。首屏自动检查和用户点击均并行检查
  软件与插件，图标以 `aria-busy`/旋转反馈过程，以琥珀点和动态 `aria-label` 表达已发现数量；
  检查本身不安装任何内容。
- Claude Code 的官方原生路径使用固定的 `claude update`；未安装时使用固定 winget ID
  `Anthropic.ClaudeCode`。npm 与 npmmirror 路径使用固定包名，均不拼接用户输入到 shell。
- `ClaudePluginManager` 调用 `claude plugin list --json --available` 与 marketplace JSON
  接口。插件标识、市场名和市场来源分别经过格式校验；变更后强制刷新目录。CLI 返回版本或
  source SHA 时与市场记录比较并标记更新；统一刷新会先执行官方 marketplace update，确认
  有新版后才允许单个或批量执行官方 `plugin update`。
- **CLI 对已装与可装插件的描述形状不同**，这是曾经导致已安装插件两边都看不到的原因：
  `available` 条目带 `pluginId` / `name` / `marketplaceName` / `description`，而 `installed`
  条目**只有 `id`（`plugin@marketplace`）**，没有 `name`、没有 `description`，`version` 常为
  字符串 `"unknown"`；同时 CLI 已把已装插件从 `available` 里剔除。因此 `parsePluginEntry`：
  - `pluginId` 依次接受 `pluginId` → `id` → `name@marketplaceName`；
  - `name` / `marketplaceName` 缺失时从 `pluginId` 按 `@` 拆分反推，市场名兜底为 `本地`；
  - `version === 'unknown'` 归一化为 `undefined`，既不显示 `vunknown`，也不会与市场版本
    比较出虚假的「可更新」。
- `installed` 缺失的说明与来源由 `enrichInstalledPlugins` 用市场清单补齐：清单读自
  `parseMarketplaces` 返回的 `installLocation` 下的 `.claude-plugin/marketplace.json`
  （读取函数以参数注入，便于单测）。只在字段仍是兜底值时才覆盖，CLI 自己给出的说明优先。
  市场清单读取失败不影响已成功解析的插件。
- `src/shared/plugin-localization.ts` 不调用外部翻译接口。它按安全、测试、API、数据、运维、
  前端等可追踪关键词生成中文能力概括；renderer 只展示中文概括，插件 ID 始终使用 CLI
  返回值，搜索仍覆盖原文、中文概括与分类。该概括属于项目自研规则，不是插件作者译文。
  插件命令的英文标准错误不会直接进入界面，而是映射成中文操作提示。
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
- 主进程通过 `ReadableStream` 最多读取 64 KiB 响应体，达到上限立即取消余下正文；只抽取
  180 字符的结构化错误消息并再次清除当前凭据，成功响应正文不返回 renderer。15 秒超时或
  网络错误只回传分阶段诊断。
- 已保存凭据从 `safeStorage` 解密后仅用于该次测试；表单新输入可在保存前测试。测试结果
  不包含凭据或模型回复文本。
- `src/shared/claude-connection-remedy.ts` 把安装门禁、Router 生命周期、401/403、404、
  400/422、超时/网络、200 非标准响应和 Kimi 密钥族不匹配映射为结构化原因、建议与动作；
  renderer 只负责执行打开控制台/文档、切认证、用快速模型、安装/启动 Router、重试或重选。
- “测试并接入”严格串行：真实测试 `ok` 后才调用保存；“跳过测试并保存”是明确的次操作。
  该按钮不用通用 `runGuarded` 包裹，因为成功路径会嵌套保存并重新渲染控件；它由
  `connectionTestInProgress` 单独防重，并在唯一 `finally` 中先清 busy 状态和原文案，再让
  `syncConnectionInteractivity` 按最新环境重算 disabled。这样成功、失败、异常和保存后的重绘
  都不会把测试前快照中的 disabled 状态永久写回。测试期间跳过 6 秒轮询并禁用服务商/配置
  控件，但不阻断导航或 PowerShell 输入。
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
  重复生成第二份列表；历史条目全部渲染进 `.project-folder__history` 独立滚动容器（约六行
  高），运行中对话保持在容器上方不动，滚动位置按文件夹记录、在侧栏因工作区状态刷新而
  重建后恢复。文件夹的展开状态只控制历史区：`expandedFolders` 不再被活动会话强制置为
  展开，收起使用中的项目时保留运行中对话行、只隐藏历史与提示区。
- 历史右键重命名先验证项目路径、UUID、文件类型、50 MiB 上限和 1–60 字符标题，再向对应
  JSONL 追加 `type: "custom-title"` 记录，不重写正文。运行中重命名先更新工作区标题；若该
  PTY 正在运行 Claude Code，再发送白名单 `/rename <title>` 让 Claude 元数据同步更新。
- 历史删除的 renderer 入口同时存在于每行 `×` 与右键菜单，两者调用同一应用内危险确认。
  删除 IPC 传入的是项目路径与 conversation UUID，不再依赖某个仍存活的终端 ID；主进程重新
  规范化项目路径并校验 UUID，`ClaudeSessionManager.deleteSession()` 最终只允许删除编码后
  项目目录下精确的 `<uuid>.jsonl`。若 statusLine 表明同一 conversation 正在运行，renderer
  先通过现有 `project:close` 停掉对应 PTY，成功后才删除。
- Claude Code 2.1.220 的公开 CLI 没有单会话删除命令；`claude project purge` 会清空整个
  项目范围，不能用于本功能。因此当前实现明确属于现有的严格兼容删除路径，不宣称为官方 API。
- Claude Code 2.1.196+ 会用小型/快速模型根据首条提示词生成短标题；官方 statusLine 的
  `session_name` 在存在 `/rename`/`--name` 自定义名称时返回自定义名称，否则返回该 AI 标题。
  ClaudeDock 已要求 2.1.197+，因此直接把这个字段同步到对应 `TerminalWorkspace` 标题，不再
  额外运行 `claude -p`、不注入隐藏提示词，也不解析终端绘制文本。工作区记录每个 PTY 最近
  看见的 Claude 标题：手动重命名后重复到达的旧状态行会被忽略，直到 Claude 返回一个新名称，
  避免 `/rename` 处理期间界面短暂回退。
- 渲染层在 `renderWorkspace` 中对比每个会话上一次渲染的标题：标题变化且非手动重命名时，
  启动与 DOM 解耦的打字机动画（保留公共前缀 → 逐字擦除 → 逐字输入，间隔加轻微随机抖动，
  `data-title-typing` 驱动 CSS 光标）。动画状态存于 Map，侧栏因工作区刷新重建时读取当前
  帧续播；会话关闭时清理定时器。手动重命名通过一次性抑制集合跳过动画，
  `prefers-reduced-motion: reduce` 下不播放动画、直接落最终标题。
- 定向恢复把经过 UUID 校验的 session ID 交给统一的 PowerShell 命令构造器，因此继续保留
  参数单引号转义、`--no-chrome`、凭据环境清理和不可见退出标记。删除同样限定为当前项目
  目录下的精确 `<session-id>.jsonl` 文件。
- `assets/runtime/claude-statusline.ps1` 从 stdin 接收官方 statusLine JSON，原子写入模型、
  session ID、session name、上下文窗口、输入/输出 token、估算费用、持续时间和改动行数。
  stdin 必须显式按 UTF-8 解码（`StreamReader` + `UTF8Encoding`），不能用 `[Console]::In`：
  中文 Windows 的控制台代码页是 GBK，多字节 `session_name` 会被解错，双字节读还可能吞掉
  JSON 的结尾引号导致整个解析失败——症状是恢复带 AI 标题的历史会话后完全没有指标，而全新
  （未命名）会话正常。主进程每秒读取变更，通过受限 IPC 推送，同时把有效的 1–60 字符
  session name 同步到工作区标签。
- 上下文占用使用 `context_window.used_percentage × context_window_size`，而不是累计所有
  历史请求。Claude Code 会在接近窗口上限时自动 compact；界面的“实时”表示每次 statusLine
  刷新后的最新状态，不代表逐 token 流式计数。
- 费用是 Claude Code 客户端本地估算：订阅用户不等同于账单，第三方模型若缺少定价元数据
  也可能为空或不准确。网关在服务端替换模型无法由客户端进行密码学证明；界面只能核对
  statusLine 报告的运行模型与锁定模型是否一致。

### 运行中换模型与权限模式

**模式真值来自终端徽标。** Claude Code 的 statusLine JSON 里没有 `permission_mode` 这个
字段（逐条核对过官方字段表），SessionStart hook 的载荷也不带它。唯一持续可读的来源是
TUI 自己重绘的模式徽标：`⏸ manual mode on` / `⏵⏵ accept edits on` / `⏸ plan mode on` /
`⏵⏵ auto mode on` / `⏵⏵ don't ask on` / `⏵⏵ bypass permissions on`。
`parseClaudePermissionMode` 位于 `src/shared/claude-permission-mode.ts`，先去掉 CSI/OSC、
折叠空白，再取位置最靠后的完整徽标。

Claude Code 的 Ink 界面会用光标移动只重绘发生变化的单元格。实测从 manual 切到 accept edits
时，PTY 新增数据不是完整的 `accept edits on`，而是带 `CSI n C` 的字符残片；直接剥掉控制序列
会得到 `ccept edits on`，旧的主进程原始字节解析因此会误报“没有响应”。renderer 为每批排队的
PTY 数据递增 `outputRevision`，只在 `terminal.write(..., callback)` 完成后推进
`appliedOutputRevision`。主进程需要切换前/后的快照时，通过双向 probe IPC 主动请求；renderer
等请求时点之前的修订全部应用后，从 `terminal.buffer.active` 的完整活动缓冲区逐行读取
`translateToString(true)`，解析徽标并带 probe ID 回报。主进程重新校验 session ID、probe ID
与六种已知模式，再更新闭环状态。4,000 字符原始诊断缓冲只保留为完整首帧的启动兜底和
API Error 识别，不再承担屏幕差量重建。

**列表点击是闭环步进，不是盲按 N 次。** `auto` 是否出现在 `Shift+Tab` 循环里取决于账号、
模型和供应商，客户端无法先验判断，所以「算差值按 N 次」一定会在某些账号上切歪。
`setPermissionMode` 先主动取一次屏幕快照：没有完整徽标时直接停止且不发送任何按键，避免
`Shift+Tab` 落进选择器、确认框或其他交互上下文。确认当前模式后才写一次 `ESC [Z`（xterm 对
`Shift+Tab` 发的就是这段 CBT 序列），再以 50ms 轮询主动快照、最多等待 2 秒；只有观察到不同
模式才进入下一步，命中目标立即停止。已访问模式保存在集合里，一旦回到旧模式就判定目标不在
当前循环中；单步没有得到确认时也停止，不会为了“碰碰运气”继续发键。`modeSwitchLocks` 按
sessionId 串行化，两次快速点击不会把按键叠在一起。渲染层只报告 xterm 当前屏幕的事实，
不按菜单点击乐观改状态；底栏永远显示主进程校验后回传的徽标。

**两个模式进不了循环。** `bypassPermissions` 无法在未预置的会话中进入（官方明确说明），
必须启动时带 `--allow-dangerously-skip-permissions`（加入循环但不激活）或
`--permission-mode bypassPermissions`（直接进入）。ClaudeDock 采用前者，按项目持久化在
`claude-config-store.ts` 的 `allowBypassPermissions`，默认 `true`；这个字段刻意不放进
`NormalizedClaudeConfig`，因为它左右的是启动命令而不是模型路由，保存接入配置时也必须
原样带过去，不能被静默重置。`dontAsk` 永远不在循环里，只能 `--permission-mode dontAsk`
启动，因此它走重启路径。

**换模型分同端点与跨端点。** `getClaudeModelOptions` 合并当前配置与该项目的接入历史，
按 `provider|preset|authMode|apiKeyHelperPolicy|baseUrl` 判定 `sameEndpoint`。同端点直接向
运行中的会话提交 `/model <model>`，对话不中断，随后由既有的 `expectedModel` /
`modelMatches` 漂移检测核对 statusLine 报回的真实模型。模型列表的 `activeModel` 优先取本次
会话已提交的 `expectedModel`，其次取 statusLine 的 `modelId`，最后才回落到项目默认配置。
跨端点必须重启：`ANTHROPIC_BASE_URL`、凭据和 helper 策略是 PTY spawn 时定死的环境/临时设置，
运行中改不了。

Claude Code 的 TUI 会把同一 PTY 写入中的命令正文和尾随回车视为一次粘贴，可能吞掉回车。
`switchModel` 因此不能写 `` `/model ${model}\r` ``：它与 `/compact`、命令页白名单动作一起
进入 `commandSubmissionQueues` 的 per-session 队列，再复用
`writeTerminalSubmission(buildTerminalSubmission(...))` 先写正文、等待 40ms、单独写 `\r`。
队列防止快速操作把两条命令的字节交错；间隔两侧都检查 session 对象仍是当前且 `active`，
会话停止或重启时不向替代 shell 写迟到的回车。只有两段均成功写入后才更新 `expectedModel`。
renderer 的模型按钮在 `try/finally` 内维护 `disabled` 与 `aria-busy`，结束时先直接恢复并重绘
已有状态，再异步刷新，因此状态读取延迟或失败不会把按钮永久锁住。

`claude:switch-model` 是独立 IPC，不放宽 `/model` 的斜杠命令白名单（仍是
`['/model', false]`，不接受参数）。handler 收到的只是一个选项 ID，主进程重新生成一次选项
列表核对，模型串再过一遍 `MODEL_NAME_PATTERN`，才写进终端；渲染层给不出任意字符串。

**一个重启机制，两个调用方。** 跨端点换模型和 `dontAsk` 都走 `ClaudeRuntime.relaunch()`：
可选 `/compact` → 可选 `applyConnectionHistory` → `prepareLaunch(..., 'continue', startMode)`
→ `workspace.restart` → 写入启动命令。`--continue` 恢复当前目录最近的会话，所以对话不丢；
压缩是为了切到上下文窗口更窄的模型时不溢出。

**压缩完成靠 hook 通知。** per-session `settings.json` 里注册唯一一个 hook：`PostCompact`
执行 `assets/runtime/claude-runtime-signal.ps1`，脚本先把 stdin 读干（否则 CLI 可能阻塞在
写管道上），再原子写 `signal.json`（`$OutputPath.$PID.tmp` → `Move-Item -Force`），内容只有
`{event, signaledAt}`，不回写任何 hook 载荷。脚本吞掉所有异常：丢一个信号最多让调用方等到
超时，不能弄坏对话。主进程在已有的 1 秒 `pollMetrics` 循环里顺带读它，只处理没消费过的
`signaledAt`，避免上一次压缩的旧文件提前放行这一次重启；120 秒超时后不挂起，直接不压缩
继续重启。Windows PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，`JSON.parse` 不接受，
读取时要先剥掉。

**`Shift+Tab` 不改按键行为。** xterm 本来就把 `Shift+Tab` 编码成 `ESC [Z` 发给 PTY，
`attachCustomKeyEventHandler` 没有拦它，所以终端里这个快捷键一直是通的，缺的只是状态栏
知道模式变了。唯一需要新增的是输入框：`<textarea>` 里 `Shift+Tab` 默认做焦点遍历，
所以 renderer 拦下它并转发同一段序列，让快捷键与焦点位置无关。

### 斜杠命令可视化

渲染进程提交命令名称与可选参数，主进程只接受固定白名单：
`/context`、`/usage`、`/status`、`/model`、`/permissions`、`/mcp`、`/agents`、`/hooks`、
`/memory`、`/resume`、`/compact`、`/rename`、`/theme`、`/doctor`、`/help`、`/clear`。参数最长
500 字符且禁止换行；只有工作台已知正在运行的 Claude 会话可以接收。`/clear` 的二次确认
在渲染层完成。验证后的命令不由 IPC handler 直接拼接 `\r` 写 PTY，而交给
`ClaudeRuntime.runCommand`，与换模型和压缩共享同一分段提交与 per-session 队列。

### PowerShell 键盘与剪贴板

- 提示词的主入口是输出区下方的 `<textarea>` 输入框，不是 xterm 画布。选它的全部理由是
  `Ctrl+A`、`Shift+←/→`、鼠标拖选、`Ctrl+Z` 与 IME 组合都由浏览器原生提供，**没有对应代码**，
  因此也没有「按键处理器模拟编辑器」引入的终端弊端。需要实现的只有三件事：
  `Enter` 发送 / `Shift+Enter` 换行、`↑/↓` 翻本地历史、自动增高。
  `↑/↓` 只在光标位于首/末且无选区时才翻历史，否则方向键属于文本编辑；
  `event.isComposing` 或 `keyCode === 229` 期间一律不拦截。
  历史存在 `localStorage['claudedock.composerHistory']`（最多 200 条，
  `src/shared/composer-history.ts`），只保存提示词文本，不保存终端输出。
- `src/shared/composer-input.ts` 的 `buildTerminalSubmission` 把多行内容用 `\x0a` 连接，
  单次上限 64,000 字符。`\x0a` 正是下面 `Ctrl+J`→`AddLine` 绑定所插入的字符，
  所以多行提示词进入 PowerShell 时是**一条**命令而不是逐行执行；这两处必须成对修改。
- 它返回的是 `{ body, submit }` 两段而不是一个字符串；共享的 `writeTerminalSubmission`
  间隔 `SUBMIT_DELAY_MS`（40ms）分两次写入 PTY，并在间隔两侧检查目标会话仍有效。renderer
  的提示词、主进程的模型切换、压缩和命令页动作都走这个物理写入约束。原因是 Claude Code
  的 TUI 会把一大块单次写入判定成括号粘贴，并吞掉贴在末尾的回车——内容落进它的输入框却
  不发送，用户看到的就是「点了发送没反应」。
  对 Claude Code 2.1.220 实测：200 字符的提示词以 `body + \r` 单块发送 0/3 提交成功，
  拆成两次写入 3/3 成功。PowerShell 两种写法都一样，多行仍是一条命令。
- 每个应用内 PowerShell 启动时把控制台输入、输出和管道编码设为无 BOM UTF-8，仅为该进程
  加载 PSReadLine，并把 `Ctrl+J` 绑定到 `AddLine`；renderer 将 `Shift+Enter` 转为 LF，
  因此多行输入不需要修改用户 profile 或外部终端。
- xterm 的键盘处理在自定义快捷键前放行 `isComposing`/keyCode 229，避免截断 Windows 中文
  输入法组合事件；Unicode 11 addon 负责 CJK 宽字符单元格计算。该 addon 使用 xterm 的
  提议 Unicode API，因此终端实例显式设置 `allowProposedApi: true`；当前只把它用于固定的
  Unicode 11 addon。renderer 不再依赖可能滞后的状态快照丢弃 `onData`，主进程 PTY 仍是
  最终写入边界。
- 输出区仍可直接聚焦打字，因为 Claude Code 自身的 TUI 需要原始按键（例如 `resume` 打开的
  方向键选择器，所以该操作之后焦点留在输出区而不是输入框）。输出区内的 `Ctrl+A` 映射到
  `terminal.selectAll()`——不映射的话它会被 PSReadLine 解释成「移到行首」，用户看到的就是
  「Ctrl+A 无法全选」。
- 会话内 Backspace 处理器检测光标前是否为 PSReadLine 多行换行符：是则删除该换行并回退
  光标，否则调用标准 `BackwardDeleteChar`。该绑定不会写入用户 profile。
- 尺寸以 PTY 为准，不以 xterm 为准。`TerminalSession.resize()` 会夹紧尺寸，因此它返回
  真正采纳的 `{ cols, rows }`，主进程再通过 `terminal:size` 回传，渲染层收到后调用
  `terminal.resize()` 把 xterm 强制对齐到同一网格。这不是冗余：PSReadLine 用**绝对**光标
  移动重绘编辑缓冲（按 `Ctrl+C` 会发出形如 `ESC[10;27H` 的序列），两侧网格只要不一致，
  重绘就落在错误的行上，上一屏留在原地——这正是「两屏叠在一起」那个 bug。
- xterm 有选区时 `Ctrl+C` 通过主进程 `clipboard` API 复制；无选区时仍发送控制字符中断。
  `Ctrl+V` 从主进程读取最多 5 MiB 文本并写入当前 PTY。右键菜单复用同一受限 API，并提供
  全选和只清除 xterm 显示。
- 会话未在运行时输入框禁用并更换 placeholder；启动会话、切项目等操作记录目标 session ID，
  renderer 只在该 session 仍为活动会话且 phase 已变为 `running` 后于下一绘制帧聚焦输入框。
  固定 40/60/80ms 延时已删除，避免 PTY 冷启动慢时焦点请求落在 disabled textarea 上后丢失。
- 控制栏与工作台宽度写入 renderer `localStorage`；这只保存像素宽度，不包含项目、命令或
  终端内容。活动栏维护 `selectedRailTab | undefined`：点击当前项切到 `undefined` 后把
  控制栏设为 `inert` / `aria-hidden`、把四列工作区压成“活动栏 + 终端”，并重新安排有限次
  xterm `fit()`；`mainView` 独立记录 `terminal/chat`，所以收起“对话”配置侧栏不会把聊天
  主区误切回终端；任一其他业务导航会恢复终端。窗口缩到 900px 以下时会重新夹紧宽度；
  CSS 在 900/850px 和 700px 高度设置独立断点，避免工具栏、状态栏、插件操作区和安装来源
  控件重叠。

## 安全策略

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- 内容安全策略只允许本地脚本和样式；开发模式额外允许本机 Vite 连接。
- 禁止任意页面跳转、弹窗和未授权 IPC 通道。
- 不保存终端输入或命令历史；API 密钥只以 Windows `safeStorage` 密文持久化，终端不会收到
  含密钥的文本命令。PowerShell 自身行为不在应用持久化范围内。
- 原生 `node-pty` 只在主进程加载；`node-pty` 与需要由外部 PowerShell 执行的
  `assets/runtime/claude-statusline.ps1`、`assets/runtime/claude-runtime-signal.ps1`
  均在打包时从 ASAR 解包。
- 「完全允许」的风险由用户承担，但入口受两道限制：项目级开关必须开启，且只有启动时预置过
  的会话才能切进去（这是 Claude Code 自己的限制，客户端绕不过，也不应该绕）。首次以该标志
  启动时 Claude Code 会弹自己的一次性免责框，ClaudeDock 不代答。

## 构建、测试与调试

- `npm run dev`：并行监听主进程与 Vite 渲染进程并启动 Electron。
- `npm run lint`：检查 TypeScript 源码。
- `npm run typecheck`：分别检查渲染端和主进程类型。
- `npm test`：运行目录/工作区、Claude 配置与版本门禁、cURL 协议识别、Router 配置
  定向修改与秘密净化、官方安装包元数据校验、运行期 API 错误识别与路由阻断、连接测试
  结果映射、工作区持久化、当前项目会话解析与删除边界，并在 Windows PowerShell 中用模拟
  statusLine JSON 验证指标采集脚本；同时覆盖插件目录合并、输入校验、会话标题优先级与
  `custom-title` 写入、自动标题同步与手动重命名竞态、目录选择器默认路径回退、终端主题约束、
  PowerShell 启动脚本语法和软件语义版本比较；独立对话测试额外覆盖凭据密文落盘、URL
  安全边界、credential keep/clear，以及 Anthropic/OpenAI 两类 SSE 流、端点补全和认证头。
- `tests/renderer-html.test.ts` 使用 Prettier 的严格 HTML 解析器检查渲染入口，同时验证 ID
  唯一性和 `requiredElement` 启动依赖，防止浏览器容错解析掩盖 UI 结构损坏。
- `tests/ui-localization.test.ts` 锁定 Unicode 11 所需的 `allowProposedApi` 设置，并防止已
  汉化的终端、接入与插件文案回退为英文或重新出现“英文原文”面板。
- `tests/design-tokens.test.ts` 是「全局主题真的生效」的守栏：`styles.css` 的 `:root` 之外不得
  出现 hex 字面量、带色相的 `rgb()`/`rgba()`、第三种 `font-family` 或写死的 `font-size`；
  每个 `SHELL_CSS_VARIABLES` 属性都必须既有 `:root` 默认值又在正文里被引用；同时按 WCAG
  相对亮度校验三套主题的画布与文字对比度（`textHi`/canvas > 7，正文与强调色 > 4.5）。
- `tests/composer-input.test.ts` / `tests/composer-history.test.ts` 覆盖输入框的两个纯模块：
  多行提交必须是 `\x0a` 连接的 `body` 加上单独的 `\r` `submit` 两段，历史的去重、上限与
  游标行为；提交测试还用假时钟验证两次 PTY 写入的顺序，以及会话在 40ms 间隔内失效时不会
  发送迟到的回车。
- `tests/renderer-interaction.test.ts` 固化渲染层交互生命周期：分隔条必须显式释放捕获并覆盖
  失焦/隐藏，活动 xterm 必须可见后初始化并跨帧适配，输入框必须等待 `running`，左栏交互页
  的进场动画不得使用 `transform`；原生 `alert` / `confirm` 不得重新进入 renderer，统一
  确认框必须是可取消的应用内 `<dialog>`，窗口 focus/visibility 恢复路径必须重新读取工作区；
  活动终端的 `focus-within` 必须有主题色聚焦反馈；连接实测必须显示后台状态、在唯一
  `finally` 恢复测试按钮并让定时轮询避让；统一刷新必须在首屏后异步启动，三类更新入口默认
  隐藏；服务商反选、按上次选择单组展开、
  1/2/3 列容器查询、全局设置分类与接入快照式取消、独立聊天主视图、历史对话删除入口，
  以及活动栏二次点击收起也作为源码/结构契约锁定。底栏三件套同样在这里锁定：连接按钮必须
  用保存配置原地测试、不得跳转
  “接入”页，且忙态分支必须排在健康色分支之前（否则陈旧的路由健康会盖掉刚点下去的进度）；
  模型/模式菜单必须挂在同一套 `pointerdown` + `blur` 收拢逻辑上、900px 以下一起隐藏，六种
  权限模式必须全部出现在目录里，模型切换的 `disabled` / `aria-busy` 必须在 `finally` 中
  直接恢复，`dontAsk` 与跨端点模型必须走同一个重启函数，输入框的
  `Shift+Tab` 必须转发 CBT 序列，而模式回读必须发生在 xterm 应用屏幕差量之后；主动 probe
  还要受输出修订号屏障保护并扫描完整活动缓冲区，不能在仍有待写数据时回复旧快照。
- `tests/claude-configuration.test.ts` 覆盖启动命令的权限参数（`--permission-mode` 的引号、
  `--allow-dangerously-skip-permissions` 只在未直接以 bypass 启动时附加、关闭后两者都不出现）
  与共享 `parseClaudePermissionMode` 的六种徽标、夹带 ANSI/OSC、徽标内部被着色打断、软换行
  拆开、同一快照多次出现时取最后一次，以及未绘制徽标时返回 `undefined`；同时覆盖只有
  显式凭据 + `prefer-claudedock` 才停用继承的 `apiKeyHelper`。
- `tests/claude-runtime-diagnostics.test.ts` 额外按 PTY 分块喂入徽标（跨 chunk 边界、
  4,000 字符滚动缓冲已经把旧徽标挤出去的情况），并用真实形状的光标差量确认残片不会被误当
  完整徽标；闭环源码契约还覆盖首次按键前主动取样、单步失败即停止、已访问模式绕环检测、
  xterm 双向 probe 回报入口、per-session 互斥锁、切不到时报明确文案、`dontAsk` 与未预置的
  `bypassPermissions` 一律拒绝、模型选项在主进程重新核对、模型/压缩/命令页不再拼接尾随
  回车而是进入 per-session 提交队列、PostCompact 信号只在已有 metrics 轮询里读且只认未消费
  时间戳。
- `tests/claude-config-store.test.ts` 覆盖 `allowBypassPermissions` 与 `apiKeyHelperPolicy`
  的持久化：权限默认开启、认证来源默认 ClaudeDock 单一凭据、单独写入不动凭据、保存接入
  配置不会静默重置、没有配置过路由的项目也能记住、重开 store 后仍在且 Windows 路径
  大小写不敏感。
- `tests/claude-runtime-signal.test.ts` 真实 spawn `claude-runtime-signal.ps1`：能在 stdin
  有 hook 载荷时正常写出 `{event, signaledAt}`、载荷内容不泄漏进文件、目录不存在时自建、
  再次触发时时间戳前进（否则主进程会把旧信号当成新信号）、成功后不留 `.tmp`。
- `tests/update-actions.test.ts` 覆盖更新入口状态机：首次未检查、软件未安装、已是最新版和
  软件/插件混合更新四类状态不能互相误显。
- `tests/async-refresh-cache.test.ts` 与 `tests/background-task-coordinator.test.ts` 覆盖
  同键合并、TTL、失败重试、旧请求不覆盖新状态、两个并发槽和交互任务优先级；
  `tests/claude-connection-test.test.ts` 额外锁定响应体 64 KiB 读取上限。
- `tests/claude-connection-history.test.ts` 用可逆的假 `safeStorage` 替身覆盖接入历史：
  重复保存不新增、任一字段（含凭据和 helper 策略）变化就新增、只有网关状态变化不新增、
  旧记录缺少策略时使用安全默认值、明文密钥不得出现在磁盘文件里、恢复出的配置可直接用于
  保存、删除后再恢复报「已被删除」、Windows 路径大小写不敏感、条数上限、文件损坏后回落
  到空列表。
- `tests/claude-providers.test.ts` 锁定目录 ID 唯一、分组完整、远程 HTTPS/本机 HTTP 边界、
  模型字符规则、外链可解析、上次官方/国内/自定义选择只展开对应组及
  Kimi/SiliconFlow/Ollama 特例；
  `tests/claude-connection-remedy.test.ts` 覆盖认证、路径、模型、环境和 Router 修复动作。
- `npm run test:layout` 使用隐藏 Electron 窗口在 820×640、900×640、1180×760 三种尺寸
  轮换项目/对话/接入、插件的已安装/可安装/市场三个面板、工作台三页、收起控制栏和全局设置
  两个分类，共 36 个场景；检查交互控件矩形相交、`elementFromPoint` 命中对象、关键容器
  横向溢出和文档级 overflow。扫描会识别滚动裁剪祖先，避免把模态内容区外不可见的控件误判
  为覆盖固定底栏；遮罩层与抽屉的有意叠放不计为控件重叠。此外单独断言输入框不被底栏或
  已打开的工作台抽屉覆盖——两者都不是可聚焦控件，通用相交扫描发现不了。插件页额外注入
  超长插件名、市场名、仓库 URL 与多按钮操作区，把内容最小宽度导致的遮挡变成 820px 下的
  可复现失败。
- `npm run test:visual` 在本地生成 820px 插件页、1180px 单组展开服务商向导、1180px 历史
  配置组件、1180px 全局设置两个分类、独立对话、终端聚焦态与重命名弹窗 PNG 到
  `dist/visual-qa/`，用于
  人工核对主题选择器、窄宽响应式、服务商卡片、认证设置、聚焦微光、历史参数和弹窗层级；
  隐藏窗口截图会先丢弃一次未稳定合成帧，图片属于构建产物。
- NSIS 的 `installerLanguages` 固定为 `zh_CN`，安装向导不会随系统语言退回英文。
- `npm run build`：生成图标、编译主进程并构建渲染资源。
- `npm run dist`：构建 Windows x64 NSIS 安装包；Electron Builder 的 `directories.output`
  固定为 `outputs/`，安装程序、Blockmap、更新元数据和解包产物均直接写入该目录，不再执行
  二次复制或向项目根目录发布。
- 发布版本结合 SemVer 与项目发布尺度，且每轮完成的项目修改都必须产生新版本：不兼容或
  架构级 API/数据/交互变更升主版本，有明确发布价值的成组/重大新功能升次版本，小功能优化、
  修复、文档、构建与维护改动升修订版本；避免因单个细小行为变化机械升次版本。版本必须同时
  写入 `package.json` 与 `package-lock.json`；完成验证后必须运行 `npm run dist`，并核对
  `outputs/ClaudeDock-Setup-<version>-x64.exe`、对应 blockmap、`latest.yml` 与
  `win-unpacked/`。这些发布产物仍不纳入 Git。
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
- Electron `app.setLoginItemSettings`：
  <https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows>
- Microsoft Windows 应用设置设计指南：
  <https://learn.microsoft.com/en-us/windows/apps/design/app-settings/guidelines-for-app-settings>
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
- Electron Windows 原生 JavaScript 对话框关闭后的输入焦点问题：
  <https://github.com/electron/electron/issues/19977>
- Electron 对该焦点问题的当前修复：
  <https://github.com/electron/electron/pull/50770>
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
