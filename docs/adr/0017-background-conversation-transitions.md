# ADR-0017 后台会话事务与下一次新建引擎

- 状态：已采纳
- 日期：2026-08-25
- 补充：并发准入与单调快照由 ADR-0019 约束

## 背景

旧交互把“新建安全会话”当作当前终端内的一次启动，并把开发引擎绑定到当前项目。renderer 离开活动
终端后会丢失启动续体；同一项目的快速点击又会被合并。历史恢复先显示成功式工作区状态，失败时可能
留下一个 PowerShell 终端和消失的历史行。用户无法判断操作仍在运行、已经失败，还是只丢了 UI owner。

## 决策

1. 项目行 `+` 是唯一普通新建入口。每次点击都立即建立不同的 renderer pending row、终端 preview、
   main `TerminalSession` 和精确 `createdSessionId`；不按目录 debounce，十次点击代表十个真实对话。
2. main 在分配 session 的同步提交点读取全局 `AgentRuntimeStore.nextRuntime`，并把 runtime 固化到
   `TerminalWorkspace` 的 session map。`runtime:get-next` / `runtime:set-next` 只控制下一次新建；当前会话和
   同目录兄弟会话不可被这个选择改写。
3. CLI 准备与启动由 session ID 持有，而不是由活动标签页持有。Claude 与 Codex 的续体都可在后台完成；
   Codex 安装和登录作为应用级共享资源串行，等待者由状态事件唤醒，低频异步 timer 只作为丢信号兜底，之后继续各自 session。
4. 新建与恢复都采用 `optimistic → allocated → launching → committed | rolling-back → rolled-back |
rollback-failed` 状态机。只有真实 CLI 成功才能提交成功呈现。失败时删除 pending、恢复历史快照并关闭
   精确临时终端；二次清理失败时保留红色失败行和可用关闭入口，不能显示运行成功。
5. 历史恢复只移动 renderer 中的行，canonical JSONL 从不因“开始恢复”而移动或删除。进程崩溃后重新
   扫描即可找回历史。交互式扫描使用异步文件 I/O，并在有界解析批次之间让出 Electron main 事件循环。
6. 事务期间只锁定会污染目标会话状态的控件：composer、网络预检、工作台、原生界面切换、目标行的
   重命名/关闭和全局下一次引擎选择；项目 `+` 保持可用，以允许并行新建。
7. 并发事务以引用计数投影为 main 的 blocking busy lease。显式退出显示全窗口 backdrop、当前阶段和
   强退后果；返回软件恢复原界面，转到后台继续，强退需要第二次确认。历史正文不依赖该租约保存。

## 后果

- 活动终端切换不再决定后台任务生死；点击次数决定独立任务数量，并行准入数量由 ADR-0019 的设备门限决定。
- renderer 状态与 main session 之间有一个短暂的 optimistic 阶段，但每条路径都有可验证的提交或回滚，
  不再允许无限 loading 或“UI 成功、后台失败”。
- 共享安装/登录仍然只有一个写入者；其他会话等待并复用结果，而不是并发修改全局 Codex 环境。
- 无法拦截操作系统对整个进程的无条件终止，但历史正文始终留在 canonical 文件中，风险缩小到尚未完成的
  CLI 启动和可能残留的临时终端。

## 验证

- renderer 测试覆盖十次快速点击、立即 pending、切换活动终端后的精确 owner、启动失败回滚、回滚失败
  红色状态、历史行立即移动与恢复，以及下一次引擎保存失败时恢复原选择。
- main 测试覆盖同目录 session 的 runtime 独立性、全局 next runtime 持久化、异步历史索引与 IPC 映射。
- 退出对话框测试覆盖 lease stage、返回软件、后台继续、强退二次确认和残留进程重试。
