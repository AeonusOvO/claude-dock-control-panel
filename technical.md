# ClaudeDock 技术说明

## 技术栈

- Electron 43：桌面窗口、系统托盘、目录选择与进程生命周期。
- TypeScript 6、Vite 8：主进程编译和渲染资源构建。
- `@lydell/node-pty` 1.2 beta：通过 Windows ConPTY 创建真实伪终端，并提供按平台预编译
  原生模块。
- xterm.js 6 + `@xterm/addon-unicode11` + `@xterm/addon-webgl`：终端渲染、键盘输入与中文
  宽字符计算；WebGL 渲染器负责大量输出时的绘制性能，丢失上下文时回退 DOM 渲染器。
- `@fontsource-variable/hanken-grotesk`、`newsreader`、`roboto`、`inter`：把四套主题需要的
  正文与标题字体随应用离线打包，全部为可变字重、无外部请求。
- `marked`（只使用 lexer token）、Shiki core + 精细语言包、KaTeX：安全 Markdown DOM、
  主题化代码高亮与公式；Shiki 的 Oniguruma WASM 和九种语法按 chunk 延迟加载。
- d3、Plotly、Mermaid、KaTeX：由 `claudedock-artifact://libs/` 作为 Artifact 离线资源提供，
  不注入宿主页面。
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
        ├── AgentRuntimeStore ── 项目路径 → Claude Code / Codex 选择
        ├── ClaudeRuntime ── 版本门禁 / 临时 settings / statusLine 指标
        │        ├── ClaudeConfigStore ── safeStorage / 项目级接入配置
        │        └── ClaudeConnectionHistoryStore ── version 2 名称 / 协议 / 加密回放
        ├── CodexRuntime ─┬─ 官方 CLI 检测 / 工作区沙箱 TUI 启动
        │                 ├─ CodexInstaller ── GitHub Release / size + SHA-256
        │                 └─ CodexAppServer ── JSONL / ChatGPT 登录与账号额度
        ├── ClaudeSessionManager ── 当前项目 JSONL 元数据 / 定向恢复与删除
        ├── ChatConfigStore ── safeStorage / 全局独立对话配置
        ├── ChatHistoryStore ── version 2 block 历史 / Token 快照 / 附件引用回收
        ├── ChatAttachmentStore ── 文件校验 / 应用数据副本 / 主进程 base64 与缩略图
        ├── ChatService ── Anthropic/OpenAI 多模态 HTTP + typed SSE / usage / 测试 / 取消
        ├── ArtifactService ── 自定义协议 / iframe CSP / 离线库 / webRequest 审计与断网
        ├── BusyRegistry ── 下载/安装/卸载/配置/代理/对话的唯一忙碌租约真值
        ├── DownloadEngine + DownloadJournal ── 续传 / 进度 / 来源、尺寸与 SHA-256 闸门
        ├── ProxyStore + XraySidecar + LeakAuditService ── DPAPI / CLI 代理 / 泄露裁决
        ├── McpManager ── 多作用域发现 / CLI 变更 / 健康检查 / 备份回滚
        ├── WorkspaceStore ── 项目列表 / 最后激活项目的原子 JSON 持久化
        ├── ClaudeGatewayDetector ── 本机端口 / 安装 / Claude 设置只读发现
        ├── ClaudeRouterManager ── CCR 3.x 本机 RPC / Provider / 网关 / 安装与卸载
        ├── CcSwitchAdapter ── 官方 MSI / 注册表只读发现 / ccswitch 深链导出
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
除 `palette`（22 个 xterm 字段）外还有 `appearance` 与 `shell`（颜色、字体、排版、动效、
形状、按压和遮罩字段），
`SHELL_CSS_VARIABLES` 是「shell 字段 → CSS 自定义属性」的映射表，是这套机制唯一的接线点：

1. `applyTerminalTheme`（`src/renderer/main.ts`）遍历映射表写
   `documentElement.style.setProperty(...)`，并设 `dataset.theme`、`dataset.appearance` 与
   原生 `colorScheme`；`styles.css` 里所有 `var(--…)` 因此一起切换字体、表面、交互层、阴影、
   语义状态色与颜色。启动时以 `announce = false` 调用一次。
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
不允许带色相的 `rgb()`/`rgba()`、`font-family` 只能是三个职责字体令牌或 `inherit`、不允许写死
`font-size`。半透明色用 `color-mix(in srgb, var(--token) n%, transparent)`。
一次性的批量替换脚本保留在 `scripts/tokenize-colors.cjs`（按 CSS 属性判角色、
alpha 令牌先合成到 `--surface-2` 再比色、打印 CIE76 色差报告，`--write` 才落盘）。

`letterSpacing: 0` 是 TUI 边框对齐的必需值。状态三色（`--ok-*` / `--warn-*` / `--bad-*`）
的语义跨主题保持一致，但浅底需要更深的文字与描边，所以实际令牌随 `appearance` 调整并逐主题
做 WCAG 对比度测试。字体也是主题人格的一部分而不是全局常量：Claude 的 `fontUi/fontDisplay`
分别是 Hanken Grotesk Variable / Newsreader Variable（Anthropic 品牌使用的 Styrene 与
Tiempos 需商业授权、不能随应用分发，这两款是最接近的可自由分发替代）；Telegram 两者都是
Roboto Variable，与其桌面客户端一致；两套深色主题使用 Inter Variable。四套字体栈都以
`'Microsoft YaHei UI'` 起头的 CJK 回退结尾，因为拉丁字体不含中文字形。Shiki 输出的字面色只
用于判别色相类别，最终写成 `--syntax-*` CSS 变量，因此已经渲染的代码也能即时换主题。

动效同样逐主题定义而不是复制：`--dur-micro`/`--dur-enter`/`--ease-enter`/`--ease-spring`/
`--ease-exit`/`--press-theme` 是主题字面量，`styles.css` 的 `:root` 再从它们派生 `--dur-1..4`、
`--ease-standard`/`--ease-decel`/`--ease-accel` 和 `--press-lg`/`--press-sm` 阶梯。因此
Telegram 的长回弹与 Claude 的柔和减速由同一批声明产生，`tests/design-tokens.test.ts` 禁止
`:root` 之外出现字面 `ms` 或 `cubic-bezier(`，防止任何组件绕过主题写死时长。

#### 标准组件套件

原生表单控件由操作系统绘制而不是我们绘制：一个 `<select>` 会在 Windows 上弹出 Segoe UI 白底
的 Win32 列表框，它读不到任何主题令牌。`src/renderer/components.ts` 因此替换这些控件的**呈现**，
但保留原生元素作为取值、校验与 `change` 事件的唯一事实来源：

- `enhanceSelect()` 把原生 `<select>` 视觉隐藏（仍可被辅助技术聚焦）留在 DOM 内，并在旁边渲染
  一个由主题令牌绘制的 trigger + `position: fixed` listbox。选择行为写回原生元素并派发真实的
  `change`/`input`，所以十余处既有的 `select.value` 读写和 `change` 监听全部不需要改动——这正是
  不做成完整自绘控件的原因，纯视觉目标不值得让整个应用面临回归风险。键盘处理挂在原生
  select 上（它才是真正持有焦点的元素）；`MutationObserver` 覆盖「代码直接赋 `value` 或重建
  `<option>`」这种不触发事件的路径。listbox 挂在 `body` 上以逃出滚动容器与弹窗，滚动/缩放时
  重新定位，trigger 消失时自动关闭。
- 透明原生 select 与 `aria-hidden` 的视觉 trigger 使用同一矩形且前者位于命中顶层，这是复合
  控件的既定分层。`scripts/layout-smoke.cjs` 只在二者属于同一 `.select` shell 时合并
  `elementFromPoint` 与矩形相交结果；不同 shell 仍按独立控件检查。烟测启动后会短暂注入两个
  故意重叠的独立按钮，要求命中偏差和相交扫描都能抓到该探针，然后才执行正式场景。
- 复选框与单选框不需要 JS：`appearance: none` 加令牌驱动的 CSS 就够，完全在样式表内实现。
- `installPressRipples()` 为主要操作按钮提供从指针位置扩散的涟漪。目标由类名而不是逐个
  `data-ripple` 标记决定（`RIPPLE_SELECTOR` 与 `styles.css` 中对应规则互为镜像），因为相当多
  按钮是运行时创建的，逐处标注必然遗漏；`data-ripple` 保留给词汇表之外的一次性控件。
  `prefers-reduced-motion` 下直接不生成涟漪节点。

交互反馈有一条地板规则：`button:active:not(:disabled)` 全局给出 `--press-sm` 缩放。此前约三十个
按钮只有 hover 甚至毫无状态，逐族补规则必然继续遗漏，所以基线放在元素本身。行状按钮（会话/
历史列表项、上下文菜单、listbox 行）与拖拽把手显式豁免：缩放会让行内文字相对相邻行错位，
而它们本就用背景色回应。全局 `transform` 需要确认不会影响 `position: fixed` 后代的包含块——
所有弹层（`.footer-menu`、两个上下文菜单、`.select__listbox`、`.toast`、`.drop-overlay`、
`.composer-send-bubble`）都是 `body` 的兄弟节点而不是按钮的子节点，因此安全。

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
- **创建与持续布局分流**：活动 xterm 的容器在 `terminal.open()` 前就带
  `project-terminal--active`。`retryTerminalFitUntilMeasured` 只在冷启动/首次可见时用带
  generation 的四帧有界重试；窗口与分隔条的持续变化走 100ms 尾沿
  `debounceTerminalFit`。拖拽期间只记 dirty，释放后一次 fit；`ResizeObserver` 对相同整数
  宽高短路。`terminal:size` 无条件回传最终尺寸，xterm 还从 `os.release()` 获得 ConPTY build
  hint，避免内部重复 reflow。
- **主题从 spawn 生效**：`TerminalWorkspace.setTheme()` 只更新后续 start/restart 使用的
  当前主题，不向运行中的 PowerShell 注入命令。`buildPowershellStartup()` 把 palette 转成
  PSReadLine 24-bit ANSI；`ClaudeRuntime` 的临时 `settings.json` 同步写 `light/dark`。
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
- **遮罩冻结视觉、不冻结输出**：`beginTerminalMask()` 复制当前 canvas；只对快照做 CSS blur，
  veil 与标签走主题 token。真实 xterm 在下层继续 `write()` 并推进输出 revision，所以权限模式
  probe 不会超时；幂等引用计数 disposer 在所有操作的 `finally` 释放。禁止使用
  `backdrop-filter` 或暂停队列。
- **输入用 `<textarea>` 而不是在 xterm 里做行编辑**：`Ctrl+A`、`Shift+←/→`、拖选、`Ctrl+Z`、
  IME 全部由浏览器免费提供且行为正确；在终端画布里模拟它们意味着自己实现一个编辑器，
  并且要和 PSReadLine 抢同一批按键。代价是终端不再是唯一输入入口，需要为 Claude Code 的
  TUI 保留直接聚焦输出区的能力。
- **主题存在主进程而不只在 `localStorage`**：原生窗口边框在第一帧就要有颜色，此时渲染进程
  还没运行，只靠 `localStorage` 一定会闪一下错色外框。

## 渲染进程与 IPC

- 渲染进程不启用 Node.js，只能调用 preload 暴露的固定方法。
- 主进程验证 IPC 发送方、会话标识、字符串长度、终端尺寸和目录是否真实存在。权限模式只接受
  六个已知取值，思考程度只接受 `CLAUDE_EFFORT_REQUESTS` 里的七个取值，模型选项 ID 只接受
  `current` 或 `history:<id>` 形态，重启入参逐字段校验；
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

### 退出确认握手

`before-quit` 是同步事件，等不了 promise，而确认框必须是渲染进程画的主题化弹窗（不能用原生
`dialog.showMessageBox`，那又会引入一个不随主题变化的系统控件）。因此退出是一次两步握手：

1. 任何退出入口（托盘菜单、Alt+F4、`Cmd/Ctrl+Q`、安装器重启）最终都到 `before-quit`。若
   `isQuitting` 这个单向闩未置位，就 `preventDefault()` 并转交 `requestQuit()`。
2. `requestQuit()` 显示窗口并发 `app:quit-requested`；渲染进程判断是否值得拦截，然后必须
   通过 `app:confirm-quit` 回答——包括否定回答，否则应用将永远关不掉。
3. 主进程只在收到 `true` 时置 `isQuitting = true` 并 `app.quit()`，第二趟才执行真正的清理。

逃生口都是必需的，缺一个要么丢失回复、要么留下关不掉的进程：窗口不存在/正在加载/已崩溃时
（`canAsk` 为假）直接退出，因为没人能回答；`quitConfirmationPending` 期间再次请求退出即强制
通过，这是渲染进程卡死时的出路。这里**故意不设超时**——pending 通常意味着弹窗正等着用户读，
定时器会在用户面前把应用关掉。`session-end`（Windows 关机/注销，是 `BaseWindow` 事件而非
`app` 事件）直接置闩：系统无论如何都会杀进程，弹窗只是推迟丢失同样的工作。单实例锁失败的
重复启动没有窗口也没有要保护的东西，立即退出。

`BusyRegistry` 是聊天之外的唯一事实来源：下载登记为 `resumable`，安装、卸载和配置写入登记为
`blocking`，释放函数幂等且所有调用点都在 `finally` 执行。它的快照同时驱动托盘 tooltip、下载
中心与退出确认；渲染进程再把正在流式生成的回复、发送中的提交和附件读取合并进退出清单。确认框
把可后台继续与中断风险分组，安全主按钮固定为最小化到托盘。运行中的终端刻意不算；确认框已被
其他确认占用时按「取消退出」处理，而不是丢掉这次请求。

### 全局设置 IPC

- `app:get-settings` 从真实运行时读取 `app.getVersion()`、Windows 登录项状态、
  `WorkspaceStore` 主题和 `AdvancedSettingsStore` 的开关；语言当前固定为唯一已提供的
  `zh-CN`。renderer 不维护版本常量。`app:get-settings`、`app:set-launch-at-login` 和
  `app:set-advanced-settings` 返回同一个 `appSettingsView()`，避免三处各拼一份视图导致漂移。
- `app:set-advanced-settings` 逐个字段校验类型，非布尔值直接抛「高级设置无效。」，不做
  truthy 转换。`AdvancedSettingsStore` 写 `userData/advanced/settings.json`（version 1，临时
  文件加 `renameSync`，权限 `0600`）；文件损坏、版本不符或字段缺失时回落到全部关闭的默认值。
  开关的语义是「修复某个中转站缺陷」，所以默认必须是关，行为正常的中转站不为用不上的修复
  付出代价。`ClaudeRuntime` 通过注入的读取函数在每次启动会话时现读，改开关不需要重启应用，
  也不影响已经运行的 PTY。
- `app:set-launch-at-login` 只接受布尔值，调用 Electron `app.setLoginItemSettings()` 后再次
  读取实际状态返回。打包版本使用 `process.execPath`；开发版本额外传入 `app.getAppPath()`，
  避免登录项只启动空 Electron。
- 主题继续复用 `ui:set-theme` 与 `WorkspaceStore.terminalTheme`，全局设置和终端工具栏只
  是两个 UI 入口。全局设置“接入”分类移动的是原高级工具的同一组 DOM 节点，仍使用原草稿
  快照与即时操作边界，没有新增第二套 Router/诊断状态。

### 3.0 共享下载、代理与 MCP 服务

- `DownloadEngine` 只接受 HTTPS、成对的 host/path 白名单、`userData` 内目标、尺寸上限与可选
  精确字节/SHA-256。它基于 Electron `DownloadItem` 计算 EMA 速度、ETA 和真实百分比；未知
  `Content-Length` 以 `-1` 表达不确定态。完成后先进入 `verifying`，只有尺寸和哈希均通过才把
  `.partial` 原子改名为最终文件；失败或取消不会留下可执行的最终路径。任务连续 45 秒没有收到
  字节会进入自动续传（最多 12 次、指数退避），并先保留磁盘前缀，避免慢线路每次从零开始。
- `src/main/github-release-routes.ts` 对受管 GitHub Release 资产构造 8 条前缀镜像加官方直连，全部
  通过 `session.defaultSession.fetch()` 做 128 KiB Range 吞吐采样，最快者才交给同一 session 的
  `DownloadItem`。CCR、Codex、CC Switch 的 GitHub API 元数据读取也注入这一 Electron fetch，因而
  继承 Windows 系统代理/PAC；不再由 Node 全局 `fetch` 绕开用户代理。恢复日志在初始 `setProxy()`
  完成后才调用 `createInterruptedDownload()`，避免代理规则刷新关闭刚恢复的连接。
- `DownloadJournal` 每秒把 URL chain、ETag、Last-Modified、长度、已收字节与开始时间原子写入
  `userData/download-journal.json`，启动时用 `createInterruptedDownload()` 恢复。损坏或越界记录
  只会被丢弃，部分文件从不当作完成产物执行。CCR、Codex、Xray 和 CC Switch 的受管资源共用
  此内核；下载的 `resumable` 租约与后续安装的 `blocking` 租约严格分离。
- `ProxyStore` 把 vmess/vless/ss/trojan 节点结构和作用域写入 `userData/proxy/`，秘密字段只以
  Electron `safeStorage` 密文保存。分享链接、Clash `proxies` 子集和 HTTPS 订阅由项目自研解析器
  处理；不引入或复制 GPL 代理实现。`XraySidecar` 只使用 MPL-2.0 的独立 Xray-core 进程，在
  `127.0.0.1` 暴露本机 HTTP 入站，运行配置为临时文件并在停止后清理。
- 传输安全是三态 `ProxySecurity`（`none` / `tls` / `reality`），不是布尔量。解析器按 v2rayN
  `VLESSFmt` + `BaseFmt.ResolveUriQuery` 的字段语义保留 `flow`、`encryption`、`fp`、`pbk`、
  `sid`、`spx`、`alpn`、`host`、`headerType` 与 `allowInsecure`，Clash 侧读取等价的
  `public-key` / `short-id` / `client-fingerprint` / `skip-cert-verify`。旧版存档在加载时按
  `tls` 布尔补全 `security`。REALITY 节点缺少公钥在 `normalizeProxyProfile` 阶段即拒绝。
- 生成配置对齐 `V2rayOutboundService.FillBoundStreamSettings`：`security` 只选择
  `realitySettings` 或 `tlsSettings` 之一，两者不同时出现（给 REALITY 节点发 `tls` 会以证书
  错误告终而不是回退）；REALITY 的空 `fingerprint` 回落到 `chrome`；XTLS `flow` 只在
  `security !== 'none'` 时写入；VLESS 的 `encryption` 缺省为字面量 `none`。
- 启动带世代号：`stop()` 自增世代并连带取消它正在等待的 Xray-core 下载，`start()` 在每个
  await 边界比对世代，因此在下载界面取消后不会有旧的启动尝试继续跑完并静默进入 `ready`。
  失败或取消的终态是 `stopped` 而非 `error`，界面据此重新提供「启动」。
- 内核引导是多源的：`src/main/proxy/xray-core-sources.ts` 维护 8 条国内前缀反代镜像加官方直连，
  镜像形态是把完整 GitHub URL（含 `https://`）拼在镜像域名之后。每条源自带成对的
  `allowedHosts` / `allowedPathPrefixes`，因为 `DownloadEngine` 逐跳校验整条重定向链；官方源必须
  同时放行 `github.com` 与 `release-assets.githubusercontent.com`。用户在面板添加的镜像域名存进
  `ProxyStoreView.extraCoreSources`，与内置源一起参与探测——这些域名 churn 极高，源表必须能不发版更新。
- 探测分两段，都用 `session.defaultSession.fetch()`（与真实下载同一条网络路径）：
  第一段 GET 同目录下 299 字节的 `.dgst`，用 `/^SHA2-256=\s*([0-9a-f]{64})$/m` 取值（该文件是四行
  `ALGO= hex`、**没有文件名字段**，不能按列切分），并要求它等于代码里固定的
  `XRAY_CORE_RELEASE.sha256`。这一段把连通性与镜像完整性合成一次请求，任何返回错误摘要的镜像当场
  出局；而 zip 的校验值始终取自代码常量，不采信镜像给的摘要，避开「同一条信道既发文件又发校验值」。
  第二段对第一段里**全部通过**的线路发 `Range: bytes=0-262143` 实测速率，3 秒或 256 KiB 先到先止；
  只有这样才能避免用摘要延迟预筛时错过真正高吞吐的镜像。
- **排序以实测速率为主键，延迟只是没测到速率时的回退**（`pickFastestSource` 的秩是
  `throughputBps ?? -latencyMs`）。这不是调优：实测中 `gh.ddlc.top` 以 789 ms 的最低延迟胜出，
  真实吞吐却只有约 13 KB/s，21 MB 的内核要下 25 分钟——只看延迟等于稳定选中一条永远下不完的线路。
  全部源都不通时 `ensureCore()` 立即抛出带线路报告的可执行文案，不让 12 次自动续传空转三分钟。
- 引导代理是用户显式配置的 `ProxyStoreView.bootstrapProxyUrl`，**默认为空即直连**，代码里不预设
  任何端口。它落在 `builtInProxyRules()` 的第三个分支：内置代理未就绪且用户配了值时返回
  `fixed_servers`，因此 `applyApplicationProxyScope()` 的签名去重照常生效，不新增竞态面。
  `proxy:detect-bootstrap-proxy` 只把 `HTTPS_PROXY` / `HTTP_PROXY` 与 `session.resolveProxy()`
  的候选**列给用户点选**，绝不自动启用——这是发布给所有用户的软件，不能按开发机的环境做假设。
- 内核可以通过 `proxy:install-core` 在未选择节点时独立安装；`XraySidecar` 用共享 Promise 合并并发
  安装请求，界面读取 `ProxyCoreView.installing` 锁定“测速”和“安装”。连同
  `proxy:probe-core-sources`、`proxy:install-core-file`（绝对路径、≤4096 字符）、
  `proxy:detect-bootstrap-proxy`；`bootstrapProxyUrl` 与 `extraCoreSources` 复用 `proxy:set-scope`
  持久化。三者结束后都广播 `proxy:state-changed`。`installCoreFromFile` 只接受 `.zip` 或
  `xray.exe`，先解到 staging 跑一次 `xray.exe version`，通过才 rename 进 `core/`——名字对但跑不起来
  的文件不能顶掉一个能用的内核。
- 解压的路径经**环境变量**传给 PowerShell，不经参数：`powershell.exe -Command <string>` 会把后面的
  参数追加到命令文本里而不填充 `$args`，所以 `Expand-Archive -LiteralPath $args[0]` 每次都栽在参数
  校验上——内核解压其实一次都没成功过，只表现为一句「退出码 1」。`$env:` 查找是按字面值代入而非
  重新解析，也顺带挡住含引号或 `;` 的路径变成第二条语句。`waitForProcess` 现在捕获并回传子进程
  stderr：把子进程自己的抱怨丢掉，正是这个 bug 能长期伪装成不透明退出码的原因。
- Xray 临时配置采用 IPv4-only：DNS `queryStrategy=UseIPv4`，选中节点 outbound 的
  `sockopt.domainStrategy=UseIPv4`，freedom 出站同样 `UseIPv4`，路由首条规则把 `::/0` 送入
  blackhole。该边界只约束 ClaudeDock 管理的隧道，不修改 Windows IPv6、DNS、路由表或系统代理。
- 本地入站健康检查会重试。Xray 在 `spawn` 返回后才绑定入站，第一次连接几乎必然 `ECONNREFUSED`；
  把它当结论会让一次正确的下载在 49 ms 内报「启动失败」——比内核解析配置还快。`probeHttpInbound`
  改为在 8 秒截止时间内每 120 ms 敲一次，只对重试改变不了的答案提前结束：真实 HTTP 状态码，
  或子进程已退出。`npm run test:xray-probe` / `npm run test:xray-install` 是这条链路的联网复现用具。
- CLI 作用域只给 ClaudeDock 启动的 Claude/Codex 子进程注入 `HTTP_PROXY` / `HTTPS_PROXY`，
  `NO_PROXY` 固定包含 `127.0.0.1,localhost,::1`。应用作用域是显式 opt-in 的 Electron session
  `setProxy()`；未启用时回落到 `mode: 'system'` 而非 `direct`——`defaultSession` 同时用于下载
  Xray-core，写 `direct` 会顶掉用户已有的系统代理并让引导过程永远停在 0%。仍然不存在系统代理
  写入模式，不调用注册表写入、`setx` 或路由表命令，也不读取/修改 Claude/Codex 桌面版配置。
  `applyApplicationProxyScope()` 以规则签名去重，避免每条运行日志都触发一次
  `closeAllConnections()` 把在途下载打断。签名必须在构造 `XraySidecar` 时就用当前规则登记为
  「已应用」：它以空串起步时，sidecar 刚进入 `starting` 就被当成规则变化，于是在
  `downloadURL()` 打开套接字之后几毫秒真的执行了一次 `setProxy` + `closeAllConnections()`，
  把 Xray-core 引导下载掐死在 0 字节，界面报「60 秒内没有收到任何数据」。`starting`、
  `stopping`、`error` 与 `stopped` 解析出的规则本就同为 `{ mode: 'system' }`，登记之后整个启动
  路径在隧道真正 `ready` 之前不会再碰 Chromium 的代理设置——下载内核本身不需要任何代理。
  `tests/proxy-environment.test.ts` 锁定这条不变量与构造处的登记调用；
  `scripts/xray-download-race-smoke.cjs` 是需要联网的复现用具。
- 隧道就绪时写入 `autoStart`，停止或启动失败时立即清除，因此下次启动能区分「代理运行中被直接
  退出」与「用户主动停止」，只对前者自动恢复。恢复动作在窗口创建后触发且不阻塞启动。
- `LeakAuditService` 并行比较直连/代理出口、ASN/机房启发式、DNS、WebRTC 和进程环境；结论与
  用户接受风险的决定写入不含节点秘密的审计记录。风险只阻断新的接入动作，已经运行的隧道保持
  运行。ASN/机房属于启发式证据，界面不得写成确定封号结论。
- `McpManager` 从 `~/.claude.json` 根级 user、项目记录 local、当前项目 `.mcp.json` project 和
  `~/.codex/config.toml` 只读发现 MCP，明确不读取 Claude Desktop 配置。在线目录以 10 秒、
  有界响应读取官方 MCP Registry preview，失败时保留离线精选；后台健康任务并发上限为 2。
- Claude MCP 安装/卸载只调用 `claude mcp add-json/remove --scope ...` 的 argv；Codex MCP 本版
  只读。项目共享启停先保存含目标路径的预览和原文件摘要，确认时若摘要变化则拒绝写入；随后
  完整备份、原子写入 `enabledMcpjsonServers` / `disabledMcpjsonServers`，失败由
  `RollbackCoordinator` 恢复。只保留最近 10 份完整备份，恢复操作逐字节复制并先保存当前状态。

### 独立模型对话

- `ChatConfigStore`（`src/main/chat-config-store.ts`）把单一独立 profile 原子写入
  `userData/claude/chat-profile.json`。renderer 只能读取协议、基址、模型、认证方式和
  `credentialConfigured`；密钥用 Electron `safeStorage` 加密，安全存储不可用时拒绝明文
  降级。该文件和项目级 `project-profiles.json` 没有共享键或联动逻辑。
- 基址校验只允许远程 HTTPS，本机 `localhost` / `127.0.0.1` / `::1` 可以使用 HTTP；拒绝
  URL 用户信息、查询和片段。模型名、凭据长度与换行、credential action 均在主进程重验。
- `ChatService`（`src/main/chat-service.ts`）只在 Electron 主进程使用 Node `fetch`。Anthropic
  协议补全 `/v1/messages`、发送 `x-api-key` 和 `anthropic-version`，并解析
  `content_block_delta`；附件块按 document/image → text 排序，本地 UUID 在发请求前才
  base64 编码，Files API 引用自动带 beta header。OpenAI 兼容协议补全
  `/v1/chat/completions`、支持 Bearer，并解析
  `choices[0].delta.content`。OpenAI 流默认请求 `stream_options.include_usage`；遇到拒绝该扩展
  的 400/422 兼容网关会自动重试一次普通流。两种协议都解析供应商 usage 并沿流事件回传；
  中转若返回非 SSE JSON，则提取对应协议的普通文本与 usage。
- 瞬时恢复使用一个跨兼容降级步骤共享的预算：首个有效模型输出前，网络失败以及
  408/409/425/429/500/502/503/504/529 最多自动重试 4 次，采用 500ms 起步、10 秒封顶的
  带抖动指数退避，并接受最长 60 秒的 `Retry-After`。typed `retrying` 事件只回传次数、等待、
  原因和可选状态码，不含请求头、正文或凭据。SSE 必须以 Anthropic `message_stop` 或 OpenAI
  `[DONE]` 正式结束；首个有效输出前的 EOF、读失败和可重试 provider error 可复用剩余预算，
  已有任何输出后则不重放非幂等请求，以避免重复扣费与重复文本，并把干净的部分回答留在历史。
- 所有消息 POST 使用 `redirect: manual`：301/302/303 因可能改写方法而拒绝，跨源 307/308 因
  可能外带认证头而拒绝，只跟随最多 3 次同源且无 URL 用户信息的 307/308。连接测试复用同一
  重定向边界。
- renderer 先调用 `chat:preflight`，再通过 `chat:start` 发起；两处都在主进程修复失效的
  旧附件并重新校验当前草稿。启动失败会回滚临时消息、保留输入与附件，不把不可发送状态写入
  历史。主进程用 `requestId → AbortController` Map 管理 `chat:stop`，不存在总时长上限。默认
  静默 5 分钟只发 `idle` 事件并用同一运行期配置做一次 15 秒旁路探活，之后约每分钟复查；它
  不会取消仍在思考或没有 SSE ping 的请求。高级设置的本地静默上限默认关闭；显式选用
  5/10/30 分钟时先提示，只在第二个阈值以 `local-timeout` 终止，并明确说明来自本地设置。
  对话 fetch 使用 Undici 的 TCP keepalive，半开连接失败后继续进入既有网络重试阶梯；
  `chat:stream` 的终止原因只有 `manual` / `local-timeout`。中途 EOF 保留部分正文并标记
  `continuable`，renderer 提供“继续生成”发起诚实的上下文续写，而不宣称流级断点续传。
  事件还支持 `retrying/thinking/input-json/refusal/stopReason`，不推送请求头或凭据。
  Anthropic 流请求 `thinking: {type:'adaptive', display:'summarized'}`，若
  400/422 不兼容则丢弃首个响应体并安全重试无 thinking 版本。每次最多 100 条消息、单个文本
  块 200,000 字符、文本合计 1,000,000 字符、响应
  2,000,000 字符；错误文案再次替换可能回显的凭据。
- `chat:test-connection` 使用当前未保存表单草稿解析运行期配置，发送最多 1-token、15 秒超时、
  64 KiB 响应上限的非流式最小请求；不会顺带保存草稿。结果包含成功状态、净化后的说明、
  延迟和供应商可用时的 usage。
- `src/shared/chat-usage.ts` 是供应商未返回 usage 时的显式回退：ASCII 约 4 字符/token，
  非 ASCII 按 1 字符/token，加上每条消息固定开销。renderer 在输入事件、发送、流式增量及
  终止事件上更新显示；估算数据使用 `source: 'estimated'` 并在 UI 标“约”，供应商数据使用
  `source: 'provider'`。
- `ChatHistoryStore`（`src/main/chat-history-store.ts`）把正文、标题、时间与 Token 快照以
  version 2 明文原子写入 `userData/claude/chat-history.json`：先写权限 `0600` 的 `.tmp`
  再重命名。1.x version 1 字符串消息在读取时规范化成 text block，只有显式 save 才升级磁盘。
  base64 禁止落进历史，未知字段和无效 source 被拒绝。最多保留最近 50 个对话、每个 100 条
  消息；对话 ID 只接受 v4 UUID。只有 `ENOENT` 视为空历史；JSON 损坏、版本未知或权限/
  读取错误会尝试保留 `chat-history.json.corrupt.bak`，随后 fail-closed 抛错，禁止保存覆盖与
  orphan GC。
  每次发送前和生成完成/停止/失败后更新历史；新对话只清空当前视图，逐条删除要经过 renderer
  的应用内危险确认。
- `ChatAttachmentStore` 把白名单普通文件原子复制到
  `userData/claude/chat-attachments/<uuid>/{payload,metadata.json}`，拒绝符号链接、目录、
  空文件、未知扩展和超限输入；`draftId` 的所有变更经主进程 mutation queue 串行，同一消息
  跨批次/并发累计最多 10 个、32 MiB，preflight/start 时还要与当前消息的本地 UUID 集合精确
  匹配。复制、读取与 base64 文件 I/O 使用异步 API；base64 编码和大 JSON 序列化的 CPU 工作
  仍在 Electron 主进程，本版未引入 worker/utility process。图片预览经
  `nativeImage.resize(240×160)` 后才跨 IPC。草稿移除立即删除未被历史引用的副本；删除会话
  和 50 条裁剪会按 retained reference set 回收附件；崩溃残留由带宽限期的
  `collectOrphans()` 维护，且历史不可读时绝不运行。
- renderer 用 `marked.lexer()` 的 token 树自行创建白名单元素，原 HTML 降级为文本；HTTP(S)/
  mailto 外链由 `markdown:open-external` 重验后交给系统浏览器。远程 Markdown 图片只显示
  隐私占位与显式外部打开按钮，不创建带远程 `src` 的 `<img>`，因此不会绕开 Artifact 审计
  自动外发；`data:` 图片仍可内嵌。Shiki 只用精细 core bundle 的 9 种语言，代码 token 映射
  到主题 CSS 变量；KaTeX 使用 `trust:false`、`strict:'error'` 和 HTML+MathML。流渲染只从
  已提交稳定边界重新 lexer 尾部并复用稳定 DOM；超过 4 KiB 的长不稳定尾部按
  `max(256, tailLength / 16)` 增长阈值动态降频，奇数个 fence 时把未闭合围栏及其尾部保持
  为不稳定，`finish()` 始终执行一次完整解析。
- 独立对话仍不读取项目文件，也不创建 PTY。历史正文没有使用 `safeStorage` 加密，因为其
  数据体量与可检索性不同于凭据；README 与界面将其明确为本机明文记录。凭据继续只存在
  `chat-profile.json` 的 Windows 安全存储密文中。
- 独立对话左栏只有一个可增长的历史区：`.rail-page--chat` 与 `.chat-history` 依次占满
  `control-panel` 剩余高度，`.chat-history__list` 取消固定 `248px` 上限并独立滚动；空列表时
  `:empty` 取消弹性占位，使说明仍靠近标题。模型配置 DOM 只存在于右上角齿轮模态窗。
- 其余 `.rail-page` 与它们的直接子块显式 `flex-shrink: 0`，由 `control-panel` 承担整页滚动。
  `control-panel` 是定高 flex 列，而 `overflow-y: auto` 的元素自动最小尺寸为 0，因此不加这条
  规则时，接入历史列表会在记录变多时第一个被压扁到几乎不可见，而不是在自己的 360px
  区域里滚动。规则用 `:not(.rail-page--chat)` 排除独立对话左栏，那里的历史区依赖 `flex: 1`
  增长。
- 活动栏点击路径在 `toggleRailTab('chat')` 完成主视图和侧栏布局后，通过
  `requestAnimationFrame` 聚焦 `#chat-input`。聚焦前重新核对主视图、`hidden`、输入框禁用、
  composer `inert`、设置模态窗和 Artifact 详情抽屉，避免导航抢走更高层界面的焦点。
- 独立对话与项目终端共用同一套 composer 契约：`.terminal-composer textarea:focus` 与
  `.chat-composer textarea:focus` 是同一条规则，发送按钮与输入框底边齐平并随其高度伸缩，
  聚焦时的一次收敛式 `composerFocusIn` 微光只引用 `--accent-ring`、`--accent-solid`、
  `--accent-tint` 以及主题时长/缓动令牌。两者曾各写一套（对话缺少聚焦动效、按钮不齐平），
  现已合并，避免同类控件在两处发散。全局 `prefers-reduced-motion` 规则仍会把动画压缩到
  `0.01ms`。
- Artifact 详情抽屉的 body 使用 `align-content: start` 和 `grid-auto-rows: max-content`，
  防止少量内容被网格默认 stretch 拉成巨块；正文按说明、网络策略、运行状态、请求审计组成
  紧凑卡片，网络开关仍是可聚焦的原生 checkbox，审计与停止逻辑没有改变。

### Artifact 隔离与联网审计

- `registerArtifactScheme()` 在 `app.whenReady()` 前只注册一次
  `claudedock-artifact`；ready 后 `ArtifactService.install()` 接管 protocol。每段 HTML 上限
  2 MiB、使用随机 `artifact-<uuid>` 内存记录，renderer 只能得到 ID 与自定义 URL。
- iframe 固定 `sandbox="allow-scripts"`，不带 `allow-same-origin`，因此是 opaque origin，
  不能访问宿主 DOM、preload、cookie 或 localStorage。主页面 CSP 只放行该 frame scheme；
  Artifact 响应有独立 CSP，允许可视化常见的 inline/eval，但禁止 object、表单提交和宿主
  导航。d3/Plotly/Mermaid/KaTeX 与 KaTeX 字体走严格 allowlist 的
  `claudedock-artifact://libs/`。
- JSON-RPC 2.0 postMessage 只实现 `claudedock/theme`、`artifact/ready` 与
  `artifact/resize`。宿主先验证 `event.source === iframe.contentWindow`，不使用始终为
  `"null"` 的 sandbox origin 做身份判断；消息最大 64 KiB，高度夹在 240–1200px。
- Electron 普通 sandbox iframe 没有独立 `Session`/partition，项目不把它宣称为独立分区。
  首次加载时把 live Artifact 绑定到 `WebContents.id + WebFrameMain.frameTreeNodeId`；该身份跨
  渲染进程导航保持稳定。`will-frame-navigate` 会拒绝离开原 Artifact host 的跳转并写入
  `NAVIGATE` 拦截日志；`session.defaultSession.webRequest` 也优先按稳定 frame 身份归因和
  断网，URL/referrer 只作为首次绑定兜底。日志最多 500 条，记录时间、方法、完整 URL、状态、
  拦截/错误和响应头可可靠提供时的 `Content-Length`；缺失时保持 `responseBytes` 未定义，
  不伪造实际下载字节数。开关原子持久化到 `artifact-settings.json`：仅文件不存在时默认
  允许，损坏/权限错误会 fail-closed，保存失败不会先改变内存策略。
- renderer 的 `ArtifactController` 只有用户点击 HTML 代码块下方按钮才创建 iframe；维护
  active ID Map，切主题向全部实例推 CSS 变量，停止时先将 frame 导向 blank 并移除，再请求
  主进程清理记录。pending create 使用取消 token；流式重绘移除 mount、`forceCleanup()` 或
  controller dispose 后，即使异步 create 稍后才返回也会立即 destroy 主进程记录。
  MutationObserver 同时清理已断开 DOM 的 active 实例。详情抽屉从
  `getArtifactNetworkState` 取快照，再用 `artifact:network-log` 增量更新。

## 项目开发引擎与 Codex

### 项目级选择

- `AgentRuntimeStore`（`src/main/agent-runtime-store.ts`）以小写规范化绝对路径为键，把
  `claude | codex` 原子写入 `userData/claude/agent-runtimes.json`，文件权限为 `0600`。
  新项目和损坏/未知版本的存储都安全回落到 `claude`；忘记项目时同步删除选择。
- renderer 只能按 session ID 请求/切换，主进程再从 `TerminalWorkspace` 取可信 cwd。同一
  项目任一 session 中有 Claude 或 Codex agent 运行时都拒绝切换，避免不同窗口绕过互斥规则。
  相同项目的多个 session 在 renderer 同步更新选择快照。
- `ControlPanelApi` 只暴露结构化 runtime、安装、登录、退出、账号状态和启动方法。preload
  不提供任意命令、任意 App Server method 或任意外链入口；主进程继续验证 sender、session、
  枚举值和登录 URL。

### 官方安装与命令解析

- `CodexInstaller` 只读取 `https://api.github.com/repos/openai/codex/releases/latest`。
  Release tag 必须匹配 `rust-v<semver>`，资产必须叫 `install.ps1`，下载地址必须位于同一
  `github.com/openai/codex/releases/download/<tag>/` 路径，且 GitHub 元数据必须提供
  `sha256:<64 hex>` 和不超过 1 MiB 的正尺寸。脚本下载后再次核对精确字节数与 SHA-256，
  再原子写入 `userData/claude/codex-installers/<version>/install.ps1`。
- 执行固定使用 Windows PowerShell `-NoProfile -NonInteractive -ExecutionPolicy Bypass
-File`，最长 15 分钟、总输出上限 2 MiB，并设置官方脚本支持的
  `CODEX_NON_INTERACTIVE=1`、`CODEX_RELEASE=<version>` 与官方 Release 下载开关。用户输入
  不进入脚本路径、参数或环境变量。
- 运行时优先定位官方独立安装路径
  `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`，否则解析 `PATH` 中的 `codex`。
  npm 自动生成的 `codex.ps1` 会在接收 pipe 时通过 `$input` 缓冲到 EOF，无法承载长连接
  JSONL；因此确认同目录存在官方 `node_modules/@openai/codex/bin/codex.js` 后，App Server
  与版本诊断改用解析到的 `node.exe + codex.js`，用户可见 TUI 仍使用原 shim。真实 Windows
  联调已覆盖 npm 安装形态。

### App Server 登录边界

- `CodexAppServerClient` 启动 `codex app-server --listen stdio://`，按行收发 JSONL。连接先
  发送 `initialize`，成功后发送 `initialized`；请求 ID 单调增长，单请求 20 秒超时，单行
  上限 8 MiB，stderr 只保留末尾 4,000 字符并在错误进入 UI 前净化。
- 只调用官方账号方法：`account/read`、`account/rateLimits/read`、
  `account/login/start`、`account/login/cancel` 和 `account/logout`。浏览器方式接受
  `auth.openai.com` / `chatgpt.com` HTTPS URL；设备码方式额外显示 `userCode`。登录完成与
  额度更新通过通知推送，账号缓存失效后重新读取。
- `parseCodexAccountRead` 只映射 `type`、`email`、`planType` 与
  `requiresOpenaiAuth`，其他字段（包括未来可能出现的 token 字段）默认丢弃。OAuth 凭据的
  保存、刷新和退出均由官方 Codex 实现；项目不读写 `~/.codex/auth.json` 或
  `~/.codex/config.toml`。
- App Server 当前仍标记为 experimental，因此首版只依赖稳定、可回退的账号状态面，不把
  完整任务执行绑死在协议上。账号读取失败会形成 warning；已安装 CLI 仍可在终端中按官方
  行为人工登录和使用。

### Codex 会话启动

- `CodexRuntime.prepareLaunch()` 构造 PowerShell 单引号转义命令，固定包含
  `--cd <cwd> --sandbox workspace-write --ask-for-approval on-request --no-alt-screen`。
  新建直接运行 `codex`，继续最近使用 `codex resume --last`，选择历史使用 `codex resume`。
  不提供 `danger-full-access` 或 `never` 审批快捷入口。
- 启动前要求官方 CLI 已安装；当 `requiresOpenaiAuth` 为真时还要求存在账号。主进程重启当前
  PTY 后再写入命令，使用 OSC 退出标记跨 chunk 跟踪 TUI 结束并从 renderer 输出中移除标记。
  终端停止、重启、关闭项目与应用退出都会把两类 runtime 状态一起释放。
- 浏览器登录的一键路径把待启动 session 记在 renderer 内存中；`account/login/completed`
  到达且账号刷新成功后自动启动。并发操作锁避免登录通知早于 IPC 返回时重复/漏启，失败则
  保留项目和登录状态供用户重试。

### 与 CC Switch 类能力的边界

- 调研的 `farion1231/cc-switch` 已覆盖多工具 Provider、MCP、Skills、提示词、用量和本地
  代理；这证明 ClaudeDock 后续应把“受管应用 / 安装适配器 / 扩展同步”建成能力层，而不是
  继续把所有功能堆进 Claude 路由表。
- 其 Codex OAuth → Claude 路径本质是本地反向代理与 Anthropic/OpenAI 协议转换，不会让
  Claude Code 原生获得 ChatGPT 订阅。CC Switch 自身文档也明确标记服务条款、账号与长期
  可用性风险。ClaudeDock 当前先提供官方 Codex 客户端通道，不复制 OAuth 凭据、不默认安装
  该代理、不把高风险兼容路径描述成官方集成。

## Claude Code 接入与会话

### 项目级路由

- ClaudeDock 以规范化绝对项目路径作为配置键；非敏感配置和加密凭据保存在 Electron
  `userData/claude/project-profiles.json`，不写入仓库中的 `.claude/settings*.json`。
- `ClaudeConnectionHistoryStore`（`src/main/claude-connection-history.ts`）在
  `userData/claude/connection-history.json` 按项目保存最近 20 条接入配置，写入同样是
  临时文件加 `renameSync`、权限 `0600`；文件损坏时 `load()` 回落到空存储而不是抛错。
  项目键用小写后的绝对路径，因为 Windows 路径大小写不敏感。
  Anthropic 直连凭据以 `safeStorage.encryptString(...)` 的 base64 存放；`decrypt` 在安全存储不可用时返回
  `undefined` 而不是抛错，所以恢复出来的记录顶多是“没有凭据”，不会变成明文。
- 历史文件为 version 3，每条保存可选 `name`、必填 `protocol`（`anthropic | openai |
unknown`），并可保存 OpenAI 原始上游的地址、认证、主/快速模型、凭据状态与 Router Provider
  ID。version 1/2 读取时，已知直连预设迁移为 Anthropic；旧 `gateway` 记录无法从本机 Router
  地址反推出上游协议，因此迁移为 `unknown`，下一次写操作会以 version 3 原子落盘。
- 判重用 `apiKeyHelperPolicy`、认证方式、地址、凭据、主/快速模型、预设、provider 和上游协议的
  SHA-256 指纹，与**全部**记录比较而不只是最新一条：命中就把那条记录移到最前面并刷新
  `savedAt`，`id` 与名称保持不变，因此恢复一条较早的记录不会变成一条重复记录，指向它的重命名
  或待处理引用也不会失效。空白的快速模型在写入时就归一为主模型，自动补全不能让同一份配置
  读起来像变了。指纹**刻意不含 `gatewayState`**——它描述的是保存那一刻
  机器的状态而不是用户填的配置，网关在 running/stopped 之间反复跳会把同一份配置刷成一堵墙。
  网关状态仍然逐条存下来，恢复时能看到当时的情况。
- `saveConfig` 成功后才记历史，且整个记录过程包在 try/catch 里：配置已经保存了，
  少一条历史不值得让保存失败。`applyConnectionHistory` 对 OpenAI 记录重新走协议转换准备，
  其余记录走同一个 `saveConfig`，
  所以恢复和手工保存的路径完全一致；回放对象同时携带名称和协议，不能在恢复后退化为默认
  Anthropic。保存/修复 Router Provider 并用于当前项目时，`anthropic_messages` 映射为
  `anthropic`，`openai_chat_completions` 与 `openai_responses` 都映射为 `openai`，Provider 名
  作为历史默认名称。历史条目 ID 由主进程用
  `/^history-[a-z0-9]{1,16}-[a-z0-9]{1,16}$/` 校验后才接受。
- `claude:connection-history-rename` 只接受字符串名称；存储层统一裁剪首尾空白并限制为 1–60 个
  非控制字符。它只更新目标记录的 `name`，不改协议、地址、模型或凭据。renderer 通过 preload
  暴露的窄接口调用，主进程返回刷新后的项目历史列表。
- renderer 将历史作为接入主流程组件固定在服务商选择与模型表单之间，不把它移动进全局设置
  `<dialog>`。每条恢复按钮显式渲染名称、协议/连接方式标签、`baseUrl`（接口/网关）、
  `gatewayEndpoint`（与基址不同时）、`model`、`modelFast`、认证方式、`apiKeyHelperPolicy`、
  凭据布尔值和保存时网关状态；右键菜单提供重命名/恢复/删除。列表在 360px 高度内独立滚动，
  长地址和模型名允许断行。
- Anthropic 官方接入支持 Claude Code 现有登录或 `ANTHROPIC_API_KEY`。兼容网关设置
  `ANTHROPIC_BASE_URL`，并支持 `X-Api-Key`、Bearer Token 或本机无认证三种模式。
- 接入配置分别保存 `model` 与 `modelFast`。主模型写入 `ANTHROPIC_MODEL`、
  `ANTHROPIC_CUSTOM_MODEL_OPTION`、Opus 与 Sonnet 别名；快速模型写入
  `ANTHROPIC_DEFAULT_HAIKU_MODEL` 与 `ANTHROPIC_SMALL_FAST_MODEL`。旧配置缺少快速模型时
  自动回落到主模型；启动时同时使用 `--model` 提高可观察性。
- 带 `/v1/chat/completions` 的服务是 OpenAI Chat Completions 格式，不能直接满足
  Claude Code 的 Anthropic `/v1/messages`、流式内容块和工具调用语义，必须经
  Claude Code Router、LiteLLM 或服务商自己的协议转换层。
- 自定义表单选择 OpenAI 时，`ClaudeRuntime.prepareOpenAiConnection` 规范化上游端点，以保存的
  Provider ID 或规范化端点复用 CCR Provider，写入模型和上游密钥并启动 3456 网关；项目运行
  配置只保存 Router 客户端密钥和 `Provider/Model` 路由。`ClaudeConfigStore` 另存不含秘密的
  presentation 字段，使 renderer 重开后仍显示原始上游而不是内部 3456 路由。
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
   `CCR_CLAUDE_CODE_MODEL`、`CODEXL_CLAUDE_CODE_MODEL`、Router 模型发现开关以及
   `CLAUDE_CODE_DISABLE_THINKING`、`CLAUDE_CODE_EFFORT_LEVEL`、`MAX_THINKING_TOKENS`
   清空，防止旧 CCR profile 把真实会话重新指向已停止的 `3456`，也防止父进程环境覆盖底栏
   的 thinking / effort 选择。项目级 `apiKeyHelperPolicy` 默认为
   `prefer-claudedock`：仅当认证方式是显式 API Key / Auth Token 时，在该临时高优先级 settings
   写入空 `apiKeyHelper`，让本次 ClaudeDock 会话只使用安全存储中解密后注入的凭据；`inherit`
   则不写覆盖，保留 Claude Code 自己的 helper。现有登录和无认证模式不会停用 helper。
   同一份 settings 里注册三个本地能力：statusLine 指标采集、`PostCompact`/顶层 `Stop`
   完成信号，以及 WebSearch/WebFetch 主线程路由守卫；它们只读 hook stdin、写会话目录 JSON
   或返回本地 hook 决策，不外发。
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
- `src/shared/connection-endpoint.ts` 是自定义连接地址处理的单一事实来源，renderer 失焦/切换
  协议时调用一次，主进程配置与 Router Provider 校验时再次调用。解析部分对两种协议一致：接受
  省略 scheme、单/双前导斜杠、反斜杠、`/v1` 和完整端点；远程默认 HTTPS，本机回环默认 HTTP，
  拒绝用户信息、查询参数、片段和远程 HTTP。
- 两种协议之后的处理必须分开，混用是 2.6.0 修掉的接不上问题的根因。CCR Provider 的
  `api_base_url` 要的是完整请求地址，所以 OpenAI 走 `completeConnectionEndpoint`：`/responses`
  映射为 CCR `openai_responses`，其他 OpenAI 输入补为 `/v1/chat/completions`。而
  `ANTHROPIC_BASE_URL` 是**基址**，Claude Code 自己会追加 `/v1/messages`，所以 Anthropic 走
  `normalizeConnectionBaseUrl`：中转站发布的路径原样保留（`https://host/v1` 保持
  `https://host/v1`，`/relay/v1`、`/proxy/anthropic` 同理），只有整段粘贴 `/v1/messages` 时才
  还原回它所属的基址，粘进来的 OpenAI 端点直接报错并指向协议开关。此前把 Anthropic 也补成
  `/v1/messages` 再剥掉后缀，等于把 `/v1` 从基址里抹掉，按 `/v1` 发布的中转站因此在别的软件能
  连、在 ClaudeDock 连不上。
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

### 3.0 路由决策与 CC Switch 边界

- `src/shared/router-capabilities.ts` 为供应商目录的每个 ID 明确记录 `direct-anthropic`、
  `router-optional` 或 `router-required`、认证方式、默认模型和 `verifiedAt`。一键接入向导先展示
  决策，再按能力选择直连或 CCR；只有 OpenAI 协议转换才强制路由。DeepSeek 按 2026-08-02
  官方 Claude Code 集成指南使用 Anthropic 兼容 `authToken`、`https://api.deepseek.com/anthropic`
  与当前模型标识，供应商原始“模型不存在”等错误不再被静默快速模型降级覆盖。
- 向导阶段固定为决策、检查/安装内核、启动、写 Provider/项目配置和 1-token 连通校验；每个
  阶段通过 BusyRegistry 与下载内核暴露真实状态。CCR 的所有配置写入只能经过
  `saveConfigWithoutProfileTakeover()`，唯一 `saveConfig` 调用永久传 `applyProfile: false`，
  源码守栏测试禁止桌面 profile takeover 和系统代理写入。
- `CcSwitchAdapter` 只从官方 GitHub Release 元数据接受带尺寸与 SHA-256 的 Windows MSI，安装/
  卸载交给 `msiexec` argv。检测只查询卸载注册表、`ccswitch://` 协议和进程，不打开数据库；
  Provider 互操作只调用官方 `ccswitch://v1/import` 单向深链。清理仅限 APPDATA/LOCALAPPDATA 下
  已知 CC Switch 专属目录，路径不在牢笼内即拒绝。
- `src/shared/router-kernel.ts` 以纯状态计算 CCR 与 CC Switch 的 installed/running/conflict 真值。
  两者同时运行时界面阻断新的路由接入并要求用户显式保留一个；安装、卸载、导出和残留清理均为
  可验证的显式操作，不伪造 CC Switch 不存在的管理 API，也不读写其 SQLite。

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
  单字符提示。未保存表单只在用户点击“测试并接入”时执行；当前项目的已保存配置会在
  Claude 状态首次载入、窗口从托盘隐藏态恢复，以及用户点击底栏连接按钮时执行。
- OpenAI 表单测试先创建或更新 CCR Provider 并启动本机 Router，再对最终 3456
  `/v1/messages` 路由执行同一套单令牌测试；因此测试覆盖的不只是上游 HTTP 存活，而是 Claude
  Code 实际会使用的完整协议转换路径。测试成功后 renderer 才保存项目配置。
- Bearer 对应 `Authorization: Bearer`，API Key 对应 `x-api-key`。返回非空 ID 和 `content` 数组
  即按 Anthropic Messages 兼容响应通过，不再要求服务商复制 Anthropic 的 `msg_` 编号前缀；
  明确出现 `choices` / `chat.completion` 才标记为 OpenAI，未知 200 正文不自动建议协议转换。
  `401/403` 定位为认证错误，
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
- 补救动作由 `connectionRemedyInProgress` 串行化；开始后 provider picker、配置表单和补救动作区
  全部 inert/disabled，容器设置 `aria-busy`，唯一 `finally` 恢复。Router 安装不改变当前服务商
  和未保存草稿，避免“处理中”期间配置被静默替换。
- “测试并接入”严格串行：真实测试 `ok` 后才调用保存；“跳过测试并保存”是明确的次操作。
  该按钮不用通用 `runGuarded` 包裹，因为成功路径会嵌套保存并重新渲染控件；它由
  `connectionTestInProgress` 单独防重，并在唯一 `finally` 中先清 busy 状态和原文案，再让
  `syncConnectionInteractivity` 按最新环境重算 disabled。这样成功、失败、异常和保存后的重绘
  都不会把测试前快照中的 disabled 状态永久写回。测试期间跳过 6 秒轮询并禁用服务商/配置
  控件，但不阻断导航或 PowerShell 输入。
- renderer 用 `automaticConnectionTestSessions` 按 session ID 去重：`renderClaudeState`
  在当前项目与开发引擎确认是 Claude 后调度一次已保存配置实测。主进程仅在窗口从隐藏或最小化
  状态经 `showMainWindow()` 恢复时发送 `app:window-restored`；preload 暴露受限订阅，renderer
  清除当前项目的去重标记后再调度一次。窗口一直可见时的 focus、Alt+Tab、visibility 事件不
  清除标记，避免反复消耗 token。若测试队列正忙，自动任务延后重试而不并发。
- `claude:test-connection` 在主进程重新校验输入。`provider === 'anthropic'` 时先执行
  `ProviderAccessGuard.assertAllowed('anthropic-claude', 'first-request', cwd)`，通过后才向
  官方模型接口发出最小请求；`gateway`（中转站、自定义网关和本地转换器）跳过官方服务商
  预检并直接验证自己的已保存端点。预检是额外防护，不替代真实连接测试。
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
  session ID、session name、上下文窗口、输入/输出 token、估算费用、持续时间、改动行数和
  `effort.level`。`effort` 只在当前模型带思考程度参数时出现，缺失时 `effortLevel` 写入 null，
  由渲染层回落到本次请求值，而不是伪造默认档。
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

### 运行中换模型、权限模式与思考程度

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

**思考程度只走 `/effort`，永不重启。** `src/shared/claude-effort.ts` 是唯一目录，主进程校验和
底栏菜单共用它：`auto`、`low`、`medium`、`high`、`xhigh`、`max`、`ultracode`，按推理深度升序。
`--effort` 启动标志不接受 `auto`（CLI 自己报 `Unknown --effort value 'auto' — ignoring it`），
所以 `auto` 只作为 `/effort` 的参数存在，这也是这里不复用启动标志的原因。`ClaudeRuntime.setEffort`
复用 `submitClaudeCommand` 的 per-session 队列提交 `/effort <level>`，与换模型同一套「正文 →
40ms → `\r`」写法；任何档位都在运行中的对话里生效，不需要新 PTY，这是它与 `dontAsk` 和跨端点
换模型的根本区别。

高档位不能靠删除选项“修复”。`setEffort` 在提交 `auto` / `xhigh` / `max` / `ultracode`
前，原子更新本会话命令行 settings（临时文件 → `renameSync`），写入
`alwaysThinkingEnabled: true`；metrics 发现继承来的 `xhigh` / `max` 时也执行同一准备。
这个 settings 文件不含凭据，不会改写用户的 `~/.claude/settings.json`。同时，受管环境清空
三个会覆盖 thinking / effort 的继承变量，避免界面显示能调、子进程却继续被父环境锁死。

**Web 研究与主推理解耦（可选，默认关闭）。** 这套机制是给「模型调到 high 以上就无法联网检索」
的缺陷中转站用的兼容开关，位于全局设置的“高级设置”页，由 `AdvancedSettingsStore`
（`userData/advanced/settings.json`，version 1，0o600 原子写）持久化，`ClaudeRuntime` 在每次
启动会话时现读一次，因此改开关不需要重启应用，也不影响已经跑起来的 PTY。关闭时
`--agents`、`--append-system-prompt` 与 `PreToolUse` 守栏一概不下发，会话就是一个原样的
Claude Code。`PostCompact` 与 `Stop` 两个运行时信号钩子不受开关影响：`Stop` 驱动
`pollTurnStopSignal` → `restoreEffortAfterCompatibilityTurn`，属于下文的 effort 400 兼容恢复
链路，与联网检索是两件事。以下描述的是开启后的行为。

`src/main/claude-web-research.ts` 为每次 Claude Code 启动提供一个
CLI-defined `claudedock-web-research` 子代理，经官方 `--agents` 传入，仅在该进程存活期间有效；
它 `model: inherit`、`effort: high`、`tools: [WebSearch, WebFetch]`，没有文件写入和再次委派能力。
`--append-system-prompt` 要求主线程在需要在线资料时先用 Agent 工具委派完整搜索任务，子代理只
返回带来源的检索结论，主线程再以用户原档位综合。这里不使用 `--agent`，因此不会替换 Claude
Code 默认系统提示；也不创建项目/用户级 agents 文件，不改变用户配置或 API 路由。

Windows PowerShell 5 在把参数对象重建为原生命令行时会移除未转义的 JSON 双引号；普通的
PowerShell 单引号只能保护 shell 解析，不能保证 `claude.exe` 最终收到的 argv。启动器因此对
`--agents` 使用专用编码：每个双引号前增加反斜杠，并按 Windows 原生 argv 规则把该引号前已有
的反斜杠成倍保留，再执行 PowerShell 单引号转义。这样 npm 安装产生的 `claude.ps1` 转发器和
直接安装的 `claude.exe` 都能收到可解析的完整 JSON；普通路径、模型和系统提示仍沿用原转义，
不会多出反斜杠。

只转义引号还不够。一旦参数里含有 `"`，PowerShell 5 就把这段字符串**原样**交给原生命令、
不再补自己的外层引号，于是 MSVCRT 的 argv 解析按空格拆分——实测下发的子代理定义会变成 75 个
参数，Claude Code 因此一直报 `Agent type 'claudedock-web-research' not found`。编码的最后一步
把 JSON 里剩余的字面空格换成 ` `：它是合法的 JSON 字符串转义，解析结果与原对象逐字节相同，
但参数里不再有可供拆分的空白。空格只会出现在 `JSON.stringify` 产生的字符串字面量内部
（输出无缩进），因此这步替换不会碰到结构字符。

这条链路是否出问题取决于具体载荷，所以 `tests/claude-configuration.test.ts` 的 argv 回归测试
直接使用实际下发的 `CLAUDEDOCK_WEB_RESEARCH_AGENTS`：此前那个自造载荷恰好能通过旧编码，测试
因此在缺陷存在时仍然是绿的。测试启动 argv 探针、重新解析 `--agents`，并断言 argv 中只有一个
参数包含代理名。验证不依赖每次新开对话手动发一条联网请求。

临时 settings 的 `PreToolUse` 只在联网检索隔离开启时写入，对 `WebSearch|WebFetch` 调用
`assets/runtime/claude-web-search-guard.ps1`。脚本解析 hook 的 `agent_type`：专用子代理内放行，
主线程直调返回 exit 2，并把“改用 `claudedock-web-research`”作为工具拒绝原因交给 Claude；hook
JSON 无法解析时 fail-open，避免脚本兼容问题把所有联网能力锁死。提示负责常规主动路由，guard
负责遗漏时的确定性守栏，两者都不尝试从 hook 内发送 `/effort`，因此没有 PTY 命令竞态。

Claude Code 仍可能在特定模型或网关组合中发送 `output_config.effort 'xhigh'/'max'`，却把
thinking 关闭。`parseClaudeEffortThinkingDisabledError` 只在最新一段 `API Error:` 同时含有
这两个条件时命中，并能跨 PTY 软换行识别；普通 401、404、连接失败或其他 400 均不进入兼容
恢复。命中后 `ClaudeEffortCompatibility` 记录被拒档位、检测时间与 `pending/recovered/failed`
状态，per-session 命令队列自动提交 `/effort high`，并记住错误前的请求档位。回退期间只开放
`low/medium/high`，renderer 提示重试；下一次顶层 `Stop` 信号到达后自动提交
`/effort <原档位>`、清除临时上限和旧错误。子代理完成产生的 Stop 带 `agent_id`，信号脚本会
忽略，不能在父任务仍处理搜索结果时提前恢复。恢复或换模型时同步清空旧 API Error 诊断片段，
避免后续普通终端输出把同一个 400 再次识别。换模型或重启 PTY 同样清除待恢复状态。

生效值与请求值必须分开存。模型不支持某档时会静默降级到它支持的最高档，`ultracode` 也只会
回报 `xhigh`，所以 `ClaudeMetrics.effortLevel`（状态行真值）优先，`ClaudeProjectState.effortRequest`
只在状态行还没刷新前顶一下；兼容恢复刚完成时则优先显示请求值 `high`，避免旧 metrics 继续
显示已失败的高档。`prepareLaunchInternal` 重启时清空 `effortRequest`，因为新 PTY 会重新读取
持久化的思考程度设置，`max` / `ultracode` 这类仅本次会话的请求不再成立。
`optionalEffortLevel` 只接受五个真实档位，`auto` 和 `ultracode` 不可能从状态行回来。

**一个重启机制，两个调用方。** 跨端点换模型和 `dontAsk` 都走 `ClaudeRuntime.relaunch()`：
可选 `/compact` → 可选 `applyConnectionHistory` → `prepareLaunch(..., 'continue', startMode)`
→ `workspace.restart` → 写入启动命令。`--continue` 恢复当前目录最近的会话，所以对话不丢；
压缩是为了切到上下文窗口更窄的模型时不溢出。

**压缩与顶层响应完成靠 hook 通知。** per-session `settings.json` 的 `PostCompact` 与 `Stop`
都执行 `assets/runtime/claude-runtime-signal.ps1`，分别原子写 `signal.json` 和 `turn-stop.json`
（`$OutputPath.$PID.tmp` → `Move-Item -Force`），内容只有 `{event, signaledAt}`，不回写 hook 载荷。
Stop 载荷含 `agent_id` 时直接退出，保证只报告主线程完成。脚本吞掉所有异常：丢一个信号最多
保留临时 high 或让压缩等到超时，不能弄坏对话。主进程在已有的 1 秒 `pollMetrics` 循环里读取
两个文件，持续消费时间戳；只有晚于本次 thinking/effort 错误的顶层 Stop 才能触发档位恢复，
旧响应留下的 Stop 不会让临时 high 立即失效。PostCompact 仍有 120 秒非阻塞超时。Windows
PowerShell 写入的 UTF-8 BOM 在 JSON 解析前统一剥掉。

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

## 官方 AI 网络预检与访问守卫

### 模块与数据流

`src/shared/provider-profiles.ts` 是版本化服务商配置源，集中维护官方端点、动作需求、支持地区、
缓存 TTL、风险阈值、隐私环境变量、版本规则和检索日期。Schema 在模块加载时校验；端点只允许
HTTPS/WSS，重复端点 ID、空来源或非法国家代码会阻止应用启动，避免静默使用损坏规则。
配置随经过构建/发布流程的应用版本更新，不接受运行时下载的无签名规则；这样牺牲即时热更新，
但避免网络中间人替换封锁策略。规则损坏时 fail-closed 并要求安装修复版本，不回退到陈旧的
隐藏常量。

主进程链路如下：

1. `NetworkPathResolver` 读取活动网卡、IPv4/IPv6 可用性、DNS 服务器、虚拟接口名称、
   Electron `session.resolveProxy()` 与 CLI 标准代理环境；不记录代理 URL、用户名或密码。
   解析结果只代表进程可见的显式代理第一跳，`DIRECT` 或缺少代理环境变量不等于公网直连。
2. `ProviderConnectivityProbe` 并行执行官方域名 DNS、Electron 无凭据 `HEAD`、CLI
   `curl.exe` HTTPS/TLS、Codex WebSocket Upgrade 和 CLI `--version`。应用请求由
   `electron-application-request.ts` 使用 Electron `ClientRequest` 的 `manual` 模式实现：
   在 `redirect` 事件内同步调用 `followRedirect()`，最多跟随 8 次，只允许 HTTPS，并将每一跳
   主机名与服务商配置中的认证/必需/端点白名单核对。401/403/405 表示端点可达而不是认证成功；
   不附带现有登录令牌、API Key，不调用模型接口正文，也不保存跳转 URL 的路径或查询参数。
3. 非增强隐私模式下，ipapi.co 与 ipwho.is 提供两路地区/ASN 情报；ipwho.is 可用时还读取
   VPN、公共代理、Tor、托管/数据中心与匿名网络辅助标签，但标签本身只产生提示。api4/api6.ipify.org
   分别补充公网 IPv4/IPv6。原始地址只存在于单次探测内存，进入结果前转换为 IPv4 `/24` 或
   IPv6 `/64`。单源、冲突或服务不可用不能形成地区封锁。
4. `RiskDecisionEngine` 把观测转换为 `allowed`、`allowed_with_notice`、`warning`、
   `degraded`、`partially_available` 或 `blocked`，同时生成按动作的 `featureAccess`。
   代理/VPN/虚拟网卡只加提示；双源一致的非支持地区、活动所需 DNS/API/CLI 路径失败、关键
   TLS/跨域重定向异常、离线、危险版本和 Claude SOCKS 路径才会阻止对应高风险动作。
5. `NetworkPreflightService` 按“服务商 + 动作 + 项目”执行 single-flight 和两分钟缓存。
   网络或设置变化通过 generation 失效旧结果；失效期间完成的旧请求不会写入缓存或历史。
6. `ProviderAccessGuard` 位于 IPC 动作前：Codex 登录/启动、官方 Claude 接入保存/历史恢复/
   启动/重启/真实连接测试、开发引擎切换和官方独立对话首次请求都必须先通过。自定义网关和
   普通本地终端不被官方服务状态误伤；它们的连接按钮和自动测试直接请求自身端点。

### 回滚与故障边界

- `RollbackCoordinator` 以逆序、幂等方式执行补偿步骤。项目开发引擎持久化失败时恢复原选择；
  Claude 保存、历史恢复和跨端点重启失败时恢复 `ClaudeConfigStore` 的加密快照。
- 访问守卫在任何配置或 PTY 变更前运行。预检失败不会把仍在运行的 Claude/Codex 会话错误标成
  inactive；只有已经尝试销毁并重启 PTY 后发生错误才进入 inactive 状态。
- WebSocket 单独失败时基础 HTTPS/CLI 功能仍为 `partially_available`，但 `cloud-task`
  动作被拒绝。未知或跳过的关键探测按 fail-closed 处理；公网情报未知只降级，不单独阻止。
- Electron 文档规定：`ClientRequest` 使用 `redirect: manual` 时，如果没有在重定向事件中
  同步执行 `followRedirect()`，请求会被取消。2.2.0 的应用探测遗漏了该调用，因而会在
  ChatGPT 可正常跳转、Codex CLI 可用时误报 `Redirect was cancelled`。2.2.1 修复事件处理，
  并把遗留同类错误降为“探测未确认”警告；非白名单跨域、HTTP 降级、TLS 或真实连接失败仍失败。
- 2.2.2 恢复预检上线前的真实路由测试职责：官方预检只在官方模型请求前增加防护，不再覆盖
  Claude 底栏的 `routeHealth`，也不再把中转站的真实测试替换成官方预检详情。
- 本实现不修改系统代理、DNS、路由表、Codex/Claude Code 配置文件或官方登录存储，也不自动
  关闭 VPN。Claude Code 官方不支持 SOCKS，因此只对 Claude CLI 的 SOCKS 环境做硬阻止。

### 链式代理与软路由判定边界

- Mihomo/Clash 的 `dialer-proxy`、Xray 的 `dialerProxy`/出站转发以及 sing-box 的路由出站，
  都能在代理内核内部继续选择下一跳；应用侧通常只能看到本机监听端口这一跳。PAC 返回的多个
  指令通常是回退顺序，也不能被当成串行链路。
- TUN、WinDivert/透明代理以及 OpenWrt 等软路由可以在系统显式代理之后或完全绕过显式代理
  设置接管流量。此时 Electron `resolveProxy()` 和 CLI 环境变量可能都显示无代理，但实际出口
  仍经过一条或多条代理链。
- 因此 ClaudeDock 不扫描或解析 Clash/Mihomo、V2Ray/Xray、sing-box 的本地配置，也不尝试从
  品牌名猜测拓扑。配置可能位于其他用户、容器、远端网关或软路由，读取它既不完整也会扩大隐私
  和权限范围。判定以“应用进程真实官方端点 + CLI 真实官方端点 + 可选出口共识”为准，路径卡
  只展示可见第一跳和可能存在的透明接管边界。

### 隐私、历史与第三方边界

- `NetworkDiagnosticsStore` 只保留 7 天、最多 40 条；写盘前再次移除 Bearer、`sk-*` 和 URL
  查询凭据。记录包含时间、服务商、掩码出口、风险、进程路径和逐项结论，不包含 cwd、完整 IP、
  请求/响应正文、OAuth Token、API Key 或代理凭据；用户可在详情弹窗立即清空。
- 增强隐私模式持久化在 `userData/network-preflight/settings.json`。开启后完全跳过 ipapi.co、
  ipwho.is 和 ipify，官方 DNS/HTTPS/TLS/CLI 探测仍运行，地区情报显示不可用但不据此封锁。
- `userData/network-preflight/history.json` 和设置文件使用 `0600` 意图、临时文件 +
  `rename` 原子替换。Windows 的最终 ACL 仍由当前用户配置和 Electron `userData` 目录继承。
- 本轮没有复制 CheckCC、CC Switch 或其他开源项目的代码、图标、文案或数据文件，也没有新增
  npm 依赖，因此无新增代码许可证归属。ipapi.co、ipwho.is 与 ipify 仅作为可关闭的远程诊断
  服务，产品文档明确列出其用途；不得把它们的返回作为唯一封锁依据。

### 维护与外部依据（核对日期 2026-07-29）

- OpenAI ChatGPT 支持地区：
  <https://help.openai.com/en/articles/7947663-chatgpt-supported-countries>
- OpenAI API 支持地区：
  <https://help.openai.com/en/articles/5347006-openai-api-supported-countries-and-territories>
- OpenAI ChatGPT/Codex 网络与 WebSocket 端点：
  <https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps>
- Anthropic API/Claude.ai 支持地区：<https://www.anthropic.com/supported-countries>
- Claude Code 企业代理、CA、必需域名和隐私流量说明：
  <https://code.claude.com/docs/en/network-config>
- Claude Code 官方安全公告：<https://github.com/anthropics/claude-code/security/advisories>
- Electron `ClientRequest` 重定向语义：
  <https://www.electronjs.org/docs/latest/api/client-request>
- Electron Chromium 网络栈与系统代理能力：<https://www.electronjs.org/docs/latest/api/net>
- Mihomo 链式代理 `dialer-proxy` 与已弃用 Relay：
  <https://wiki.metacubex.one/en/config/proxies/>、
  <https://wiki.metacubex.one/config/proxy-groups/relay/>
- Xray 出站转发与 `dialerProxy`：
  <https://xtls.github.io/en/config/outbound.html>、
  <https://xtls.github.io/en/config/transports/sockopt.html>
- sing-box 路由出站与 TUN：
  <https://sing-box.sagernet.org/configuration/route/rule_action/>、
  <https://sing-box.sagernet.org/configuration/inbound/tun/>
- 公开出口诊断服务：<https://ipapi.co/>、<https://ipwho.is/>、<https://www.ipify.org/>

维护服务商规则时必须同步更新 `updatedAt` / `sources[].retrievedAt`、相关测试和本节；支持地区
发生变化时不能只改界面文案。媒体披露规则与官方安全公告必须保留独立 source，不能把媒体信息
伪装成官方产品政策。

地区情报目前只能可靠到国家/地区代码，无法判定官方列表中类似 Ukraine 特定州的细粒度例外；
对这类国家级命中只显示“官方列表包含例外”的维护限制，不能把城市级推断包装成确定结论。

## 安全策略

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- 主页面 CSP 只允许本地脚本、样式、字体和本地/data 图片；Markdown 远程图片不自动加载，
  只提供显式外部打开入口。frame 只允许 `claudedock-artifact:`，开发模式额外允许本机
  Vite 连接。Artifact 使用独立响应 CSP。
- 禁止任意页面跳转、弹窗和未授权 IPC 通道；`validateSender` 同时要求目标
  `webContents` 与 `senderFrame === mainFrame`，sandbox 子 frame 不能调用 preload IPC。
- 不保存终端输入或命令历史；项目直连密钥与 Router 客户端密钥只以 Windows `safeStorage`
  密文持久化，OpenAI 上游密钥交给本机 CCR Provider 存储；为支持历史完整恢复，用户本次新填的
  上游密钥还会以 `safeStorage` 密文进入历史，renderer 始终只接收“是否已配置”的布尔值。
  终端不会收到含密钥的文本命令。PowerShell 自身行为不在应用持久化范围内。
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
- `npm test`：运行目录/工作区、项目级开发引擎持久化、Codex 官方 Release 元数据与
  SHA-256 约束、账号/额度响应白名单、沙箱启动命令、Claude 配置与版本门禁、cURL 协议识别、Router 配置
  定向修改与秘密净化、官方安装包元数据校验、运行期 API 错误识别与路由阻断、高档 thinking
  环境清理、跨行 400 识别、WebSearch 高档子代理隔离、顶层 Stop 后原档位恢复、连接测试
  结果映射、工作区持久化、当前项目会话解析与删除边界，并在 Windows PowerShell 中用模拟
  statusLine JSON 验证指标采集脚本；同时覆盖插件目录合并、输入校验、会话标题优先级与
  `custom-title` 写入、自动标题同步与手动重命名竞态、目录选择器默认路径回退、终端主题约束、
  PowerShell 启动脚本语法和软件语义版本比较；独立对话测试额外覆盖凭据密文落盘、URL
  安全边界、未保存草稿连接测试、credential keep/clear、Token 估算、多模态协议线格式、
  typed thinking/refusal/retrying、Anthropic/OpenAI 两类 SSE usage、瞬时 HTTP/网络重试、
  严格结束标记、部分输出不重放、重定向安全与兼容回退、附件原子导入/
  UUID 引用/裁剪回收、1.x 历史迁移，以及 Markdown XSS、链接、公式、Shiki、Artifact opt-in
  和流式稳定前缀。
- 3.0 守栏补充覆盖 BusyRegistry 租约释放、下载 EMA/ETA/恢复日志/来源与完整性、退出和托盘忙态、
  四种代理导入与 Xray 生命周期、IP/DNS/WebRTC/环境泄露裁决、供应商能力矩阵、CCR CLI-only、
  CC Switch MSI/深链/清理牢笼、MCP 三作用域发现/diff/备份/逐字节还原，以及对话无总时长上限、
  静默探活和可选 `local-timeout`。`tests/cli-only-guard.test.ts` 与
  `tests/chat-timeout.test.ts` 作为跨模块源码不变量，避免未来调用点绕过局部单测。
- `tests/renderer-html.test.ts` 使用 Prettier 的严格 HTML 解析器检查渲染入口，同时验证 ID
  唯一性和 `requiredElement` 启动依赖，防止浏览器容错解析掩盖 UI 结构损坏。
- `tests/ui-localization.test.ts` 锁定 Unicode 11 所需的 `allowProposedApi` 设置，并防止已
  汉化的终端、接入与插件文案回退为英文或重新出现“英文原文”面板。
- `tests/design-tokens.test.ts` 是「全局主题真的生效」的守栏：`styles.css` 的 `:root` 之外不得
  出现 hex 字面量、带色相的 `rgb()`/`rgba()`、三个职责槽之外的 `font-family` 或写死的 `font-size`；
  每个 `SHELL_CSS_VARIABLES` 属性都必须既有 `:root` 默认值又在正文里被引用；同时按 WCAG
  相对亮度校验四套明暗主题的画布、正文、强调色与语义状态色对比度
  （`textHi`/canvas > 7，其余正文级文字 > 4.5）。
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
  1/2/3 列容器查询、全局设置分类与接入快照式取消、独立聊天导航顺序、实时草稿 Token、
  连接测试、历史保存/恢复/删除入口、Claude/Telegram 主题外观和禁止 hover 上浮，
  以及活动栏二次点击收起也作为源码/结构契约锁定。底栏三件套同样在这里锁定：连接按钮必须
  用保存配置原地测试、不得跳转
  “接入”页；当前 Claude 项目首次载入及窗口从托盘恢复时必须各自动实测一次，同一显示周期
  按 session 去重，普通 focus/visibility 不得重复消耗 token；忙态分支必须排在健康色分支
  之前（否则陈旧的路由健康会盖掉刚点下去的进度）；
  模型/模式菜单必须挂在同一套 `pointerdown` + `blur` 收拢逻辑上、900px 以下一起隐藏，六种
  权限模式必须全部出现在目录里，模型切换的 `disabled` / `aria-busy` 必须在 `finally` 中
  直接恢复，`dontAsk` 与跨端点模型必须走同一个重启函数，输入框的
  `Shift+Tab` 必须转发 CBT 序列，而模式回读必须发生在 xterm 应用屏幕差量之后；主动 probe
  还要受输出修订号屏障保护并扫描完整活动缓冲区，不能在仍有待写数据时回复旧快照。
  独立对话契约还锁定活动栏点击后的下一帧聚焦、焦点请求的禁用/模态边界、四主题强调色焦点
  动画、历史区占满侧栏并独立滚动，以及详情抽屉禁止网格拉伸的紧凑分区结构。交互反馈地板也
  在这里锁定：`.terminal-composer` 与 `.chat-composer` 的聚焦规则必须是同一条（不得再出现
  只服务对话的 `chatComposerFocusIn`），每个按钮都必须有按压响应，且任何 `scale(var(--…))`
  引用的令牌都必须真实存在——`.chat-settings-trigger` 曾引用不存在的 `--press-scale`，按压
  静默失效。同一文件还锁定 MCP 面板的两处外观契约：`.mcp-toolbar > button` 必须落在共享
  tint 按钮族的底色、过渡与悬停三条规则里（「全部刷新」正是漏掉后退回 Chromium 原生外观的
  那个），`.dialog-primary` 必须自带底色而不是只靠弹窗内的作用域规则上色；以及卡片入场只能
  由 `data-fresh` 驱动，`renderMcpCatalog` 必须比对上一次渲染的服务器键集合。
- `tests/quit-confirmation.test.ts` 固化退出握手的每一个逃生口：`before-quit` 必须在执行
  teardown 之前把未置闩的退出退回 `requestQuit()`；`canAsk` 健康检查、二次请求强制通过和
  单实例锁失败必须无条件退出；`session-end` 必须直接置闩不发问；`app:confirm-quit` 只在
  收到 `true` 时退出且两种回答都清除 pending；托盘退出必须走同一函数而不是内联 `app.quit()`；
  桥接的两个方向都必须在契约里声明。
- `tests/claude-configuration.test.ts` 覆盖启动命令的权限参数（`--permission-mode` 的引号、
  `--allow-dangerously-skip-permissions` 只在未直接以 bypass 启动时附加、关闭后两者都不出现）
  与共享 `parseClaudePermissionMode` 的六种徽标、夹带 ANSI/OSC、徽标内部被着色打断、软换行
  拆开、同一快照多次出现时取最后一次，以及未绘制徽标时返回 `undefined`；同时覆盖只有
  显式凭据 + `prefer-claudedock` 才停用继承的 `apiKeyHelper`，以及中转站基址按发布形态原样
  存下（`/v1`、`/relay/v1`、`/proxy/anthropic` 都不被抹掉）；同时锁定会话级 `--agents`、
  `--append-system-prompt` 与 WebSearch guard 命令的 PowerShell 引号，反过来也断言联网检索
  隔离关闭时这三样都不出现、命令仍是一个原样的 `& claude`，并在 Windows 上把完整
  启动命令交给真实 `powershell.exe` 和 argv 探针，确认包含反斜杠与嵌套引号的 agents JSON
  到达原生进程后仍可解析且内容不变。这条 Windows 用例按载荷参数化，第一组就是实际下发的
  `CLAUDEDOCK_WEB_RESEARCH_AGENTS`：旧的自造夹具恰好躲过了 PowerShell 5 的拆分，而真实定义
  会被切成 75 段，因此除了 JSON 往返还断言 argv 里只出现一个含 `claudedock-web-research`
  的条目。
- `tests/advanced-settings-store.test.ts` 锁定高级设置默认全关、开关往返持久化并以 version 1
  落盘、非布尔值被拒，以及文件损坏/版本不符/字段缺失时回落到默认值。
- `tests/connection-endpoint.test.ts` 分开覆盖两条路径：`completeConnectionEndpoint` 补出完整
  请求地址，`normalizeConnectionBaseUrl` 保留中转站发布的基址路径、只把整段 `/v1/messages`
  还原回基址、把粘进来的 OpenAI 端点指向协议开关，两者共用同一套不安全输入拒绝规则。
- `tests/claude-runtime-diagnostics.test.ts` 额外按 PTY 分块喂入徽标（跨 chunk 边界、
  4,000 字符滚动缓冲已经把旧徽标挤出去的情况），并用真实形状的光标差量确认残片不会被误当
  完整徽标；闭环源码契约还覆盖官方真实连接测试先经过访问守卫、隐藏窗口恢复事件只从
  main 经 preload 受限转发，以及首次按键前主动取样、单步失败即停止、已访问模式绕环检测、
  xterm 双向 probe 回报入口、per-session 互斥锁、切不到时报明确文案、`dontAsk` 与未预置的
  `bypassPermissions` 一律拒绝、模型选项在主进程重新核对、模型/压缩/命令页不再拼接尾随
  回车而是进入 per-session 提交队列、PostCompact/顶层 Stop 信号只在已有 metrics 轮询里读且
  只认未消费时间戳，以及 WebSearch/WebFetch 必须绑定专用 high 子代理。
- `tests/claude-config-store.test.ts` 覆盖 `allowBypassPermissions` 与 `apiKeyHelperPolicy`
  的持久化：权限默认开启、认证来源默认 ClaudeDock 单一凭据、单独写入不动凭据、保存接入
  配置不会静默重置、没有配置过路由的项目也能记住、重开 store 后仍在且 Windows 路径
  大小写不敏感。
- `tests/claude-runtime-signal.test.ts` 真实 spawn `claude-runtime-signal.ps1`：能在 stdin
  有 hook 载荷时正常写出 `{event, signaledAt}`、载荷内容不泄漏进文件、目录不存在时自建、
  再次触发时时间戳前进（否则主进程会把旧信号当成新信号）、成功后不留 `.tmp`，并确认
  顶层 Stop 会写信号而带 `agent_id` 的子代理 Stop 被忽略。
- `tests/claude-web-research.test.ts` 锁定搜索子代理继承当前模型、固定 high、只开放
  WebSearch/WebFetch，以及主线程委派规则不改变原 effort；
  `tests/claude-web-search-guard.test.ts` 真实 spawn PowerShell guard，验证主线程直搜被拒、专用
  子代理放行和畸形 hook JSON fail-open。
- `tests/claude-statusline.test.ts` 真实 spawn `powershell.exe` 验证状态行 JSON；Windows runner
  首次冷启动/安全扫描可超过 10 秒，因此每个子进程使用 30 秒硬超时、测试使用 45 秒上限，
  既容纳冷启动又防止脚本挂死拖住 CI。
- `tests/update-actions.test.ts` 覆盖更新入口状态机：首次未检查、软件未安装、已是最新版和
  软件/插件混合更新四类状态不能互相误显。
- `tests/download-contracts.test.ts` 锁定下载 IPC 三件套（列表、命令、变更订阅）跨进程连通、
  每个改动前都校验发送方与任务 ID、CCR 与 Codex 都走共享的校验下载内核，以及下载中心的
  进度呈现：不确定态只属于仍在推进的任务，`cancelled` / `completed` / `failed` 必须立刻停下
  转圈动画——`percent` 在服务端没给长度时一直是 `-1`，只看这个数字会让失败的下载永远转下去。
- `tests/async-refresh-cache.test.ts` 与 `tests/background-task-coordinator.test.ts` 覆盖
  同键合并、TTL、失败重试、旧请求不覆盖新状态、两个并发槽和交互任务优先级；
  `tests/claude-connection-test.test.ts` 额外锁定响应体 64 KiB 读取上限。
- `tests/claude-connection-history.test.ts` 用可逆的假 `safeStorage` 替身覆盖接入历史：
  重复保存不新增、任一字段（含凭据、helper 策略和协议）变化就新增、只有网关状态变化不新增、
  重放一条较早的记录把它移回最前面而不是新增一条、留空的快速模型在回放时不被当成改动、
  version 1 记录迁移为安全策略与可解释协议、OpenAI 原始上游字段与 Router ID 可回放、重命名校验与持久化、
  明文密钥不得出现在磁盘文件里、恢复出的配置可直接用于保存、删除后再恢复报「已被删除」、
  Windows 路径大小写不敏感、条数上限、文件损坏后回落到空列表。
- `tests/claude-providers.test.ts` 锁定目录 ID 唯一、分组完整、远程 HTTPS/本机 HTTP 边界、
  模型字符规则、外链可解析、上次官方/国内/自定义选择只展开对应组及
  Kimi/SiliconFlow/Ollama 特例；
  `tests/claude-connection-remedy.test.ts` 覆盖认证、路径、模型、环境和 Router 修复动作。
- `npm run test:layout` 使用隐藏 Electron 窗口在 820×640、900×640、1180×760 三种尺寸
  轮换项目/对话/接入、插件的已安装/可安装/市场三个面板、工作台三页、收起控制栏和全局设置
  两个分类，并加入富文本长内容、附件与 Artifact 抽屉压力态，共 42 个场景；检查交互控件
  矩形相交、`elementFromPoint` 命中对象、关键容器
  横向溢出和文档级 overflow。扫描会识别滚动裁剪祖先，避免把模态内容区外不可见的控件误判
  为覆盖固定底栏；同一自绘 select 的原生层/视觉层、遮罩层与抽屉的有意叠放不计为控件重叠，
  且故意叠放的独立按钮校准探针必须先被检测到。此外单独断言输入框不被底栏或
  已打开的工作台抽屉覆盖——两者都不是可聚焦控件，通用相交扫描发现不了。插件页额外注入
  超长插件名、市场名、仓库 URL 与多按钮操作区，把内容最小宽度导致的遮挡变成 820px 下的
  可复现失败；独立对话额外注入超长模型名、128K Token 数值与长标题历史，覆盖新增状态。
- `npm run test:visual` 保留插件、服务商向导、历史配置、全局设置、连接测试、终端聚焦态、
  Codex 三步工作台、代理/路由设置页与 MCP 管理页，
  独立对话详情抽屉与重命名弹窗回归图，并生成四主题 × 富文本对话/终端/终端遮罩的 12 张矩阵
  PNG，以及四主题 MCP、代理和路由截图到 `dist/visual-qa/`。富文本对话矩阵主动聚焦输入框，
  用于人工核对四主题的焦点颜色；
  其余继续核对主题结构差异、浅色终端背景与 dim 对比度、富文本、固定输入区、窄宽响应式和
  遮罩无重排。隐藏窗口截图会先丢弃一次未稳定合成帧，图片属于构建产物。
- `npm run test:conpty` 在一次性 `userData` 下加载真实工作区与 PowerShell ConPTY，输出
  24 条带序号证明行，在 820/1400/900/1280/1180px 间往返调整 BrowserWindow，并在最终
  PTY size 确认行后捕获 `dist/visual-qa/conpty-resize-live.png`。该 Windows 专用烟测补足
  静态终端 fixture 无法证明 PTY resize/reflow 的边界，结束后删除临时用户目录。
- `npm run test:control-theme` 在隐藏窗口里加载渲染入口，遍历全部按钮并读取计算样式，把
  `border-top-style: outset`（Chromium 未被覆盖的原生按钮）列成清单。源码断言只能守住已知的
  几个选择器，这条烟测才是「有没有漏网的原生控件」的全量答案，当前结果是 160 个按钮全部命中
  主题。
- `npm run test:xray-download` 运行 `scripts/xray-download-race-smoke.cjs` 的 `control` 变体，
  用真实 GitHub 资产验证默认 session 不经任何代理也能取到 Xray-core；`teardown` 变体复现修复
  前的竞态。它需要联网，不进 CI；离线守栏是上文的 `tests/proxy-environment.test.ts` 不变量。
- `npm run test:xray-probe` 运行 `scripts/xray-core-probe-smoke.cjs`，打印内置源表每条线路当前的
  通断、延迟与实测速率，并指出这次会选中哪条；带一个参数可改从引导代理探测。镜像域名 churn 极高，
  发布前和收到「所有下载线路都不可用」时都该跑一次，这是判断「源表该更新了」的唯一手段。
- `npm run test:xray-install` 运行 `scripts/xray-core-install-smoke.cjs`，在一次性 `userData` 下跑完
  探测 → 下载 → 解压 → 启动整条链路，失败时连同内核状态与最近 25 行隧道日志一起打印。它有意每次
  从零开始；只调试启动那一段时用 `KEEP_CORE=1` 复用上次下好的内核。**结束时不删临时目录**：
  Chromium 在进程存活期间仍持有句柄，删除只会得到一个 EPERM 并把真实结果埋掉，清理点在下一次启动时。
  这两条都需要联网，不进 CI；离线守栏分别是 `tests/xray-core-sources.test.ts` 与
  `tests/xray-sidecar.test.ts`。
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

`npm audit --omit=dev` 当前为 0 个生产依赖漏洞。完整审计仍会报告锁定的
electron-builder 26.15.3 依赖树中 16 个 high 构建期问题，集中在 glob/minimatch/
brace-expansion 等打包工具链；npm 建议的自动修复反而降级到 25.1.8，因此本版不采用该
破坏性变更。这些开发依赖不会进入生产 ASAR，后续应随打包器上游修复升级并重新跑完整审计。

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

- Claude 官方 MCP Apps 设计规范（明亮/深色令牌、排版层级、WCAG）：
  <https://claude.com/docs/connectors/building/mcp-apps/design-guidelines>
- Claude 官方透明主题规范：
  <https://claude.com/docs/connectors/building/mcp-apps/transparent-theming>
- Telegram Desktop 官方仓库（Open Sans 与桌面交互基线）：
  <https://github.com/telegramdesktop/tdesktop>
- Telegram Web A 主题与动效令牌实现：
  <https://github.com/Ajaxy/telegram-tt>
- Open Sans 字体源：
  <https://github.com/googlefonts/opensans>
- Fontsource 字体文件仓库：
  <https://github.com/fontsource/font-files>
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
- Codex 官方仓库、Windows 安装与 ChatGPT 登录入口：
  <https://github.com/openai/codex>
- Codex 官方 Windows 安装脚本：
  <https://github.com/openai/codex/blob/main/scripts/install/install.ps1>
- Codex App Server 协议与账号方法：
  <https://learn.chatgpt.com/docs/app-server>
- Codex 官方认证说明：
  <https://learn.chatgpt.com/docs/auth>
- CC Switch 官方开源仓库（配置管理能力与非官方代理边界）：
  <https://github.com/farion1231/cc-switch>
- CC Switch 官方 Releases 与 deep link 导入协议：
  <https://github.com/farion1231/cc-switch/releases>、
  <https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/5-faq/5.3-deeplink.md>
- MCP Registry 官方说明与 preview API 文档：
  <https://modelcontextprotocol.io/registry/about>、
  <https://registry.modelcontextprotocol.io/docs>
- Xray-core 官方仓库与 MPL-2.0 许可：
  <https://github.com/XTLS/Xray-core>
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
- Claude Code 高档 effort 与 disabled thinking 的已知兼容问题：
  <https://github.com/anthropics/claude-code/issues/76689>
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
- DeepSeek 官方 Coding Agents / Claude Code 接入指南：
  <https://api-docs.deepseek.com/guides/coding_agents/>
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
