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
| `npm run test:runtime-soak:accelerated`                          | 模拟 24 小时会话与服务回收                               |
| `npm run dist`                                                   | 端到端打包                                               |

这些命令都以 `npm run build:renderer` 或 `npm run build` 为前置，会真实启动 Electron。

## 打包报告

`npm run dist` 后报告五项：

| 项       | 获取方式                                     |
| -------- | -------------------------------------------- |
| 绝对路径 | `outputs/ClaudeDock-Setup-<version>-x64.exe` |
| 版本     | `package.json` 的 `version`                  |
| 文件大小 | `(Get-Item <exe>).Length`                    |
| SHA-256  | `Get-FileHash <exe> -Algorithm SHA256`       |
| 签名状态 | `Get-AuthenticodeSignature <exe>`            |

本地构建无代码签名，签名状态为 `NotSigned`，报告时按实际值写明，不描述为已签名发行版。

```powershell
$exe = 'outputs\ClaudeDock-Setup-5.0.0-rc.13-x64.exe'
$item = Get-Item $exe
"{0}`n{1} bytes ({2:N2} MB)" -f $item.FullName, $item.Length, ($item.Length / 1MB)
(Get-FileHash $exe -Algorithm SHA256).Hash
(Get-AuthenticodeSignature $exe).Status
```

## CI

`.github/workflows/ci.yml` 在 Windows runner、Node 24 上运行 lint、format:check、typecheck、test、lint:deps、build。需要真实 Electron 窗口的冒烟脚本不在 CI 内，只在本地跑。

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
