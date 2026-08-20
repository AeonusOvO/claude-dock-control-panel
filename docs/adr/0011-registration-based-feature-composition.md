# ADR-0011 渲染端注册式分片

- 状态：已采纳
- 日期：2026-08-19

## 背景

[ADR-0006](0006-feature-sliced-renderer.md) 把 15,886 行的 `src/renderer/main.ts`（HEAD `6ca456e` 基线实测；ADR-0006 时点记为 15,181）按特性分片成 14 个 `features/` 目录加 `shell/`，每片以 `init<Feature>(deps)` 的装配式签名接入。S9 继续拆分时两个问题浮现：

- 特性文件过大触线 `max-lines`：`terminal`、`connection` 等复杂特性的单个文件（elements/state/view/actions）再次长到数百行，需要继续拆，但拆出的子模块如何组织没有规则。
- 装配主体脆弱：特性间存在回调互引（plugins 需要 updates 的刷新回调、updates 需要 connection 的路由相关性应用），装配式代码靠局部变量传递顺序与手工 delegate 解环；每加一个特性或一条跨特性边，`main.ts`/装配文件都要改。

## 决策

**终局结构**（实测规模）：

```
renderer/
  main.ts                  33 行：字体样式引入 + 组件套件安装 + new Registry + bootstrap
  bootstrap.ts             523 行：DOM 环境、RuntimeState、ShellStack 装配
  feature-registration.ts  678 行：14 个特性的注册与解析，按阶段分组
  runtime-types.ts         133 行：RuntimeState / ShellStack / FeatureBundle 三层类型
  app-lifecycle.ts         371 行：生命周期钩子
  platform/                11 个文件：注册表、组件套件、格式化、终端视图等与特性无关能力
  shell/                   36 个文件 3,703 行：侧栏、底栏、工作区、对话框、toast、主题
  features/                14 个特性 194 个文件 21,860 行
```

**注册式取代装配式**。每个特性的 `index.ts` 导出三件套：

```ts
export const TERMINAL_FEATURE = createRegistryToken<TerminalFeature>('renderer.feature.terminal');
export const registerTerminalFeature = (
  registry: Registry,
  deps: TerminalFeatureDependencies,
): void => {
  registry.register(TERMINAL_FEATURE, () => createTerminalFeature(deps));
};
```

| 维度       | 装配式（ADR-0006）             | 注册式（本 ADR）                                       |
| ---------- | ------------------------------ | ------------------------------------------------------ |
| 构造通道   | `init<Feature>(deps)` 直接调用 | `register(token, factory)` + `resolve(token)` 惰性求值 |
| 新增特性   | 改装配主体的调用序列           | 注册函数 + 阶段分组内加一段，token 边界自动收窄        |
| 循环引用   | 装配代码手工解环，环不可见     | `Registry` 解析栈拒绝环并报完整 token 链               |
| 跨特性回调 | 局部变量顺序传递               | 显式 delegate 或 `-dependencies` 最小接口              |

注册式没有引入自动拓扑排序：`feature-registration.ts` 仍按阶段分组（工具特性、设置特性、会话特性）手工编排，跨特性回调在组内回填。注册表接管的是构造通道与循环检测，不是装配顺序本身。

**五文件 + 子工厂模式**。特性内先按 ADR-0006 的五文件（elements/state/view/actions/index）划分；某族职责超过单文件可维护规模时，以主题前缀拆子工厂，母文件保留聚合与导出。实测形态：

| 特性                | 文件数  | 子工厂前缀族                                                                                  |
| ------------------- | ------- | --------------------------------------------------------------------------------------------- |
| terminal            | 39      | `terminal-io-*`、`terminal-layout-*`、`terminal-views-*`、`project-state-*`、`codex-launch-*` |
| connection          | 38      | `form-*`、`history-*`、`chatgpt-guide-*`、`connection-*`                                      |
| chat / conversation | 21 / 21 | 各自按职责前缀                                                                                |
| 其余 9 个特性       | 5–17    | 简单特性保持五文件不动                                                                        |

**跨特性依赖只经两条通道**：

- `delegate`：先建 `{ current }` 引用盒，注册后回填——用于"A 需要 B 的一个回调，但 B 注册在 A 之后"的时序缺口。
- `-dependencies.ts` 文件：消费方声明自己需要的最小鸭子类型接口（如 terminal 对 connection 表单只声明 `ConnectionFormLike` 的 10 个成员），装配处传入完整实例，结构类型兼容。消费方不 import 提供方的完整类型。

依赖方向由 dependency-cruiser 强制：`features/<name>/` 不得 import 其他特性（14 条按目录动态生成的 error 规则），跨特性协作只能经 `shell/` 编排或 `platform/` 共享层。

## 结果

- `main.ts` 从 15,886 行（HEAD `6ca456e` 基线实测，ADR-0006 时点为 15,181）降到 33 行；渲染端没有一个文件超过 `max-lines` 限制，114 个以上的子工厂文件全部在限制内。
- 特性边界可机检：特性间 import 违规、孤儿文件、循环依赖全部是 `lint:deps` 的 error。
- 行为测试的前置条件在特性粒度上成立（见 [ADR-0009](0009-behavioral-tests-replace-source-pins.md)）。
- 代价：理解一条跨特性数据流需要跨 `feature-registration.ts` 的阶段分组与两个特性的依赖接口，比单一作用域的全文搜索多两跳。
- 代价：`-dependencies` 最小接口与提供方真实接口的一致性靠结构类型检查维护，提供方改名成员时消费方接口只在装配处报错，错误位置远离定义位置。

## 备选方案

**保持装配式，只拆子工厂** —— 文件规模问题解决，但每条新跨特性边都回到装配主体手工排序，且环依赖仍然不可见。

**注册式加自动拓扑（按依赖声明排序）** —— 需要声明 token 级依赖图并实现拓扑排序；当前阶段分组还承载"shell 先于特性、会话特性最后"的业务顺序，自动排序会把这层语义藏进图算法。

**引入 React/Vue 获得组件边界** —— ADR-0006 已否决：15,181 行渲染逻辑加 2,795 行手写 HTML 的重写成本，以及 xterm.js、Artifact iframe、原生 `<select>` 呈现层（[ADR-0005](0005-native-select-as-source-of-truth.md)）对框架渲染循环的绕行需求，不因拆分完成而消失。
