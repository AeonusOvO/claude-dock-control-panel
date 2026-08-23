# 验证

## 快门禁

每次改动后运行，PowerShell 5.1 无 `&&`，逐条执行：

```powershell
npm run lint
npm run format:check
npm run typecheck
npm test
npm run lint:deps
npm run build
```

| 命令                   | 覆盖                                                                                 | 通过标准                                |
| ---------------------- | ------------------------------------------------------------------------------------ | --------------------------------------- |
| `npm run lint`         | ESLint 覆盖 `src/`、`tests/`、`scripts/`、`vite.config.ts`、`vite.preload.config.ts` | 0 error 0 warning（`--max-warnings=0`） |
| `npm run format:check` | Prettier 覆盖全仓                                                                    | 无待格式化文件                          |
| `npm run typecheck`    | 三套 tsconfig（渲染端与测试 / 主进程 / preload）分别 `--noEmit`                      | 无类型错误                              |
| `npm test`             | Vitest 全量                                                                          | 用例总数不低于基线，全部通过            |
| `npm run lint:deps`    | dependency-cruiser 分层、循环、孤儿                                                  | 无违规（全部规则为 error）              |
| `npm run build`        | 图标 + typecheck + 主进程 + preload + 渲染端                                         | 成功；渲染端有预期的大分块提示          |

`npm run lint` 以 `--max-warnings=0` 运行：任何 warning 即失败，不存在存量豁免。

## 全门禁

改动跨进程契约、主进程结构、渲染进程结构或构建配置后运行：

```powershell
npm run test:layout
npm run test:control-theme
npm run test:visual
npm run test:conpty
npm run test:runtime-soak:accelerated
npm run dist
```

| 命令                                                             | 覆盖                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------- |
| `npm run test:layout`                                            | 真实 Electron 里的布局场景                               |
| `npm run test:control-theme`                                     | 四主题下控件的计算样式                                   |
| `npm run test:visual`                                            | 原生视觉截图（`visual-smoke` + `native-visual-smoke`）   |
| `npm run test:visual:real`                                       | 隔离 RuntimeProfile 下的真实 Electron 截图               |
| `npm run test:conpty`                                            | 真实 ConPTY 的 resize 与 stop/restart 生命周期、事件顺序 |
| `npm run test:select`、`test:select-theme`、`test:dialog-select` | 原生 `<select>` 交互与主题                               |
| `npm run test:scroll-chaining`                                   | trusted 滚轮下的嵌套滚动链与弹层封闭（须可见窗口）       |
| `npm run test:runtime-soak:accelerated`                          | 模拟 24 小时会话与服务回收                               |
| `npm run dist`                                                   | 端到端打包并生成当前通道产物                             |

这些命令都以 `npm run build:renderer` 或 `npm run build` 为前置，会真实启动 Electron。

准备发布候选时，先移除 `outputs/` 中上一版本的生成物，再用 `npm run release` 代替最后一次单独的
`npm run dist`。它在打包后运行 `npm run release:manifest`，额外校验：

- 恰好一个无凭据、无查询参数的 generic HTTPS feed，且 `useMultipleRangeRequest=false`。
- 版本对应的 `rc.yml`、`beta.yml` 或 `latest.yml` 通道选择。
- 安装包、blockmap、通道清单的精确文件集合。
- 清单只有一个完整 `files` 对象，URL、path、size 和两个 SHA-512 字段与安装包一致。
- `outputs/release-manifest.json` 的 `problems` 为空。

## 真实发行包网络验收

网络 transport、系统代理、TUN/VPN 或 Electron 版本变化后，单元测试和 renderer smoke 不能代替真实运行时验收。
完成 `npm run dist` 后，必须使用该次 NSIS 候选包的真实生产应用（安装后程序或同批次
`win-unpacked` 可执行文件，不是 Vitest/jsdom/开发服务器）执行一次“网络预检→立即重新检测”，并核对：

- 应用端点不得统一误报 `Network request closed before a response was received`。
- DNS 和应用端点必须反映当前机器的真实网络状态；401/403/404/405 与已知入口跳转不得写成断网。
- 语言项必须显示 Windows 系统首选语言且标为“参考”；不得出现语言风险、阻断或修复按钮。
- 「检查所有更新」读取打包进应用的当前 COS 通道；检查本身不触发下载，只有显式下载路由开始传输。
- rc.15 引导验收必须证明手动安装后的应用读取 `rc.yml`，而不是旧 GitHub provider。
- 记录实测程序路径、Electron 版本、检测时间、当前通道和可见结果，不记录完整 IP、令牌、授权字段或请求头。

## 打包报告

发布候选以 `outputs/release-manifest.json` 为主记录。至少核对：

| 字段                             | 含义                                            |
| -------------------------------- | ----------------------------------------------- |
| `directory`                      | 唯一发布目录的绝对路径                          |
| `version`                        | `package.json` 的版本                           |
| `provider` / `feedUrl`           | `generic` 与打包进应用的无凭据 COS feed         |
| `channel` / `channelManifest`    | 当前通道与 `rc.yml` / `beta.yml` / `latest.yml` |
| `artifacts[].bytes`              | 安装包、blockmap、通道清单的实际字节数          |
| `artifacts[].sha256` / `.sha512` | 最终构建产物摘要                                |
| `signature`                      | 安装包 Authenticode 状态                        |
| `problems`                       | 必须为空                                        |

本地构建无代码签名时，签名状态为 `NotSigned`，报告时按实际值写明，不描述为已签名发行版。可用以下
PowerShell 作为独立抽查，不把手工结果替代门禁报告：

```powershell
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$exe = "outputs\ClaudeDock-Setup-$version-x64.exe"
$item = Get-Item $exe
"{0}`n{1} bytes ({2:N2} MB)" -f $item.FullName, $item.Length, ($item.Length / 1MB)
(Get-FileHash $exe -Algorithm SHA256).Hash
(Get-AuthenticodeSignature $exe).Status
```

## COS 公开 feed 验收

`npm run release:publish:cos` 自身会在通道清单写入前验证安装包和 blockmap：

- 匿名 HEAD 返回精确 `Content-Length` 和不可变缓存头。
- `Range: bytes=0-0` 返回 206、精确 `Content-Range` 和与本地产物一致的首字节。
- 完整匿名 GET 的长度、SHA-256、SHA-512 与本地产物一致。
- 通道清单最后写入，使用 no-cache 头；公开回读文本与版本必须精确一致。

发布后独立复核这些结果，并检查远端通道没有回退。稳定版 `--promote-rc` 同时核对 `latest.yml` 和
`rc.yml`。发布脚本的 HEAD/Range/摘要检查证明远端一致性，electron-updater 的 SHA-512 证明客户端下载
与所读清单一致；两者都不替代 Authenticode 或独立清单签名。当前 `NotSigned` 构建不能记为发布者身份
已验证。

## CI

`.github/workflows/ci.yml` 在 Windows runner、Node 24 上运行 lint、format:check、typecheck、test、lint:deps、build。需要真实 Electron 窗口的冒烟脚本不在 CI 内，只在本地跑。CI 不持有 COS 发布凭据，
也不自动运行 `release:publish:cos`；外部发布始终是显式、凭据隔离的发布操作。

## 依赖图人工核对

```powershell
npx depcruise src --output-type mermaid
npm run lint:deps:graph
```

规则通过不等于分层成立——规则只能禁止已知的坏依赖。改动结构后看一次图，确认层次关系与 [project-layout.md](../reference/project-layout.md) 描述一致。

## 源码文本断言

历史上一度存在约 1,045 处源码文本钉（用 `readFileSync` 把源码当字符串检查特定代码形态存在）；它们已全部转换为行为测试或资产契约，转换规则见 [ADR-0009](../adr/0009-behavioral-tests-replace-source-pins.md)。

当前 `tests/` 里残留的 `readFileSync` 仅限三类合法用途：

- 主进程 store 落盘行为验证：驱动真实 store 后读临时目录文件断言持久化内容。
- 资产契约：`tests/renderer/design-tokens.test.ts` 经 postcss 解析 CSS/HTML 断言设计 token 结构。
- harness 设施：`tests/helpers/` 自身装载 `index.html`、`styles.css` 构造测试环境。

新增测试不允许再写源码文本钉；断言模块的可观察行为，不臆断代码写法。
