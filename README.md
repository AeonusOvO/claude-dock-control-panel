# ClaudeDock 控制面板

ClaudeDock 是一个面向 Windows 的桌面控制面板，用于在图形界面中同时管理多个项目的
真实 PowerShell 伪终端、快速切换当前项目，并通过系统托盘查看后台状态。

## 功能边界

- 每个项目拥有独立的 Windows PowerShell/ConPTY 会话，可同时在后台运行。
- 项目列表支持添加、切换和关闭项目；终端输出与滚动缓冲在项目切换后仍会保留。
- 将文件夹拖入窗口或使用目录选择器即可添加项目；重复添加同一路径会切回已有会话。
- 关闭主窗口后驻留系统托盘，可从托盘恢复、切换/添加项目或控制当前终端。
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

`npm run dist` 在 `release/` 完成 Windows x64 打包，并把最终安装程序
`ClaudeDock-Setup-<version>-x64.exe` 发布到项目根目录。

## 日常使用

1. 启动 ClaudeDock 后，首个 PowerShell 会话会自动连接并显示当前用户目录。
2. 把项目文件夹拖到窗口任意位置，或点击“添加项目”；应用会为它新建独立会话，不会停止
   已经运行的其他项目。
3. 在左侧项目列表切换当前项目；点击项目行右侧的关闭按钮会终止并移除该项目会话。
4. 直接在黑色终端区输入 PowerShell 命令。点击“运行 Claude Code”相当于在当前目录输入
   `claude`。
5. 点击窗口关闭按钮只会隐藏面板，所有会话继续在后台运行；右键系统托盘图标可以恢复
   窗口、切换/添加项目、控制当前终端或彻底退出。

安装时可自行选择 `D:\ClaudeDock` 等目标路径，并可在“安装选项”页面勾选或取消
“在桌面创建快捷方式”（默认勾选）。

## 目录

```text
assets/              图标矢量源及生成图标
build/               electron-builder/NSIS 安装器自定义脚本
scripts/             清理、图标生成等工程脚本
src/main/            Electron 主进程、项目工作区与 PowerShell 会话管理
src/preload/         受限的渲染进程桥接 API
src/renderer/        控制面板界面与 xterm.js 终端
src/shared/          跨进程类型和纯函数
tests/               单元测试
outputs/             本地交付物，不纳入 Git
ClaudeDock-Setup-*.exe  根目录中的最终安装包，不纳入 Git
```

## 安全与限制

- 界面只加载项目自带的本地内容，关闭 Node.js 集成并启用上下文隔离和沙箱。
- 用户在终端中输入的命令拥有当前 Windows 用户的权限，应用不会替用户审查命令。
- 关闭项目会终止该项目的 PowerShell 进程；切换项目不会影响其他项目的运行。
- 项目会话只在本次应用运行期间保留，彻底退出后不会恢复终端进程或历史缓冲。
- 本地构建默认没有代码签名，Windows SmartScreen 可能显示未知发布者提示。
- 当前仅打包 Windows x64。
- `@lydell/node-pty` 提供与上游 node-pty API 兼容的按平台预编译包，避免最终用户安装
  Visual Studio C++ 构建组件。

维护者：本项目当前由本地使用者维护。
