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
| `npm run build`        | clean + packaged source identity + 图标 + typecheck + 主进程 + preload + 渲染端      | 成功；渲染端有预期的大分块提示          |

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

Electron 布局、控件、视觉、select、滚动和 ConPTY 命令会构建对应进程并真实启动 Electron；accelerated
soak 直接运行 Node 合成时钟。最终候选的这些门禁必须在全部发行改动提交后的 exact commit 上运行。

另有三项默认跳过的 Windows 集成测试，覆盖真实进程树捕获/终止、真实 listener/loopback tuple 和带
exact-process 校验的模型读取。最终候选在 Windows 上运行：

```powershell
$env:CLAUDEDOCK_WINDOWS_INTEGRATION = '1'
npm test -- tests/main/managed-chatgpt-process-identity.test.ts tests/main/managed-chatgpt-owned-models.test.ts
Remove-Item Env:CLAUDEDOCK_WINDOWS_INTEGRATION
```

该命令同时运行两个文件中的普通用例；环境开关额外启用上述三项集成用例。其通过数量取自 exact-commit
日志，不从 `release-manifest.json` 推导。

rc.16 的聚焦契约还必须覆盖：

- Ctrl+V/右键菜单一次物理动作只产生一次 `Terminal.paste → onData → writeTerminal`；5 MiB 加 bracket wrapper
  保持单次写入，AltGraph/组合修饰键不被接管，stale generation/view/menu revision 均拒绝。
- Provider access、精确端点连接权威、所有 advisory check provenance、live/cache freshness，以及 schema-v2
  诊断持久化、v1 迁移、未知地址族和地址脱敏。
- runtime switch 的 main CWD owner、Codex/插件的 main 应用级 owner 与自动终端启动，在 renderer reload、
  无关 workspace/catalog/state 重绘和 stale settlement 后仍恢复准确文案、`aria-busy` 和 mutation lock。
- 三个本地 runtime SVG 的来源、检索日期、源/规范化哈希、官方 fill 和安全 standalone 结构。
- `LICENSE` 与 `NOTICE` 既显式存在于 `build.files`，也真实存在于最终 packaged application。

准备最终候选时，先提交全部发行改动并完成上述 exact-commit 门禁，再定向移除 `outputs/` 中上一批生成物，
使目录不存在或只保留仓库跟踪的空 `.gitkeep`。`npm run release` 在任何打包前拒绝 dirty source 或非空
`outputs/`，然后依次运行 `npm ci`、lint、format check、三套 typecheck、全量 Vitest、
dependency-cruiser、`npm run dist`、源码身份复核和 `npm run release:manifest`。它额外校验：

- 恰好一个无 userinfo、查询参数或片段的 generic HTTPS feed，且 `useMultipleRangeRequest=false`。
- 版本对应的 `rc.yml`、`beta.yml` 或 `latest.yml` 通道选择，以及 packaged `app-update.yml` 的相同 channel。
- 安装包、blockmap、通道清单的精确文件集合。
- 清单只有一个完整 `files` 对象，URL、path、size 和两个 SHA-512 字段与安装包一致。
- source tree clean；记录完整 Git HEAD、`treeClean: true` 和 `package-lock.json` SHA-256。ignored
  `dist/`、`outputs/` 不计入 dirt，其他 tracked/untracked 文件一律拒绝。
- `npm run build` 在 clean 后、任何生成或编译前写入 `dist/build-source-identity.json`；该文件必须存在于
  ASAR，只含固定 schema 和无凭据源码身份字段，并与打包前后当前源码身份一致。
- `win-unpacked/resources/app.asar` 的版本、根 `LICENSE` / `NOTICE`、恰好三个 byte-identical hashed 品牌
  SVG，以及 ASAR/解包目录不含 `claude.exe`。
- 固定 `7zip-bin` 直接物化 NSIS application payload，且不运行安装器；payload 的 `app.asar`、完整
  `app.asar.unpacked` 树和存在性对称的 `app-update.yml` 与同批次 `win-unpacked` 逐字节相同。
- 外部 gzip blockmap v2 恰好包含 `file` / offset 0，正 safe-integer chunk sizes 完整覆盖安装包，全部
  18-byte Base64 BLAKE2b-144 checksums 逐块匹配。
- Authenticode 只接受明确的 `Valid` 或 `NotSigned`；空、未知、不可用、hash/trust failure 和其他状态拒绝。
- `outputs/release-manifest.json` 的 `problems` 为空，并记录确定性的 blockmap 与 installer-payload cohort；完整
  编排另以 `release-orchestration.json` 记录固定步骤、源码身份和 frozen report 字节摘要。

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
| `source.gitHead`                 | 与 packaged build identity 一致的完整 Git HEAD  |
| `source.treeClean`               | 构建与最终 manifest 生成时都必须为 `true`       |
| `source.packageLockSha256`       | 与 packaged identity 一致的 lockfile SHA-256    |
| `cohort.blockmap`                | blockmap v2 结构、覆盖与 BLAKE2b-144 证据       |
| `cohort.installerPayload`        | NSIS payload 与 `win-unpacked` 的字节绑定证据   |
| `artifacts[].bytes`              | 安装包、blockmap、通道清单的实际字节数          |
| `artifacts[].sha256` / `.sha512` | 最终构建产物摘要                                |
| `signature`                      | 安装包 Authenticode 状态                        |
| `problems`                       | 必须为空                                        |

签名结论只取最终候选 manifest：`Valid` 按实际值记录，`NotSigned` 不描述为已签名发行版；构建前不预设
最终状态。可用以下 PowerShell 作为独立抽查，不把手工结果替代门禁报告：

```powershell
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$exe = "outputs\ClaudeDock-Setup-$version-x64.exe"
$item = Get-Item $exe
"{0}`n{1} bytes ({2:N2} MB)" -f $item.FullName, $item.Length, ($item.Length / 1MB)
(Get-FileHash $exe -Algorithm SHA256).Hash
(Get-AuthenticodeSignature $exe).Status
```

## COS 公开 feed 验收

`npm run release:publish:cos` 先要求 `release-orchestration.json` 证明完整固定步骤并精确绑定 frozen
`release-manifest.json` 字节，再以 non-writing validation 核对 ASAR build identity 与 frozen source、当前 clean
HEAD、lockfile、NSIS payload byte linkage、blockmap chunks、cohort 和全部产物，不覆盖报告或改变
`generatedAt`。已核对的通道 YAML 字节在上传前冻结，不再从本地路径重读；随后在通道清单写入前验证安装包
和 blockmap：

- 匿名 HEAD 返回精确 `Content-Length` 和不可变缓存头。
- `Range: bytes=0-0` 返回 206、精确 `Content-Range` 和与本地产物一致的首字节。
- 完整匿名 GET 的长度、SHA-256、SHA-512 与本地产物一致。
- 通道清单最后写入，使用 no-cache 头；公开回读文本与版本必须精确一致。

发布后独立复核这些结果，并检查远端通道没有回退。稳定版 `--promote-rc` 同时核对 `latest.yml` 和
`rc.yml`。发布脚本的 HEAD/Range/摘要检查证明远端一致性，electron-updater 的 SHA-512 证明客户端下载
与所读清单一致；两者都不替代 Authenticode 或独立清单签名。若最终 manifest 为 `NotSigned`，该构建
不能记为发布者身份已验证。

## CI

`.github/workflows/ci.yml` 在 Windows runner、Node 24 上运行 lint、format:check、typecheck、test、lint:deps、build。需要真实 Electron 窗口的冒烟脚本不在 CI 内，只在本地跑。CI 不持有 COS 发布凭据，
也不自动运行 `release:publish:cos`；外部发布始终是显式、凭据隔离的发布操作。

## 依赖图人工核对

```powershell
npx depcruise src --output-type mermaid
npm run lint:deps:graph
```

规则通过不等于分层成立——规则只能禁止已知的坏依赖。改动结构后看一次图，确认层次关系与 [project-layout.md](../reference/project-layout.md) 描述一致。

## 文件与源码边界断言

历史上一度存在约 1,045 处把实现形态钉死的源码文本断言；绝大多数已转换为行为测试或资产契约，转换
规则见 [ADR-0009](../adr/0009-behavioral-tests-replace-source-pins.md)。当前仍保留以下明确边界，不应笼统描述为
“零源码扫描”：

- 主进程 store、发布报告和 fixture 落盘行为：驱动真实模块后读取临时目录文件并断言持久化结果。
- 结构化资产/package/config 契约：解析设计 token、HTML、CSS、`package.json`、`package-lock.json`、
  `.dependency-cruiser.cjs`、ASAR 和打包资源声明。
- 经审计的本地品牌/资源来源：验证来源 URL、检索日期、源哈希、规范化 SVG 哈希、官方 fill 与安全
  standalone 结构。
- harness 与脚本装载：`tests/helpers/` 读取 renderer markup/CSS；`scripts-syntax.test.ts` 枚举 release、
  build、smoke 脚本并用 `node --check` 调用真实 parser。
- 窄范围的负向能力扫描：egress application request、DNS correlation、MaxMind adapter、repair
  store/planner/journal/applier、plugin catalog、egress evidence contract 和 Claude execution-settings contract
  只检查禁止出现的 subprocess、network、global environment、mutation API 或已删除的 contract vocabulary。

最后一类验证的是“该纯模块绝不能拥有某能力”的静态边界，并与行为用例并存；它不是允许一般测试检查函数
正文、调用顺序或特定实现拼写。新增测试默认断言可观察行为，只有无法由运行时替身证明的负向能力边界才可
采用同类窄扫描。
