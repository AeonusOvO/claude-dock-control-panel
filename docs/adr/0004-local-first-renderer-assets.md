# ADR-0004 渲染端资源本地优先

- 状态：已采纳
- 日期：2026-08-17

## 背景

渲染端需要四类外部资源：可变字重字体（Inter、Hanken Grotesk、Newsreader、Roboto）、Shiki 的语法高亮（WASM 引擎 + 语言语法 + 主题）、KaTeX 的公式渲染与字体、Mermaid 与 Plotly 的图表运行时。

常规做法是从 CDN 加载。但渲染进程的 CSP 是 `default-src 'self'`、`script-src 'self'`、`font-src 'self' data:`——从 CDN 取脚本或字体需要放开 `script-src` 与 `font-src` 到外部域名。

## 决策

全部渲染端资源随包分发，不从网络加载。

- 字体走 `@fontsource-variable/*` npm 包，由 Vite 打进产物。
- Shiki 的 WASM 引擎（`@shikijs/engine-oniguruma`）、语言语法（`@shikijs/langs`）、主题（`@shikijs/themes`）作为依赖打包。
- KaTeX、Mermaid、Plotly 同样作为依赖打包。
- CSP 保持 `script-src 'self'`、`font-src 'self' data:`。

代价是渲染端入口分块远超 Vite 的 500 kB 默认告警阈值。`vite.config.ts` 把 `chunkSizeWarningLimit` 设为 1200（kB），对应实测的最大块体积——这是把已知体积记录下来，不是关掉告警：块继续变大仍会告警。

## 结果

- 离线可用：无网络时语法高亮、公式、图表、字体全部正常。
- CSP 不需要为资源加载放开外部来源。
- 首屏没有字体闪烁或高亮延迟。
- 代价：安装包体积约 135 MB。
- 代价：语言语法与主题更新要跟随依赖升级，不能靠 CDN 自动获得。
- 代价：`npm run build` 每次都有大分块提示，这是预期输出，不是失败。

## 备选方案

**CDN 加载** —— 减小包体，但需要 `script-src`/`font-src` 放开外部域名，且离线不可用。

**只打包按需的少数语言语法** —— 能显著减小体积，但 Shiki 的按需加载需要动态 import 远程语法文件，与本地优先冲突；改为构建期静态选定语言集则会在用户粘贴未选语言的代码时退化为无高亮。
