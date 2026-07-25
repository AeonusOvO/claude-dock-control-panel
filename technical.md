# ClaudeDock 技术说明

## 技术栈

- Electron 43：桌面窗口、系统托盘、目录选择与进程生命周期。
- TypeScript 6、Vite 8：主进程编译和渲染资源构建。
- `node-pty` 1.1：通过 Windows ConPTY 创建真实伪终端。
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
Electron Main ── TerminalSession ── node-pty ── Windows PowerShell / ConPTY
        │
        ├── Tray 状态与菜单
        └── 原生目录选择器、路径验证
```

- 渲染进程不启用 Node.js，只能调用 preload 暴露的固定方法。
- 主进程验证 IPC 发送方、字符串长度、终端尺寸和目录是否真实存在。
- PTY 输出由主进程推送到渲染进程；键盘输入反向写入 PTY。
- 目录切换会终止旧 PTY，并以新目录创建新会话，保证工作目录确定。
- 托盘状态由同一个 `TerminalStatus` 驱动，避免界面与后台状态分叉。

## 安全策略

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- 内容安全策略只允许本地脚本和样式；开发模式额外允许本机 Vite 连接。
- 禁止任意页面跳转、弹窗和未授权 IPC 通道。
- 不保存终端输入、API 密钥或命令历史；PowerShell 自身行为不在应用持久化范围内。
- 原生 `node-pty` 只在主进程加载，并在打包时从 ASAR 解包。

## 构建、测试与调试

- `npm run dev`：并行监听主进程与 Vite 渲染进程并启动 Electron。
- `npm run lint`：检查 TypeScript 源码。
- `npm run typecheck`：分别检查渲染端和主进程类型。
- `npm test`：运行纯函数和目录校验单元测试。
- `npm run build`：生成图标、编译主进程并构建渲染资源。
- `npm run dist`：构建 Windows x64 NSIS 安装包。

CI 在 `windows-latest` 上执行 lint、格式、类型、测试和构建，不发布安装包。

## 关键取舍与限制

- 采用“应用自建并控制 PTY”，而不是注入或劫持外部控制台；后者不稳定且扩大权限边界。
- 拖入文件夹时重启 PTY，换取可验证的工作目录；当前不保存多个会话。
- Windows 10 1809 之前没有所需 ConPTY API，不在支持范围。
- 代码签名、自动更新、多标签终端和会话恢复尚未实现。

## 外部依据

- Electron Security：
  <https://www.electronjs.org/docs/latest/tutorial/security>
- Electron Tray：
  <https://www.electronjs.org/docs/latest/api/tray>
- Electron `webUtils.getPathForFile`：
  <https://www.electronjs.org/docs/latest/api/web-utils>
- node-pty：
  <https://github.com/microsoft/node-pty>
- xterm.js addons：
  <https://xtermjs.org/docs/guides/using-addons/>

