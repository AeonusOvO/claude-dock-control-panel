# 路径与可移植性

生产代码不得包含开发者机器的盘符、用户名、仓库目录或安装目录。运行时解析出的绝对路径仍然必要：
Electron 资源加载、外部进程、用户选择的项目目录和安全所有权校验都不能依赖随时可能变化的工作目录。

## 路径来源

| 用途                        | 路径来源                                                             | 约束                                                         |
| --------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------ |
| 应用数据、日志、网关状态    | Electron `app.getPath('userData')` → `RuntimeProfile.paths.userData` | 跟随当前用户，不依赖安装盘符                                 |
| 用户级 CLI 配置和历史       | 当前用户 home、`APPDATA`、`LOCALAPPDATA`                             | 不使用发布机器的用户目录                                     |
| renderer、preload、图标     | `app.getAppPath()`                                                   | 支持自选安装目录与 ASAR                                      |
| PowerShell 运行脚本         | packaged `process.resourcesPath/app.asar.unpacked`；开发态应用根目录 | 外部进程不能执行 ASAR 内的虚拟文件                           |
| PowerShell 与 curl 系统程序 | 大小写不敏感的 `SystemRoot`，其次 `WINDIR`，最后系统命令查找         | 不假定 Windows 位于某一盘符；忽略相对或无盘符根目录          |
| 发行签名检查                | 已检测到的 Windows 安装内 PowerShell 与 Security 模块                | 系统目录不可用时返回 unavailable，不能猜测盘符或放宽签名门禁 |
| 用户项目与 CLI 自选安装位置 | 文件夹选择器、CLI 发现或用户已保存的配置                             | 保留用户明确选择的绝对路径，不批量改成相对路径               |
| 临时测试目录                | `os.tmpdir()` 与随机私有目录                                         | 不读取或修改生产账号、历史和网关状态                         |

## 网络预检的两个目录概念

`NetworkPreflightRunInput.cwd` 保留为配置和授权的逻辑作用域。全局下个对话使用应用数据目录下的
`claude/next-conversation-profile` 作为稳定身份；它不保证是一个磁盘目录。精确作用域仍参与缓存、租约、
嵌套操作与重新检测的身份校验，跨项目、跨 Provider、跨 target 的复用继续拒绝。

`NetworkPreflightService.probeWorkingDirectory` 才是 curl 和 CLI 版本探测的真实进程工作目录。应用装配
从当前 `RuntimeProfile.paths.userData` 注入；独立构造服务时默认使用当前用户 home。探测不创建逻辑
profile 目录，不更改项目目录，不把授权身份传给子进程 `cwd`。

本机 `spawn` 的 ENOENT、ENOTDIR、EACCES、EPERM 被标记为本机探测启动失败，明确说明请求尚未发出。
这些错误不能写成账户授权被拒绝或建议用户修改 DNS，也不能通过跳过预检来继续授权。全局一键接入若在
操作前被拦截，界面明确说明安装和 OpenAI 授权尚未开始；原有接入保持不变。

## 审计与回归边界

源码、运行脚本、构建/发行配置及当前文档中的机器目录需要审计。测试中的不同盘符、中文、空格、UNC
与无效路径是合成输入，不用于访问某位开发者的目录；已发布说明和历史记录保留原貌。视觉夹具只显示
相对目录或“用户目录/项目目录”占位。

回归覆盖不同用户与安装盘符、中文/空格路径、SystemRoot/WINDIR 缺失或失效、资源重定位、逻辑 profile
不存在时的真实 Windows curl 回环请求，以及相同身份允许嵌套而不同身份仍被拒绝。不进行真实账号授权，
也不以回环测试代替用户完成授权后的订阅可用性验收。

`npm run test:paths -- --packaged` 会读取最终安装包同批次 ASAR 中的生产模块，以真实 Electron/curl 发送
匿名回环 GET；不会安装、更新或打开用户的生产实例，也不读取真实授权文件。
