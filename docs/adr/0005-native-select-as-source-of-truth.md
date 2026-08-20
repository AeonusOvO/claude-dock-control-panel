# ADR-0005 原生 `<select>` 保留为事实源，只替换呈现

- 状态：已采纳
- 日期：2026-08-17

## 背景

Windows 上的原生 `<select>` 由操作系统绘制：下拉列表是 Win32 listbox，用 Segoe UI 白底渲染，忽略全部主题 token。在四主题的界面里它看起来像另一个应用。

界面里约十几处调用点已经在读写 `select.value`、动态填充 `<option>`、监听 `change` 事件。

## 决策

保留原生 `<select>` 元素在 DOM 中作为值、校验和 `change` 事件的唯一事实源，只替换它的呈现层。

`enhanceSelect(select)` 的做法：

- 原生元素留在 DOM 里，视觉隐藏但仍是焦点目标，辅助技术仍能读到可访问名称。
- 外层包一个 `.select` shell，内含 `.select__trigger` 触发器和 `.select__listbox` 弹出列表。
- 列表项是 `<button>`，与界面其余部分用同一套 token 渲染，主题切换自动生效。
- 全局同时只允许一个 listbox 打开。
- 幂等：对同一元素重复调用只做一次同步。

调用点的代码不变：继续读写 `select.value`、填 `<option>`、听 `change`。

复选框与单选框不需要 JS：`appearance: none` 加 token 驱动的 CSS 足够，全部在样式表里处理。

## 结果

- 十几处既有调用点零改动。
- 主题切换对下拉框自动生效。
- 键盘与辅助技术的行为由原生元素提供，不需要自己实现 roving tabindex 与 `aria-activedescendant`。
- 代价：DOM 里同时存在原生元素和呈现层，两者需要 `sync()` 保持一致。动态填充 `<option>` 后必须重新调用 `enhanceSelect` 触发同步。
- 代价：列表项是 `<button>`，按下会把焦点从原生 select 上移走并触发 `blur`。实现里靠让原生元素保持整个交互的焦点所有者来规避。

## 备选方案

**完全自研下拉组件** —— 呈现完全可控，但要重写十几处调用点，并自己实现键盘导航与无障碍语义，为纯视觉目标承担全应用范围的回归风险。

**只用 CSS 改样式** —— Windows 上 `<select>` 的下拉部分不可用 CSS 样式化，做不到。
