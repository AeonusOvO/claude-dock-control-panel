# ADR-0006 按特性分片的渲染进程结构

- 状态：已采纳
- 日期：2026-08-17

## 背景

`src/renderer/main.ts` 是 15,181 行的单一模块作用域，容纳十个界面的全部逻辑：DOM 句柄、顶层可变状态、渲染函数、事件监听、IPC 调用。

实测特征：每个特性的引用都从文件首行铺到末行，没有任何局部性。后果是

- 任何代码能读写任何元素，任何函数能改任何状态。
- 无法在测试里加载其中一部分并驱动它，因此无法写行为测试（见 [ADR-0003](0003-source-text-regression-pins.md)）。
- 改一个界面需要在全文件范围内确认没有别处依赖被改动的状态。

## 决策

按特性分片，不按层分片。

```
renderer/
  main.ts                 装配
  platform/               与特性无关的能力：DOM 辅助、组件套件、Markdown、Artifact、桥封装
  shell/                  跨特性外壳：侧栏、底栏、工作区、对话框、toast、主题
  features/<name>/        单个界面
```

每个 feature 目录固定五个文件：

| 文件          | 内容                         |
| ------------- | ---------------------------- |
| `elements.ts` | 本特性的 DOM 句柄            |
| `state.ts`    | 本特性的可变状态             |
| `view.ts`     | 渲染函数                     |
| `actions.ts`  | IPC 调用与事件绑定           |
| `index.ts`    | 只导出 `init<Feature>(deps)` |

跨特性调用通过 `init<Feature>(deps)` 注入的显式依赖，不通过共享作用域。真正跨特性的状态（`workspaceState`、`selectedRailTab`、`mainView`、toast）归 `shell/`。

分片是逐函数搬迁，不是按行区间切割——引用没有局部性，切区间必然切断。因此按耦合度从低到高逐片推进，每片独立验证：

`downloads` → `updates` → `preflight` → `mcp` → `plugins` → `proxy` → `settings` → `artifact` → `router` → `connection` → `chat` → `conversation` → `projects` → `terminal` → `shell`

## 结果

- 每个特性可单独加载，行为测试的前置条件成立。
- 一个特性能触达的 DOM 与状态被目录边界限定。
- 跨特性依赖从隐式变成 `init` 签名里的显式参数，依赖方向可见。
- `max-lines` 与 dependency-cruiser 的孤儿、循环规则开始对渲染端生效。
- 代价：工作量最大的一步，且必须最后做——它依赖 `shared/`、`main/`、`preload/` 已经稳定。
- 代价：搬迁期间源码文本断言会因路径变化失效，靠语料化（[ADR-0003](0003-source-text-regression-pins.md)）保住命中。
- 代价：每片完成后需要手动打开该界面确认渲染、交互、IPC 往返正常。文本断言保护代码形态，不保护行为。

## 备选方案

**按层分片（全部 elements 一个文件、全部 state 一个文件、全部 view 一个文件）** —— 文件数少，但一个特性的改动仍然要横跨全部层文件，边界没有收窄，也无法单独加载一个特性。

**引入框架（React/Vue）重写** —— 能一次性拿到组件边界，但要重写 15,181 行渲染逻辑加 2,795 行手写 HTML，且 xterm.js、Artifact iframe、原生 `<select>` 呈现层（[ADR-0005](0005-native-select-as-source-of-truth.md)）都需要绕过框架的渲染循环。

**保持现状，只加 `max-lines` 告警** —— 阻止文件继续变大，但不产出模块边界，行为测试仍然写不了。
