# ADR-0014 引擎/模型解耦与可中断接入向导

- 状态：已采纳
- 日期：2026-08-25

## 背景

ADR-0013 把首次使用收敛为一条版本化流程，但“Claude Code / ChatGPT / API 服务商路径”仍把开发引擎、
账号订阅和模型来源压在同一次选择里。接入页随后再次展示六组完整 provider 目录，新用户需要理解官方、
国内、海外、本地、Router 与 cURL 的内部分类，才能进入真正配置。

ChatGPT 受管网关又包含两种不同事务边界：等待 OpenAI 浏览器授权时可以安全取消；授权确认后的 Proxy API
安装、模型发现、真实测试和保存不能中途返回。只把按钮设为 disabled 不能构成主进程事务门禁。

## 决策

1. 启动引导升级为 v2 五步流程：选择引擎、选择模型、自动准备、打开项目、准备完成。引擎仅为
   Claude Code / Codex；模型来源独立为 Claude 官方订阅、ChatGPT 官方订阅、国产模型、API。
2. 国产模型使用内置 provider ID 白名单和紧凑选择框；选择框状态明确显示当前模型。Claude Code 引擎
   使用 micro 级“推荐”标签，标签不改变按钮标题字号或高度。
3. `OnboardingStore` 的 storage/flow version 同步升级到 2。v1 path 在读取时确定性迁移并原子写回；
   已完成用户保持完成，不因升级重播引导。
4. 接入页固定为“选择模型 → 配置与验证”两步。首屏只有四个入口，第二步复用既有 provider 表单、
   ChatGPT guide、历史、Router 与 cURL DOM，不复制配置状态。
5. 第二步始终有上一步和下一步。无事务时上一步直接返回；OAuth `logging-in` progress 标记为可打断，
   返回前调用独立取消 IPC 并等待回收。Proxy API、模型探测、测试、保存和修复保持不可打断。
6. renderer 依据类型化 `interruptible` 与 session scope 呈现；main 的 `ManagedChatGptGateway` 再核对
   setup 真实处于 login 子进程，才接受取消。main 拒绝取消时 renderer 必须留在当前步骤并锁定返回，
   不能把过期 progress 误认为成功。不可打断边界不能只依赖 renderer 状态。
7. 两个向导的前进与返回使用方向相反的非线性空间动效；四主题、字体层级、按钮字号和窄窗口布局继续
   只由语义 token 与公共响应式规则决定。

## 后果

- 新用户先回答“用哪个引擎”和“模型从哪里来”，不必在同一卡片中推断组合关系。
- provider 精确目录仍是配置单一事实源；四入口只是可理解的投影，既有项目 preset 和历史不丢失。
- 新增 1 个取消请求响应频道；IPC 总量为 202，`ControlPanelApi` 为 202 个成员。
- 只有 OAuth 等待可以通过上一步取消；其他后台事务会明确说明不可打断，避免半写入配置。

## 验证

- store 测试覆盖 v2 选择、v1 迁移、非法组合、完成与损坏恢复。
- renderer 测试覆盖独立引擎/模型选择、国产选择框、两步往返、可取消授权和 Proxy API 锁定。
- main/preload/IPC 测试覆盖取消方法注册、桥接与进度字段；完整视觉门禁覆盖四主题和窄窗口。
