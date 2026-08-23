# ADR-0012 单一滚动链与规范遮罩

- 状态：已采纳
- 日期：2026-08-20

## 背景

改造前外壳里存在多层嵌套滚动区：控制面板本身可滚，"选择历史配置"的列表可滚，列表里每张历史配置
卡片（`.connection-history__restore`）自身也可滚；"选择服务商"等增强 select 的弹层同样可滚。用户报告了
两个症状：

- 在"选择历史配置"处向下滚动，滚轮完全无效，必须用鼠标拖动滚动条。
- 每个滚动区"各管各的"：子级滚到底后继续滚，父级不会接着滚；向上同理。

同时对话框外围出现一圈与主题无关的黑边。

三者都不是独立缺陷，而是同一类问题——滚动与遮罩此前是"每个组件各写一份"，没有单一规则。

## 决策

### 1. 滚动链只有一条规则，用 JavaScript 实现

`src/renderer/platform/scroll-chaining.ts` 在 `main.ts` 模块作用域幂等安装唯一的 `wheel` 监听
（`window`、冒泡期、显式 `{ passive: false }`），并返回幂等 disposer。Chromium 会把一次滚轮 burst
_latch_ 到它起始的滚动容器上；之后的 tick 即使还有未消费 delta，也不会可靠交给祖先。因此不能只写
`overscroll-behavior: auto`，也不能等原生滚动完成后再补偿：前者会把 delta 困在子级，后者无法知道本次
究竟消费了多少。

监听器只做事件筛选、命中链快照、手势时钟更新、`preventDefault()` 与入队，不读取布局。下一次
`requestAnimationFrame` 分成三段：

1. **read**：一次读取本帧所有候选的 `scrollTop`、`scrollHeight`、`clientHeight`、overflow 与 containment；
2. **compute**：按事件顺序在虚拟 `scrollTop` 上把完整 delta 从 child → parent → outer 分配，某层只消费
   自己剩余容量，余量同帧继续向外；向上使用完全对称的容量计算；
3. **write**：每个仍连接的目标最多写一次最终 `scrollTop`。

所以 `consumed + residual = input delta`；两层或三层以上都不会重复或丢失，移交最迟发生在下一帧。
同一帧内的多个 wheel 事件共享虚拟位置，既不交错读写，也不会因为批处理而覆盖前一个事件。

保留的边界与 burst 规则：

- `overscroll-behavior-y: contain | none` 是硬停止，但封闭元素仍先消费自己的剩余容量；增强 select 的
  `.select__listbox` 由此滚到底后不会带动背后的外壳。
- open dialog、`:modal` 与 `:popover-open` 的 top-layer 根终止向外 walk。边界在事件入队时快照；即使
  节点在 flush 前断开，也宁可丢弃失效写入，不能把旧模态手势穿透到背景。
- burst 不再使用固定 200ms。首对事件有短暂启动余量，之后以实际 tick 间隔的指数移动平均计算
  64–320ms 自适应 idle 窗口：高频触控板很快结束，慢速有齿滚轮仍能保持连续。方向反转立即开始新
  burst 并重新从当前 child 向外分配；同方向则保持已经到达的祖先，避免滚动时滑入光标下的新卡片抢 tick。
- 已断开的普通目标会被跳过，仍连接的原命中祖先可继续消费；安装、重复安装、dispose 与再次安装均不
  叠加监听器或遗留 RAF。

连接历史不再人为制造第三层滚动：`.connection-history__item` 取消固定高度，
`.connection-history__restore` 随内容增长；真实页面只保留历史列表 → 控制面板两层。平台分配器仍支持
任意更深嵌套，三层以上由注入式单元测试覆盖。

### 2. 遮罩只有一条规范规则

`dialog::backdrop` 取 `var(--mask-veil)` 与 `var(--mask-blur)`。设计系统本来就为四种主题人格定义了
这两个令牌（"主题人格形状与操作遮罩"），并由 `shell/theme.ts` 在每次换主题时行内改写，所以"契合各个主题"
与"支持随时变换颜色"都不需要新增任何接线。删除全部按 dialog 硬编码的 `::backdrop` 颜色；唯一允许的
按 dialog 覆写是 `opacity`/`transition`。

## 后果

- 新增滚动区默认就有正确的链式行为，不需要任何 per-component 代码；要封闭只需声明
  `overscroll-behavior-y: contain`，JS 会尊重它。
- 分配规则（`allocateScrollDelta`）以注入式探针覆盖双层/三层以上、双向守恒、方向反转、adaptive burst、
  断开节点、重复 install/dispose 与 top-layer containment。jsdom 没有布局引擎，真实几何、trusted 输入、
  同帧 residual handoff 与 handler p95 由 `npm run test:scroll-chaining` 在 Electron 中验证；合成 JS
  `wheel` 不触发 Chromium 默认滚动。smoke 必须 `show: true`：隐藏窗口会静默丢弃大部分滚轮 tick。
- `tests/renderer/design-tokens.test.ts` 禁止任何 `::backdrop` 硬编码颜色并要求规范规则恰好一条。
  此前硬编码的黑色遮罩能通过令牌门禁，是因为中性色判定豁免了全 0 与全 255 通道。
- 代价：垂直 wheel 由应用在下一 RAF 写入 `scrollTop`，不再使用 Chromium 的滚轮惯性曲线；换来的是
  可证明的 residual 守恒、单帧移交和一致的 top-layer 边界。水平手势、pinch zoom 与已被近端组件接管的
  wheel 仍交给浏览器或组件。

## 关联

- [ADR-0005](0005-native-select-as-source-of-truth.md)：增强 select 的弹层是滚动链的主要封闭点。
- `docs/reference/technical.md` 的"滚动链与遮罩"；`docs/explanation/design.md` 的 Dialog 原语。
