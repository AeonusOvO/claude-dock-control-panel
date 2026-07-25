# ClaudeDock 控制面板

ClaudeDock 是一个面向 Windows 的桌面控制面板，用于在图形界面中启动和控制真实的
PowerShell 伪终端、快速切换项目目录，并通过系统托盘查看后台状态。

## 功能边界

- 内嵌 Windows PowerShell 终端，支持输入、清屏、启动、停止和重启。
- 将文件夹拖入窗口或使用目录选择器后，在该目录重新启动终端。
- 关闭主窗口后驻留系统托盘，可从托盘恢复、切换目录或控制终端。
- 提供“运行 Claude Code”快捷操作；它只执行当前系统中的 `claude` 命令，不修改
  Codex 或 Claude Code 的模型/API 路由。
- 不劫持任意已经打开的外部 PowerShell 窗口；应用创建并接管自己的 ConPTY 会话。

## 开发环境

- Windows 10 1809 或更高版本
- Node.js 24 或更高版本
- npm 11 或更高版本

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

`npm run dist` 在 `release/` 生成 Windows x64 安装程序。

## 日常使用

1. 启动 ClaudeDock 后，PowerShell 会自动连接并显示当前用户目录。
2. 把项目文件夹拖到窗口任意位置，或点击“选择文件夹”；当前会话会在目标目录重启。
3. 直接在黑色终端区输入 PowerShell 命令。点击“运行 Claude Code”相当于在当前目录输入
   `claude`。
4. 点击窗口关闭按钮只会隐藏面板，会话继续在后台运行；右键系统托盘图标可以恢复窗口、
   重启/停止终端或彻底退出。

安装时可自行选择 `D:\ClaudeDock` 等目标路径。

## 目录

```text
assets/              图标矢量源及生成图标
scripts/             清理、图标生成等工程脚本
src/main/            Electron 主进程与 PowerShell 会话管理
src/preload/         受限的渲染进程桥接 API
src/renderer/        控制面板界面与 xterm.js 终端
src/shared/          跨进程类型和纯函数
tests/               单元测试
outputs/             本地交付物，不纳入 Git
```

## 安全与限制

- 界面只加载项目自带的本地内容，关闭 Node.js 集成并启用上下文隔离和沙箱。
- 用户在终端中输入的命令拥有当前 Windows 用户的权限，应用不会替用户审查命令。
- 切换项目目录会重启当前内嵌终端，因此正在运行的前台命令会结束。
- 本地构建默认没有代码签名，Windows SmartScreen 可能显示未知发布者提示。
- 当前仅打包 Windows x64。
- `@lydell/node-pty` 提供与上游 node-pty API 兼容的按平台预编译包，避免最终用户安装
  Visual Studio C++ 构建组件。

维护者：本项目当前由本地使用者维护。
