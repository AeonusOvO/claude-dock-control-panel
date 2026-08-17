# ClaudeDock 2.0.0 — 终端接管、富文本对话、主题人格

> **历史材料 / 非当前规格**：本文按原文归档，仅用于追溯 2.0.0 阶段的规划与实施背景；
> 不代表当前产品需求、技术架构或发布门禁。当前行为以根目录 `README.md`、`design.md`、
> `technical.md`、生产代码和测试为准。

> 本文件是给实现者（Claude Code 或 Codex/ChatGPT）的**可执行规格**。每一节都给出：改哪个文件、
> 改成什么、为什么、以及怎么验证。行号基于 1.7.0 (`97f40f5`)，实现时以就近的代码特征为准。

---

## Context（为什么做这次改动）

用户报告了三个问题，根因调查已完成：

1. **PowerShell 面板仍是黑底，切到亮色主题后部分文字看不清。**
   不是一个 bug，而是四层独立缺陷叠加（详见 §1）。最关键的一条：`src/renderer/main.ts` 的
   `applyTerminalTheme` 只更新已存在终端的 `terminal.options.theme`，**从不回写模板对象
   `terminalOptions.theme`**（main.ts:542-554 / 569-598）。所以主题切换后**新建**的终端仍然用
   启动时的旧调色板出生 —— 这就是"黑底"。而"字看不清"的主因在 Claude Code CLI 自己：它有自己的
   `theme` 设置，默认按暗色渲染 dim 文字，在亮底上几乎不可见（上游 issue #49839/#49848/#40905）。

2. **缩放窗口时出现大量重复的相同文字。**
   `src/main/terminal-session.ts:103-110` 的注释已经准确诊断了机制：PSReadLine 用**绝对光标定位**
   重绘编辑缓冲区，一旦 xterm 与 ConPTY 认为的网格尺寸不一致，重绘落在错误行，旧屏幕留在原地。
   放大器有三个：`fit()` 有 18 处调用点且完全无节流；`ITerminalOptions.windowsPty` 未设置，
   xterm 退化到无 reflow 模式；ResizeObserver 不判断 `contentRect` 是否真的变了。

3. **主题（含动效）简陋，切主题只是换色。**
   根因已精确定位：`TerminalThemeShell`（terminal-themes.ts:33-75）有 **41 个字段，其中只有 1 个
   排版字段（`fontUi`），0 个动效/形状字段**。更糟的是 `LIGHT_CHROME.fontUi` 是 Open Sans
   —— Telegram Desktop 自己的字体 —— 而 `claude` 主题 `...LIGHT_CHROME`（:217），
   **Claude 主题目前字面上用 Telegram 的字体在渲染**。

用户另外要求：对话选项卡要像 Claude 官网一样渲染**最终效果**（Markdown / HTML / 可交互可视化），
并与网页版 Claude/ChatGPT **上传能力对齐**（PDF、图片、CSV、表格）。

**期望结果**：一次合并的大版本 1.7.0 → 2.0.0。终端颜色与尺寸完全由本应用掌控并可加遮罩；
对话渲染达到官网水准且可安全运行模型产出的可视化；四个主题各自具备真实的品牌人格。

### 为什么是 2.0.0（主版本）

`ChatMessage.content: string` → 内容块数组是**破坏性契约变更**（contracts.ts:54-57），
跨 preload/main/renderer 三层与磁盘历史格式。按 AGENTS.md 的 SemVer 条款属于"不兼容或架构级变更"。

---

## 全局约束（违反即视为未完成）

| 约束                                                                                                                                                                                      | 出处                                | 后果                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 不得修改 Codex / Claude Code / 系统级 API 路由                                                                                                                                            | AGENTS.md:3                         | Claude Code 的 `theme` 只能通过**本应用已经独占写入**的 per-session `settings.json` 设置（claude-runtime.ts:769-810），**绝不可**碰 `~/.claude/settings.json` |
| `styles.css` 中 `:root` 之外禁止任何字面色值 / 字体族 / 字号                                                                                                                              | tests/design-tokens.test.ts:21-46   | 新增的动效、形状、排版都必须先在 `:root` 建 token                                                                                                             |
| 每个 `SHELL_CSS_VARIABLES` 项都必须在 `:root` 有默认值，且在 `:root` 之外被 `var()` 引用至少一次                                                                                          | design-tokens.test.ts:48-54         | 加了 token 就必须真的用上                                                                                                                                     |
| 每个主题的 `textHi/text/accentText/okText/warnText/badText` 对底色的 WCAG 对比度门槛                                                                                                      | design-tokens.test.ts:78-94         | 换字体不能换掉这些色值                                                                                                                                        |
| `palette.background === shell.surfaceTerminal`                                                                                                                                            | tests/terminal-themes.test.ts:30-42 | 终端背景与外壳令牌必须同源                                                                                                                                    |
| `powershellStartup` 必须继续是可 `import` 的导出，且含四个特征字符串                                                                                                                      | tests/terminal-session.test.ts:3-11 | 见 §1.2：改成"函数 + 兼容常量"双出口                                                                                                                          |
| `renderer-interaction.test.ts:22-23` 用**字面量**断言 `const scheduleActiveTerminalFit = (): void => {` 和 `let attemptsRemaining = 4;`                                                   | 同名文件                            | §2 会改这段代码，**必须同步改断言**，不许为了让测试过而保留坏实现                                                                                             |
| `styles.css` 禁止 `backdrop-filter` 作为遮罩手段                                                                                                                                          | 见 §1.4 说明                        | 用"冻结画面 + 一次性 `filter: blur()`"替代                                                                                                                    |
| CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173` | index.html:5-8                      | 主文档 CSP **不放宽**；联网只发生在独立 origin 的 artifact iframe 内（§3.4）                                                                                  |
| 收尾必须做：`npm run lint`、`npm run typecheck`、`npm test`、`npm run build`、版本号双改、`npm run dist`                                                                                  | AGENTS.md:6,10-18                   | 见 §6                                                                                                                                                         |

---

## §1 终端：颜色与输出完全归本应用所有

### 1.1 修掉"新终端用旧调色板出生"（这才是"黑底"的真身）

`src/renderer/main.ts`

- `terminalOptions`（:542-554）改为**函数** `buildTerminalOptions(): ITerminalOptions`，每次
  `new Terminal(...)` 时按 `activeTerminalTheme` 现算调色板。或者在 `applyTerminalTheme` 内
  显式 `terminalOptions.theme = { ...definition.palette }`。**推荐前者**：消除"两份真相"。
- 同时补两个字段：
  - `minimumContrastRatio: 4.5` —— 兜底层。xterm 会对**前景色**做感知式提亮/压暗以满足比值，
    背景色不动。这是让 Claude Code 的 dim 文字在亮底可读的最后一道保险。用 4.5 而非 7：7 会把
    彩色语法高亮压成灰糊。
  - `windowsPty: { backend: 'conpty', buildNumber: <真实 Windows build> }` —— 见 §2.1。
- `applyTerminalTheme`（:569-598）：`for (const view of terminalViews.values())` 之后追加
  `view.terminal.refresh(0, view.terminal.rows - 1)`，强制重绘当前屏；否则 WebGL 渲染器可能
  保留上一主题的纹理直到下一次输出。

### 1.2 PSReadLine 语法色跟随主题（24-bit ANSI）

`src/main/terminal-session.ts:52-69`

现状是硬编码 `[ConsoleColor]::Cyan` 这类 16 色枚举名，与主题无关。
**关键事实（已验证）**：`Set-PSReadLineOption -Colors` 的值除了 `[ConsoleColor]` 之外，
也接受**原始 ANSI 转义字符串**，因此可以直接注入 24-bit 真彩：

```
Command = "$([char]0x1b)[38;2;36;108;114m"
```

改法：

```ts
// 保留测试依赖的导出名与四个特征串
export const buildPowershellStartup = (palette: TerminalThemePalette): string => {
  /* ... */
};
/** 兼容既有导入（tests/terminal-session.test.ts:3）与任何默认主题下的旧调用点。 */
export const powershellStartup = buildPowershellStartup(
  TERMINAL_THEMES[DEFAULT_TERMINAL_THEME].palette,
);
```

映射（PSReadLine token → `TerminalThemePalette` 字段）：
`Command→brightCyan`、`Parameter→brightBlack`、`Operator→magenta`、`Variable→yellow`、
`String→green`、`Number→blue`、`Type→cyan`、`Comment→brightBlack`、
`Default→foreground`、`Error→red`、`Selection` 用 `selectionBackground` 作 `48;2;` 背景。

十六进制 → `38;2;R;G;B` 的转换写在 `src/shared/terminal-themes.ts` 里作为导出工具函数
（例如 `ansiForeground(hex)` / `ansiBackground(hex)`），这样 main 与 renderer 共用一份。

**只在 spawn 时生效**：`TerminalSession.start`/`restart` 需要拿到当前主题。做法是给
`TerminalEnvironmentOverrides` 之外再传一个 `themeId`，或让 `TerminalWorkspace`
（terminal-workspace.ts:182-186 已有 `restart(sessionId, environment)` 通路）持有
"当前主题"并在 spawn 时构造启动脚本。**不要**尝试对运行中的 PowerShell 热改色 ——
那需要向用户的编辑行注入命令，会污染历史且和 Claude Code TUI 抢屏。
切主题时的正确行为：**下次启动生效**，UI 上不做任何提示（这是内部细节）。

### 1.3 Claude Code 自己的 `theme`（"字看不清"的主因）

`src/main/claude-runtime.ts:779-806`

该处已经在写一个**本应用完全拥有**的 `settings.json`，并通过
`claude-configuration.ts:316-330` 的 `--settings` 传入（CLI 会把它合并在 user/project 设置**之上**）。
在那个对象里加一个键即可：

```ts
theme: TERMINAL_THEMES[currentThemeId].appearance === 'light' ? 'light' : 'dark',
```

- **不要用 `auto`**：ConPTY 不响应 OSC 11 背景色查询，`auto` 会退化成猜测。
- 需要把当前主题 id 传进 `ClaudeRuntime`。它构造于 main.ts:1851-1870，
  `workspaceStore.getTheme()` 已经是持久化真相源（main.ts:1781 已在用）。
  加一个 setter，`app:set-theme` IPC（对应 `setAppTheme`）里一并更新。
- 生效时机同 §1.2：**下次 launch/relaunch**。

### 1.4 "正在执行操作"遮罩（切模型 / 切权限模式 / 准备操作）

需求是高斯模糊整个输出面板 + 居中文案。有三条硬性安全要求，缺一条就会引入新 bug：

1. **必须冻结画面，而不是模糊活动画布。**
   `styles.css` 禁止把 `backdrop-filter` 当遮罩手段（且它对 WebGL canvas 表现不稳）。正确做法：
   进入遮罩态时**暂停** `queueTerminalOutput` 的 rAF flush（main.ts:3963-3995 已有
   `view.pending` / `view.pendingFrame` / `view.pendingLength` 结构，直接复用），
   画面即静止；然后对 `.project-terminal` 施加一次性 `filter: blur(var(--mask-blur))`。
2. **溢出必须"中止遮罩并全量 flush"，绝不能丢块。**
   现有溢出策略是丢弃最旧的块（:3974-3980）。在遮罩期这是**致命**的：丢一块可能把一条 ANSI
   转义序列切成两半，永久损坏模拟器状态。所以遮罩期一旦 `pendingLength > MAX_PENDING_OUTPUT`，
   立即退出遮罩、把已缓冲内容**完整** `write` 出去。
3. **遮罩层必须 layout-neutral，并处理焦点。**
   遮罩元素用 `position: absolute; inset: 0` 挂在 `.terminal-stage`（styles.css:1626 已经是
   `position: relative`）**内部**，不得改变 `.project-terminal` 的盒模型 —— 否则遮罩本身触发
   §2 要修的 resize bug。同时给被遮住的容器加 `inert`，并保存/恢复 `document.activeElement`。

API 形状（renderer 内部，不需要新 IPC）：

```ts
const beginTerminalMask = (sessionId: string, label: string): () => void;
```

返回一个幂等的 dispose。接入点：`switchClaudeModel`、`setClaudePermissionMode`、
`relaunchClaudeSession`（含 `compactFirst`）三处 `await` 的前后。
必须 `try/finally`，异常路径也要解遮罩。

新增 token（`:root` + `TerminalThemeShell`）：`--mask-blur`、`--mask-veil`（遮罩底色）。

### 1.5 关于"完全截获 PowerShell"的诚实结论

**截获已经存在，且是端到端的**：每一个按键都走 `terminal:write` → `TerminalSession.write`；
每一段输出都经过 main 的 `queueTerminalOutput`（main.ts:132-170）与 renderer 的同名队列。
流已经在本应用手里，可以任意读改。

**不要移除 xterm。** Claude Code 是 Ink TUI，用备用屏 + 绝对光标定位；
`readTerminalPermissionMode`（main.ts 侧探针 + renderer:3908-3921）也依赖 xterm 的
`buffer.translateToString()` 抓权限模式徽标。自研模拟器会同时打断这两件事。
Warp / Wave / Hyper / WezTerm 全都在底层保留真实模拟器。

真正缺的只有两样，本节已覆盖：**遮罩层**（1.4）与**完整颜色所有权**（1.1–1.3）。

---

## §2 终端：缩放不再重复刷屏

### 2.1 `windowsPty`（最高优先级）

不设置 `windowsPty` 时，xterm 无法知道自己接的是 ConPTY，会关闭 Windows 专用的 reflow 处理。
在 `buildTerminalOptions()` 中传入 `{ backend: 'conpty', buildNumber: N }`。

`buildNumber` 必须是**真实的 Windows build 号**（例如 26220）。renderer 拿不到，需要：
main 侧 `Number(os.release().split('.')[2])`（Node 在 Windows 上 `os.release()` 返回
`10.0.26220`），通过已有的 `app:get-settings`（`AppSettingsView`）多带一个字段回来，
或新增一个极小的 `app:get-platform` IPC。**不要**在 renderer 里解析 UA 字符串。

### 2.2 拆开"冷启动重试"与"尺寸变化防抖"

`scheduleActiveTerminalFit`（main.ts:4035-4057）现在一个函数干两件互相冲突的事：
冷启动时需要连着 4 帧重试（等 CSS 布局与 xterm 测量收敛），而窗口拖拽时**恰恰不能**
每帧都 fit —— 那是重复刷屏的直接来源。拆成两个：

```ts
/** 冷启动 / 切会话 / 从托盘恢复：跨若干绘制帧重试，直到 fit 成功。 */
const retryTerminalFitUntilMeasured = (): void => {
  /* 保留现有 generation + attemptsRemaining 逻辑 */
};

/** 尺寸变化：合并抖动，只在稳定后 fit 一次。 */
const debounceTerminalFit = (): void => {
  /* 约 80–120ms trailing debounce */
};
```

18 处调用点按语义归类（定义在 :4000 / :4035，内部调用 :4049，
调用点 :1705, 3184, 4072, 4080, 4135, 4641, 4675, 5181, 5228, 6037, 6052, 6213, 6219, 6268, 6306）：

- **冷启动 / 可见性变化 / 切会话 / 打开面板** → `retryTerminalFitUntilMeasured`
- **`window.resize`、ResizeObserver、拖拽分隔条**（`setPanelWidth` :4072、`setDrawerWidth` :4080）
  → `debounceTerminalFit`

**拖拽期间完全抑制 fit**：`activeResizeCleanups`（main.ts:4085-4092）已经在跟踪进行中的
指针拖拽。加一个 `isDraggingLayout` 标志，`debounceTerminalFit` 在其为真时只记录"脏"，
在 `finish`（含 `lostpointercapture` 路径）时补一次。

### 2.3 ResizeObserver 短路

main.ts:6267-6270 无条件调 fit。改为记住上一次的 `contentRect.width|height`，
四舍五入后与本次相同就直接 return。ResizeObserver 会因为**任何**布局扰动触发，
包括遮罩层挂载（§1.4）。

### 2.4 `terminal:size` 必须无条件回传

`src/main/main.ts:1592-1616` 现在**只在 clamp 改变了尺寸时**才回传 `terminal:size`。
但 renderer 需要在**每一次** resize 后确认 PTY 采纳的网格，才能保证
`terminal.resize(cols, rows)` 与 ConPTY 严格一致 —— 这正是 terminal-session.ts:103-110
注释所要求的。改成总是发送。renderer 的 `onTerminalSize` 收到后若与
`terminal.cols/rows` 不同则强制 `terminal.resize(...)`。

### 2.5 `window.resize` 重复绑定

排查是否有两处 `window.addEventListener('resize', ...)` 都触发 fit（:6213/:6219 附近）。
合并为一处走 `debounceTerminalFit`。

### 2.6 必须同步修改的测试

`tests/renderer-interaction.test.ts:22-23` 断言了旧函数名与 `attemptsRemaining = 4` 字面量。
改成断言新的两个函数名与防抖的存在，例如：

```ts
expect(rendererSource).toContain('const retryTerminalFitUntilMeasured = (): void => {');
expect(rendererSource).toContain('const debounceTerminalFit = (): void => {');
expect(rendererSource).toContain('let attemptsRemaining = 4;'); // 若保留该重试计数
```

---

## §3 对话：把任意模型的输出渲染成最终形态

### 3.1 现状与唯一收敛点

`appendChatMessage`（main.ts:831-844）用 `body.textContent = content` 写纯文本并返回该元素；
流式时 `handleChatStream`（:874-879）每来一个 delta 就整串重设 `textContent`。
**整个对话渲染只有这一个收口**，改造范围可控。

`styles.css:1415-1427` 的 `.chat-message__content` 现在靠 `white-space: pre-wrap` 撑版式，
接入富文本后要改为正常流，并为 `h1-h6 / p / ul / ol / blockquote / table / pre / code / a / img`
补齐排版规则（全部走 token）。

### 3.2 Markdown → DOM（禁止 `innerHTML`）

新建 `src/renderer/markdown.ts`：

- 依赖 `marked`（只用 `marked.lexer()` 拿 token 树，**不用** `marked.parse()` —— 那会产出 HTML 字符串）。
- 自己遍历 token 树 `document.createElement` 构建 DOM。这样天然免疫 XSS，
  不需要 DOMPurify，也不违反主文档 CSP。
- **元素白名单**：`p, h1-h6, ul, ol, li, strong, em, del, code, pre, blockquote, hr, br,
table, thead, tbody, tr, th, td, a, img`。不在名单内的 token 降级为纯文本。
- `a[href]` / `img[src]`：只允许 `https:`、`http:`、`mailto:`、`data:image/`。
  链接一律 `target` 不设、点击时 `event.preventDefault()` 后走
  `window.controlPanel.openExternal(url)`（contracts.ts:634 已有）。
- 代码块高亮：用 Shiki 的 `codeToTokens()`（返回 token 数组，不是 HTML 字符串），
  按 token 造 `<span>` 并用**主题 token 的色值**着色，从而跟随应用主题。
  若打包体积成为问题，退化方案是只做等宽 + 语言标签，不做着色 —— 但先尝试 Shiki。
- 每个 `<pre>` 右上角加"复制"按钮，走已有的 `writeClipboardText`（contracts.ts:671）。

### 3.3 流式增量渲染（稳定前缀切分）

不能每个 delta 都全量重解析——会闪烁且 O(n²)。算法：

1. 维护 `activeChatReply` 全文（已存在）。
2. 每帧（rAF 合并，不是每个 delta）用 `marked.lexer()` 解析全文。
3. 把 token 列表分成**稳定前缀**与**尾部**：最后一个 token 视为不稳定，
   并且**如果全文中未闭合的 ``` 围栏数为奇数，则整个未闭合围栏及其后内容都算不稳定**。
   ——这条是关键：绝不能在围栏内部把 token 定稿，否则半个代码块会先被渲染成段落再跳变。
4. 稳定前缀只在增长时追加 DOM 节点（缓存已渲染的 token 数量）；尾部每帧重建。
5. `done` 时做一次完整重渲染定稿。

### 3.4 Artifact：模型产出的 HTML / 可交互可视化

用户明确要求：**允许联网、允许内置打包库、但必须有右上角"详细信息"审计面板可查看通信并手动断网。**

**渲染载体**：`<iframe sandbox="allow-scripts">`（**不带** `allow-same-origin`）。
不带 `allow-same-origin` 时 iframe 处于**不透明 origin**，无法访问父文档、localStorage、cookie。

**为什么需要自定义协议**：`sandbox` + `srcdoc` 在 Electron 里会继承父文档 CSP 的部分约束，
且不便于给 iframe 单独发 CSP 头。做法：

- 在 `app.whenReady()` **之前**（main.ts，`hasSingleInstanceLock` 分支之前）调用一次
  `protocol.registerSchemesAsPrivileged([{ scheme: 'claudedock-artifact',
privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])`。
  这个 API 必须在 ready 之前、且只能调用一次。
- ready 之后 `protocol.handle('claudedock-artifact', ...)`，按 artifact id 返回 HTML，
  并附带**该 iframe 专属的 CSP 响应头**（比主文档宽松：允许 `connect-src https:`、
  `script-src 'unsafe-inline' 'unsafe-eval'`，因为可视化库常需要 eval）。
- iframe 的 `src` 指向 `claudedock-artifact://<id>/index.html`。

**内置库**：把 artifact 常用的库（如 d3、plotly、mermaid、katex）作为静态资源打包，
由同一个 protocol handler 在 `claudedock-artifact://libs/...` 下提供。
这样常见可视化**不联网也能跑**，联网只是额外能力。

**必须显式 opt-in**：模型返回 `html` 代码块时**默认渲染为高亮代码**，
下方给一个"运行此可视化"按钮。用户点了才创建 iframe。不做自动执行。

**postMessage 协议**（参照 MCP Apps / SEP-1865 的做法，不必实现全部规范）：
JSON-RPC 2.0 over `postMessage`。宿主侧监听时**必须先校验 `event.source === iframe.contentWindow`**
（不透明 origin 下 `event.origin` 是 `"null"`，不可作为身份依据）。
宿主向 iframe 推送当前主题的 CSS 变量，使 artifact 视觉与应用一致。

**"详细信息"审计面板**（用户硬性要求）：
在 `.chat-toolbar`（index.html:1274-1296）右上角加按钮 `id="chat-artifact-details"`，
文案 **`详细信息`**，样式复用已有的 `workbench-trigger`（index.html:907-914）观感。
点击打开一个抽屉（复用 `claude-workbench` 的抽屉模式与 `workbench-scrim`），内容：

- 本次会话所有 artifact 发起的网络请求列表：时间、方法、完整 URL、状态、字节数。
  数据来源：main 进程给 artifact 的 `WebContents`/session 装
  `webRequest.onBeforeRequest` + `onCompleted` 监听器（按 partition 隔离），
  经新 IPC `artifact:network-log` 推给 renderer。
- 一个总开关 **"允许 artifact 联网"**。关闭时 `webRequest.onBeforeRequest` 对所有
  非 `claudedock-artifact:` 请求 `callback({ cancel: true })`。状态持久化。
- 每个 artifact 的独立"停止运行"按钮（销毁 iframe）。

### 3.5 多模态上传（与网页版 Claude / ChatGPT 对齐）

这是本次升主版本的原因。**契约迁移**：

`src/shared/contracts.ts:54-57`

```ts
export type ChatContentBlock =
  | { text: string; type: 'text' }
  | {
      mediaType: string;
      source: { data: string; type: 'base64' } | { fileId: string; type: 'file' };
      type: 'image';
    }
  | {
      fileName?: string;
      mediaType: string;
      source: { data: string; type: 'base64' } | { fileId: string; type: 'file' };
      type: 'document';
    };

export interface ChatMessage {
  /** 2.0.0：字符串形式为 1.x 历史的兼容读入路径，新写入一律用块数组。 */
  content: ChatContentBlock[] | string;
  role: ChatMessageRole;
}
```

三处校验/存储必须同步，且都要**向后兼容读入** 1.x 的纯字符串历史（读到字符串就
包装成 `[{ type: 'text', text }]`）：

- `src/main/chat-history-store.ts:46-71` —— `validateMessages` 现在硬校验
  `typeof message.content !== 'string'`（:58），并在 :65 **丢弃未知键**。改为按块校验。
  `titleFor`（:73-77）取第一条 user 消息文本，要改成拼接其中的 `text` 块。
  长度上限（`MAX_MESSAGE_LENGTH` 200k / `MAX_TOTAL_MESSAGE_LENGTH` 1M）**必须重新定义**：
  base64 附件会瞬间撑爆。建议：文本块沿用原上限；附件不入 `chat-history.json`，
  改为落盘到 `userData/claude/chat-attachments/<uuid>` 并在历史里只存路径与元数据。
- `src/main/chat-service.ts:43-56` —— `validateRequest` 同样硬校验字符串（:48-50）。
- `src/main/chat-service.ts:90-116` —— `requestBody` 需要按协议分别序列化（见下）。

**Anthropic 协议线格式（已核实）**：

- PDF（base64）：`{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":<b64>}}`
  —— **无需 beta header**；base64 **不能含换行**；document 块要放在同一条 user 消息的
  text 块**之前**；限制 **32 MB / 请求，600 页**（200k 上下文模型 100 页）。
- 图片：`{"type":"image","source":{"type":"base64","media_type":"image/png","data":<b64>}}`，
  支持 jpeg/png/gif/webp；也支持 `{"type":"url","url":...}`。
- Files API 路径（可选，用于大文件）：上传后用
  `{"source":{"type":"file","file_id":...}}`；**块类型必须匹配文件 MIME**
  （PDF/文本→`document`，图片→`image`）；beta header `files-api-2025-04-14`
  **必须同时**加在上传请求和引用它的 `messages` 请求上；单文件上限 500 MB。
- CSV / 表格 / 纯文本：当作 `document` 块，`media_type: 'text/plain'`
  （或直接把内容转成 markdown 表格放进 text 块 —— 小文件推荐后者，token 更省）。
- 可选 `citations: {enabled: true}`（无需 beta），**同一请求内全有或全无**，
  且与 `output_config.format` 互斥（同时用会 400）。

**OpenAI 协议线格式**：`content` 为数组时用
`{"type":"text","text":...}` / `{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}`。
PDF 在 OpenAI 兼容端点支持度参差 —— 上传 PDF 且协议为 `openai` 时，
UI 明确提示"当前协议可能不支持 PDF"，但仍然发送（由服务端决定）。

**流式解析强化**（chat-service.ts:235-288 的 `streamDelta`）：
现在只认 `content_block_delta` 且 `delta.text`。补上：

- 按 `delta.type` 判别 `text_delta` / `thinking_delta` / `input_json_delta`；
- `thinking_delta` 单独发一路事件，renderer 折叠展示为"思考过程"。
  注意 Anthropic 的 `thinking.display` 默认是 `"omitted"`，
  **必须显式传 `display: "summarized"`** 才有内容，否则思考块流出来是空文本、
  表现为"长时间卡住"。
- `message_delta` 携带 `stop_reason`；`stop_reason === "refusal"` 要单独提示。

**UI**：`.chat-composer`（index.html:1304-1313）加附件按钮 + 拖放区。
文件路径经 `getDroppedPath`（contracts.ts:588，已有 `webUtils` 通路）取得，
读文件与 base64 编码**在 main 进程做**（renderer 是 sandbox，且大文件不应过 IPC 两次）。
已发送的附件在消息气泡里显示为缩略图（图片）或文件卡片（PDF/CSV）。

---

## §4 主题人格：从"换色"到"换理念"

### 4.1 扩展 shell 契约（`src/shared/terminal-themes.ts`）

给 `TerminalThemeShell`（:33-75）+ `SHELL_CSS_VARIABLES`（:85-127）加下列字段。
**renderer 的 apply 循环（main.ts:574-579）已经对 `SHELL_CSS_VARIABLES` 泛型遍历，
不需要任何 per-theme 分支** —— 加字段即自动生效。

| 类别         | 字段 → CSS 变量                                                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 排版         | `fontUi → --font-ui`（已有）、`fontDisplay → --font-display`、`fontMono → --font-mono`、`lineHeightBody → --lh-body`、`letterSpacingTitle → --ls-title`、`fontWeightStrong → --fw-strong` |
| 动效         | `easeEnter → --ease-enter`、`easeExit → --ease-exit`、`easeSpring → --ease-spring`、`durEnter → --dur-enter`、`durExit → --dur-exit-theme`、`durMicro → --dur-micro`                      |
| 形状         | `radiusSm/Md/Lg/Pill → --r-theme-sm/md/lg/pill`、`radiusBubble → --r-bubble`                                                                                                              |
| 压感         | `pressScale → --press-theme`                                                                                                                                                              |
| 遮罩（§1.4） | `maskBlur → --mask-blur`、`maskVeil → --mask-veil`                                                                                                                                        |

`:root`（styles.css:96-116）已有 `--ease-standard/--ease-decel/--ease-accel/--ease-telegram`
与 `--dur-1..4` 等**全局**曲线。新的 `--ease-enter` 等是**主题级**覆盖层，
两者共存：全局值作为 `:root` 默认，主题值覆写。改造 `styles.css` 中的过渡时，
把"有人格意味"的动画（消息入场、抽屉、按钮按压、页签切换）换成主题级 token，
纯功能性的（焦点环）保留全局 token。

### 4.2 先修 Claude 主题在用 Telegram 字体这件事

`LIGHT_CHROME.fontUi`（terminal-themes.ts:159）是 Open Sans —— **Telegram Desktop 自己的字体**。
`claude`（:217）和 `telegram`（:367）都 `...LIGHT_CHROME`，所以 Claude 主题目前字面上是
Telegram 的脸。把 `fontUi` 从两个 `*_CHROME` 常量中**移出**，改为每个主题各自声明。

### 4.3 四个主题的具体人格值

**Claude**（依据 claude.ai 的视觉语言）：

- `fontUi`: 无衬线正文，`--font-display` 用**衬线**做标题（Claude 官网的标志性做法）。
  正文候选 Inter；标题候选 Source Serif 4 / Newsreader。中文回落
  `'Microsoft YaHei UI'`。用 `@fontsource-variable/*` 安装（项目已用该方案，
  见 package.json:37 与 main.ts:6 的 `import '@fontsource-variable/open-sans'`），
  自动被 Vite 打包成本地 woff2，不违反 `font-src 'self' data:`。
- 动效：舒缓、减速为主。`easeEnter: cubic-bezier(0.05, 0.7, 0.1, 1)`（现有 `--ease-decel`），
  `durEnter: 240ms`，`durMicro: 120ms`。
- 形状：偏圆。`radiusMd: 12px`、`radiusLg: 16px`、`radiusBubble: 18px`。
- 排版：`lineHeightBody: 1.7`，宽松。

**Telegram**（依据 Telegram Desktop 源码的 `anim::` 曲线）：

- `fontUi`: Open Sans（保持 —— 这本来就是它的字体）。`fontDisplay` 同 `fontUi`（TG 不用衬线）。
- 动效：`easeOutCirc = cubic-bezier(0.075, 0.82, 0.165, 1)`（TG 的招牌曲线），
  `easeSpring` 用 easeOutQuint `cubic-bezier(0.23, 1, 0.32, 1)`，
  `durEnter: 340ms`（TG 的入场偏慢且富有弹性），`durMicro: 150ms`。
- 形状：更紧。`radiusMd: 8px`、`radiusLg: 10px`、`radiusBubble: 12px`（TG 气泡的小圆角特征）。
- 排版：`lineHeightBody: 1.45`，更密集（TG 追求信息密度）。

**graphite / midnight**（暗色）：作为"中性工程"人格。
`fontUi` 保留 Segoe UI Variable，动效介于两者之间（`durEnter: 200ms`，`--ease-standard`），
形状沿用现有 `--r-*` 数值。这两个主题不追求品牌人格，追求不打扰。

### 4.4 只用 `transition`，不用 `@keyframes` 做可中断动画

**关键事实**：Telegram 的 `anim::value::start` 会从**当前值**重新起算，因此动画可中断、可重定向。
CSS `transition` 原生具备这个语义；`@keyframes` **没有** —— 中途改变会跳回起点。
`styles.css` 里已有的 `@keyframes chatMessageEnter`（:1394-1408）、`railPageEnter`
（被 renderer-interaction.test.ts 断言不含 `transform:`）这类**一次性入场**动画保留 keyframes 没问题；
但**状态切换**（hover、active、抽屉开合、页签选中）必须是 `transition`。逐条排查
`styles.css` 中的 `animation:` 用法，凡是可被用户中途打断的都改成 `transition`。

### 4.5 结构性差异用 `data-theme` / `data-appearance`

main.ts:583-584 已经在写 `document.documentElement.dataset.theme` 与 `.dataset.appearance`，
但 `styles.css` 里**一次都没用过**。对无法用单个 token 表达的差异（例如 Telegram
把头像放在气泡左侧、Claude 不放；Telegram 的消息气泡带尾巴、Claude 是卡片），
用 `[data-theme='telegram'] .chat-message { ... }` 这类选择器。
**只用于结构/布局，不用于颜色** —— 颜色必须走 token（design-tokens.test.ts 会拦）。

### 4.6 字体测试门槛需要放宽

`tests/design-tokens.test.ts:33-38` 只允许 `var(--font-ui)` / `var(--font-mono)` / `inherit`。
加入 `--font-display` 后必须把该正则改成三选一：

```ts
!/font-family:\s*(var\(--font-(ui|mono|display)\)|inherit);/.test(line);
```

并在 `design.md` 里写明为什么设计系统从两种字族变成三种（标题衬线是 Claude 人格的核心载体）。

---

## §5 改动文件清单

| 文件                                                        | 内容                                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/shared/terminal-themes.ts`                             | shell 契约 +动效/形状/排版/遮罩 token；`fontUi` 从 `*_CHROME` 移出；四主题人格值；导出 `ansiForeground/ansiBackground`                                                   |
| `src/shared/contracts.ts`                                   | `ChatContentBlock`；`ChatMessage.content` 联合类型；`ChatStreamEvent` 加 thinking/stop_reason；`AppSettingsView` 加 windows build；artifact 网络日志与开关的 API         |
| `src/main/terminal-session.ts`                              | `buildPowershellStartup(palette)` + 兼容常量 `powershellStartup`                                                                                                         |
| `src/main/terminal-workspace.ts`                            | spawn 时传当前主题                                                                                                                                                       |
| `src/main/claude-runtime.ts`                                | `settings.json` 加 `theme`；接受主题 setter                                                                                                                              |
| `src/main/chat-service.ts`                                  | 块数组校验；`requestBody` 双协议多模态序列化；`streamDelta` 支持 thinking/typed delta                                                                                    |
| `src/main/chat-history-store.ts`                            | 块数组校验 + 1.x 字符串兼容读入；附件落盘；`titleFor` 改造                                                                                                               |
| `src/main/main.ts`                                          | ready 前 `registerSchemesAsPrivileged`；ready 后 `protocol.handle`；artifact partition + `webRequest` 审计与断网；`terminal:size` 无条件回传；windows build 上报；新 IPC |
| `src/preload/preload.ts`                                    | 新 IPC 桥接（artifact 网络日志/开关、附件读取、platform）                                                                                                                |
| `src/renderer/markdown.ts`                                  | **新建** —— `marked.lexer` → DOM 白名单渲染 + Shiki 着色 + 稳定前缀流式                                                                                                  |
| `src/renderer/artifact.ts`                                  | **新建** —— iframe 生命周期、JSON-RPC postMessage、`event.source` 校验、主题变量推送                                                                                     |
| `src/renderer/main.ts`                                      | `buildTerminalOptions()`；fit 拆分与防抖；ResizeObserver 短路；`beginTerminalMask`；`appendChatMessage` 接富文本；附件 UI；"详细信息"抽屉                                |
| `src/renderer/index.html`                                   | 附件按钮/拖放区；`详细信息` 按钮 + 审计抽屉；遮罩层容器                                                                                                                  |
| `src/renderer/styles.css`                                   | `:root` 新 token 默认值；`.chat-message__content` 富文本排版；代码块；artifact 容器；遮罩；`animation:`→`transition:`；`[data-theme]` 结构差异                           |
| `tests/renderer-interaction.test.ts`                        | 同步 §2.6 的字面量断言                                                                                                                                                   |
| `tests/design-tokens.test.ts`                               | 字族白名单加 `--font-display`                                                                                                                                            |
| `tests/chat-history-store.test.ts` / `chat-service.test.ts` | 块数组用例 + 1.x 兼容读入回归用例                                                                                                                                        |
| **新增** `tests/markdown-render.test.ts`                    | 白名单、危险 URL 拒绝、流式围栏不提前定稿                                                                                                                                |
| `package.json` / `package-lock.json`                        | 版本 → `2.0.0`；新增 `marked`、`shiki`、字体、可视化库                                                                                                                   |
| `README.md` / `design.md` / `technical.md`                  | AGENTS.md:4,7 要求同步                                                                                                                                                   |

### 3.0.0 扩展文件（2026-08-02）

| 文件/目录                                                | 3.0.0 新职责                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/main/busy-registry.ts`                              | 下载、安装、卸载、配置、代理与对话的幂等忙碌租约真值                             |
| `src/main/download-engine.ts` / `download-journal.ts`    | DownloadItem 断点续传、EMA/ETA、崩溃恢复、来源/尺寸/SHA-256 完整性闸门           |
| `src/main/proxy/`                                        | 节点加密存储、自研导入、Xray sidecar、IP/DNS/WebRTC/环境泄露审计                 |
| `src/main/cc-switch-adapter.ts`                          | 官方 MSI 生命周期、注册表/进程只读检测、官方 deep link 单向导出、残留清理牢笼    |
| `src/main/mcp-manager.ts` / `src/shared/mcp-catalog.ts`  | Claude/Codex CLI MCP 发现、离线精选、官方 Registry、健康检查、定向变更与备份回滚 |
| `src/shared/router-capabilities.ts` / `router-kernel.ts` | 全供应商直连/路由能力矩阵与 CCR/CC Switch 冲突真值                               |
| `src/main/chat-service.ts` / `src/renderer/main.ts`      | 删除总时长上限、静默提示+旁路探活、TCP keepalive、可选本地静默上限与继续生成     |
| `src/renderer/index.html` / `styles.css` / `main.ts`     | 下载中心、忙碌退出、代理/路由设置与第 5 个 MCP 页；全部复用四主题 token          |
| `tests/cli-only-guard.test.ts` / `chat-timeout.test.ts`  | CLI-only 与无隐式 timeout 的跨模块源码不变量                                     |
| `scripts/visual-smoke.cjs`                               | 四主题 MCP、代理、路由截图矩阵                                                   |
| `package.json` / `package-lock.json`                     | 单次大版本升级到 `3.0.0`，安装产物仍只输出到 `outputs/`                          |

---

## §6 验证

### 6.1 自动化（每一条都必须通过）

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:layout    # scripts/layout-smoke.cjs：820/900/1180 三档宽度无遮挡
npm run test:visual    # scripts/visual-smoke.cjs：截图落到 dist/visual-qa/
```

3.0.0 在上述基线上再要求以下命令全部通过；`npm run verify` 必须无 warning：

```bash
npm run verify
npm run test:select-theme
npm run test:dialog-select
npm run test:conpty
npm run dist
```

发布前还要核对 `tests/cli-only-guard.test.ts`、`tests/chat-timeout.test.ts`、下载完整性/恢复、
泄露阻断不关隧道、路由能力矩阵和 MCP 逐字节备份还原守栏，以及
`outputs/ClaudeDock-Setup-3.0.0-x64.exe`、对应 blockmap、`latest.yml` 与 `win-unpacked/`。

### 6.2 Codex 视觉验收清单（逐条截图比对）

**扩展 `scripts/visual-smoke.cjs`**：它已经能 `executeJavaScript` 注入 fixture 并
`capturePage()`（见文件内 `captureSettledPage`）。加入：四个主题 × {对话页富文本、终端页、
遮罩态} 的截图矩阵，输出到 `dist/visual-qa/`。Codex 用视觉能力核对：

1. **主题背景**：切到 `claude` / `telegram`（亮）后，终端区域底色 = `#faf9f5` / `#ffffff`，
   **没有任何黑色**。切主题后**再新建一个对话**，新终端底色同样正确（这是 §1.1 的回归点）。
2. **文字可读**：亮色主题下 Claude Code 的 dim 文字、PSReadLine 的参数色（`brightBlack`）
   都清晰可辨，不是浅灰糊在白底上。
3. **缩放**：拖拽窗口边缘从 820px 连续拉到 1400px 再拉回，**不出现任何重复行**。
   拖动分隔条同理。这是本次最重要的行为验收。
4. **遮罩**：切换权限模式时，输出面板整体模糊 + 居中"正在执行操作"，
   **面板尺寸不变**（不出现因遮罩挂载导致的重排/重复行），结束后画面正确恢复且不丢输出。
5. **富文本**：让模型输出含标题/列表/表格/代码块/公式/链接的 Markdown，
   与 claude.ai 的渲染观感对比。代码块有语法色、有复制按钮、颜色跟随主题。
6. **Artifact**：让模型输出一段 HTML+JS 可视化。默认显示为代码 + "运行此可视化"按钮；
   点击后 iframe 内正确渲染；点右上角 **详细信息** 能看到它发起的网络请求列表；
   关闭"允许 artifact 联网"后重跑，请求被拦截且面板如实反映。
7. **多模态**：上传 PDF、PNG、CSV 各一份，气泡内显示对应缩略图/文件卡片，
   模型能正确引用其内容。重启应用后历史记录完整。
8. **1.x 历史兼容**：用 1.7.0 产生的 `chat-history.json` 启动 2.0.0，旧对话正常显示、不丢失。
9. **主题人格**：`claude` 与 `telegram` 并排截图，差异必须体现在
   **字体（含标题衬线）、圆角、气泡形状、入场时长与曲线、行高**，而不只是色相。
   动画中途打断（快速连点抽屉开关）不出现跳回起点。

### 6.3 发布（AGENTS.md:10-18，硬性）

1. `package.json` 与 `package-lock.json` 版本同时改为 `2.0.0`。
2. `npm run dist`。
3. 确认 `outputs/` 下生成：`ClaudeDock-Setup-2.0.0-x64.exe`、对应 `.blockmap`、
   `latest.yml`、`win-unpacked/`。**不得**复制到项目根目录。
4. 同步检查 `README.md`、`design.md`、`technical.md`（UI / 运行方式 / 技术实现全都变了）。
5. 最终回复必须写明 **1.7.0 → 2.0.0** 与安装包路径；打包失败必须说明原因，
   **不得把只跑了 `npm run build` 说成已发布**。

---

## §7 建议实施顺序（单一版本内的内部顺序）

虽然合并为一个版本发布，实现时按依赖排序可以随时保持可编译、可自测：

1. §1.1 + §2.1（`buildTerminalOptions` 一次到位：调色板 + `windowsPty` + 对比度）
2. §2.2–2.5（fit 拆分 / 防抖 / ResizeObserver / `terminal:size`）+ §2.6 测试同步
   → **此时先手测缩放，确认重复行消失**，再往下走
3. §1.2 + §1.3（PSReadLine 24-bit + Claude Code `theme`）
4. §4.1 + §4.2（shell 契约扩展 + 修 Claude 用 Telegram 字体）→ §4.3–4.6
5. §1.4（遮罩 —— 依赖 §2 已修好，否则遮罩自己会触发重复行）
6. §3.2 + §3.3（Markdown 渲染 + 流式）
7. §3.5（多模态契约迁移 —— 最大的一块，涉及三层 + 磁盘格式）
8. §3.4（artifact + 详细信息审计面板）
9. §6（全量验证 + 文档 + 打包）
