# ADR-0010 运行期注册表与贡献点

- 状态：已采纳
- 日期：2026-08-19

## 背景

主进程的装配曾以一个 `MainServices` 容器对象为核心：窗口、托盘、各运行时服务都是它的字段，其中 19 个字段可空——窗口与托盘在 `app.ready` 之前不存在，服务在各自初始化完成前不存在。消费方写 `services.claudeRuntime?.xxx`，装配方在巨型对象字面量里逐字段赋值。三个问题：新增一个服务要同时改容器类型、装配处、全部消费方的空值判断；类型系统无法表达"这个字段在哪个阶段之后非空"；handler 文件 import 容器类型后能触达全部字段，边界不收窄。

同期 IPC handler 的注册是平铺的：`main/index.ts` 逐个调用注册函数，新增一个 IPC 域要改装配主体。

## 决策

引入两个互补机制，主进程与渲染进程同构。

**运行期注册表**（`src/main/infra/registry.ts` 与 `src/renderer/platform/registry.ts`，两份 60 行同构实现）：

- `createRegistryToken<T>(description)` 产出带类型的 Symbol token。
- `Registry.register(token, factory)` 注册工厂；`resolve(token)` 惰性求值并缓存单例；解析栈检测循环依赖并报出完整链。
- 生命周期晚于启动的对象（主窗口、托盘）用 `ServiceReference<T>`（`{ current: T | null }`）封装：token 解析后立刻可取，`current` 在对象创建后写入。可空性从 19 个字段收敛为 2 个显式引用盒。
- 主进程服务 token 共 25 个（`src/main/infra/service-tokens.ts`）；渲染端 15 个特性 token（各 `features/<name>/index.ts` 内定义，如 `DOWNLOADS_FEATURE`）。

**贡献点**（`src/main/infra/contributions.ts`）定义四类贡献，每类一个运行器：

| 贡献类型 | 签名                          | 现有贡献数                    | 消费位置                                   |
| -------- | ----------------------------- | ----------------------------- | ------------------------------------------ |
| IPC 域   | `(deps) => void`              | 24                            | `ipc/index.ts` 经 `MAIN_IPC_CONTRIBUTIONS` |
| 启动     | `() => void \| Promise<void>` | `app/bootstrap.ts` 的贡献数组 | `runStartupContributions`                  |
| 退出     | `() => void`                  | `app/lifecycle.ts` 的退出数组 | `runQuitContributions`                     |
| 托盘菜单 | `(context) => Item[]`         | 6（项目/窗口/终端/分隔/退出） | `app/tray.ts` 的 `collectTrayMenuItems`    |

**依赖类型自动推导**：`MainIpcDependencies = UnionToIntersection<IpcDependenciesOf<(typeof MAIN_IPC_CONTRIBUTIONS)[number]>>`——装配侧的依赖类型是全部贡献各自声明的依赖子集的交集合并。新增 IPC 域不改装配的判据：写一个 handler 文件（声明自己的依赖接口并 `satisfies IpcContribution<...>`）+ `contributions.ts` 数组加一行；`index.ts`、`main/index.ts`、类型定义零改动，缺依赖在编译期报错。

**边界：不做通用 DI 容器。** 不提供 scope 与子容器、不做装饰器自动注入、不支持字符串 token、不做条件绑定。token 只在装配层创建并注册；业务代码只 `resolve` 已注册的 token。注册表解决的是"字段可空与边界收窄"，不是"注解驱动的自动装配"。

## 结果

- `MainServices` 容器类型删除；消费方从"import 容器类型后任意触达"改为"resolve 自己声明的 token"，边界由 token 粒度收窄。
- 空值判断从 19 处可空字段收敛到 `ServiceReference` 的 2 处（`MAIN_WINDOW`、`TRAY`），且全部集中在装配层。
- 循环依赖在首次 `resolve` 时报错并给出完整 token 链，而不是装配顺序错乱后的运行期怪象。
- 测试侧获得同构设施：`tests/helpers/main-service-registry.ts` 用真实 `Registry` 与 `registerLifecycleServiceReferences` 组装，注入桩时走同一 `register` 通道（见 [ADR-0009](0009-behavioral-tests-replace-source-pins.md)）。
- 代价：多一层间接——看一个服务的构造点需要先找到 token 的 `register` 调用；token 的 `description` 字符串与变量名需要人工保持一致。
- 代价：注册表是运行期机制，静态分析工具（如 dependency-cruiser）只能看到 import 边，token 边要靠命名约定与装配层的唯一注册点约束。

## 备选方案

**保留 `MainServices` 容器，把可空字段改为 getter** —— getter 只能隐藏空值判断，不能表达"哪个阶段后非空"，且新增服务的三处修改不变。

**用类字段初始化与构造顺序解决生命周期** —— 窗口与托盘晚于模块加载是 Electron 的硬约束，构造顺序无法覆盖 `app.ready` 之前就需要引用它们的 handler。

**引入 tsyringe / InversifyJS 等通用 DI 库** —— 拿到 scope、装饰器、自动注入的全部能力，但代价是装饰器语法（与当前 ESLint 配置冲突）、运行期反射开销，以及一个 60 行就能覆盖全部需求的场景里引入完整框架。

**贡献点也走注册表（token 化）** —— 贡献是"一批同签名函数的有序执行"，数组加运行器已是最简形态；token 化会让顺序依赖（IPC 注册顺序决定同名通道归属）变得不可见。
