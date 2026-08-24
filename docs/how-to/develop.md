# 开发

## 环境

| 要求    | 版本     |
| ------- | -------- |
| Windows | 10 1809+ |
| Node.js | 24+      |
| npm     | 11+      |

```powershell
npm install
npm run dev
```

`npm run dev` 协调四个进程：main 使用 `tsc --watch` 增量编译，preload 使用 Vite watch 构建，renderer 由 Vite 在 `127.0.0.1:5173` 提供，Electron 在 `wait-on` 确认 main 与 preload 产物就绪后启动。改动 main 或 preload 代码需要重启 Electron；改动 renderer 由 Vite 热更新。

## 命令

- `npm run dev`：开发模式
- `npm start`：用已构建的 `dist/` 启动 Electron
- `npm run build`：clean 后先生成 identity，再生成图标、typecheck 和构建三进程
- `npm run build:main`：只编译 main
- `npm run build:preload`：只构建 preload
- `npm run build:renderer`：只构建 renderer
- `npm run dist`：打包 Windows x64 NSIS 安装包到 `outputs/`
- `npm run release:manifest`：校验通道/feed/产物并生成本地发布报告
- `npm run release`：在 clean exact commit 上重装、跑门禁、打包和生成报告，不上传
- `npm run release:publish:cos`：显式发布已验证产物到 COS；见 release.md
- `npm run clean`：删除 `dist/`
- `npm run generate:icons`：从 `assets/source/*.svg` 生成 PNG/ICO
- `npm run generate:source-identity`：生成无凭据 packaged source identity
- `npm run format`：Prettier 写入
- `npm run lint:deps:graph`：输出依赖架构图

验证类命令见 [verify.md](verify.md)。

## 加一个 IPC 往返

四处改动，缺一处就编译失败或运行时报错：

1. `src/shared/contracts/control-panel-api.ts` —— 在对应的域接口（如 `ClaudeApi`、`ChatApi`）加方法签名；参数与返回值类型加在同域的 `src/shared/contracts/<domain>.ts`。
2. `src/preload/bridges/<domain>.ts` —— 加桥方法，`ipcRenderer.invoke(CHANNELS.<CONSTANT>, ...)`（频道常量来自 `src/shared/ipc/channels.ts`）。
3. `src/main/ipc/<domain>.ts` —— `ipcMain.handle`，首行 `validateSender(event)`，参数用 `validate*()` 从 `unknown` 收窄；处理器需要的依赖加进同文件的 `XxxIpcDependencies` 接口，经 `src/main/ipc/contributions.ts` 的贡献点自动汇入 `MainIpcDependencies`。
4. `docs/reference/ipc-contract.md` —— 更新对应小节的表格。

频道名格式 `<namespace>:<kebab-action>`，namespace 与既有的 21 个之一对齐。

高频写入（每次按键、每帧尺寸）用单向 `ipcRenderer.send` + `ipcMain.on`，避免 Promise 往返开销；这类通道必须带单调版本号，接收侧丢弃过期消息。

## 加一个主进程状态广播

1. 主进程持有者内部变更状态。
2. `mainWindow.webContents.send('<namespace>:changed', snapshot)`。
3. preload 加 `on<Name>` 订阅方法，返回取消函数（内部 `removeListener`）。
4. 渲染端订阅并重渲染。

广播的是完整快照而非增量：渲染进程重载后靠重放最近一次快照恢复界面，不需要重建逻辑。

## 加一个设置项

1. `src/shared/contracts/app.ts` 扩展对应的 settings 类型。
2. 主进程 store 加字段与默认值，读取时对旧配置做向后兼容。
3. `app:set-*` 频道写入，`app:get-settings` 读取。
4. `src/renderer/index.html` 加控件，渲染端绑定。
5. 设置面板分组：总设置 / 高级设置 / 接入 / 代理 / 路由。

## 加一个视图样式

`src/renderer/styles/views/` 下新建 `<view>.css`，在 `styles.css` 末尾 `@import`。颜色一律用 `01-tokens.css` 的自定义属性，不写字面量色值——四个主题靠 token 切换。

`npm run test:control-theme` 会检查控件在四个主题下的计算样式。

## 约定

| 项       | 约定                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------- |
| 类型位置 | 跨进程类型在 `src/shared/`；单进程内部类型就近定义                                                |
| 桶文件   | 只有 `src/shared/contracts/index.ts` 一个，其余一律直接 import 具体文件                           |
| 参数校验 | IPC 入口一律 `unknown` 入参 + `validate*()` 收窄，不信任渲染端                                    |
| 错误处理 | 主进程把异常转成结构化失败结果返回，不让 Promise reject 穿过 IPC 边界                             |
| 注释     | 解释为什么，不解释是什么；不引用文档路径，不写流程性表述                                          |
| 命名     | 文件 kebab-case，类型 PascalCase，函数与变量 camelCase，IPC 频道 `namespace:kebab-action`         |
| 终端输入 | 捕获 session/view/`ptyGeneration`；粘贴只走 `Terminal.paste → onData`，不得直接写 PTY             |
| 事件顺序 | 必须先于 xterm 的右键处理使用容器 capture listener，并在 dispose 时成对移除                       |
| 异步反馈 | busy 文案、disabled、`aria-busy`/live status 属于 operation token；旧 settlement 不得恢复新 owner |
| 品牌资产 | 官方 SVG 保留来源 URL、检索日期、源/规范化哈希与安全结构；改动同步资产契约测试                    |
| 提交前   | 跑快门禁（见 [verify.md](verify.md)）；代码或打包改动后必须跑 `npm run dist`                      |

## 结构约束

`npm run lint:deps` 强制的分层规则见 [project-layout.md](../reference/project-layout.md)。全部规则为 error，常见违规：

- 在 `src/shared/` 里 import `electron`，或通过 bare / `node:` specifier import Node core module。
- 新建文件后没有任何 import 引用它（孤儿模块）。
- 两个模块互相 import（循环依赖）。
- `src/` 里 import 了 devDependency。

`max-lines` 上限 1000 行，`max-lines-per-function` 上限 200 行，规则级别为 warn；`npm run lint` 以 `--max-warnings=0` 运行，因此任何超限告警（含其他 warning）直接失败，不存在存量豁免。
