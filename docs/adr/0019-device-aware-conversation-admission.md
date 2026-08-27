# ADR-0019 设备感知会话准入与单调工作区快照

- 状态：已采纳
- 日期：2026-08-26

## 背景

每次点击新建都已拥有独立 session owner，但 renderer 曾把活动会话切换当成全局失效信号。快速新建、
恢复历史或离开当前页面会取消仍然有效的后台 launch；并发 IPC 返回还可能让旧 workspace 快照覆盖新
快照。完全放开 CLI 启动数量又会在低配设备上争抢 CPU、内存和主/渲染事件循环。

## 决策

1. 新建对话与历史恢复共享一个 renderer FIFO 准入队列。并发槽由逻辑处理器数量保守推导，最低 1、
   最高 8；槽位只在完整启动或回滚退栈后释放。
2. 每次点击仍建立独立 optimistic task，不 debounce、不按目录合并。槽位内允许正常并发，超过门限的
   task 显示实时队列位置，前序完成后自动补位。
3. 排队任务尚未准入时可由行尾 `×` 精确取消；取消不得调用 main 的打开、关闭或归档 API。准入后的
   task 继续由 session operation 与回滚边界持有，切换前台不改变所有权。
4. 启动/恢复失败且自动关闭失败的行不是可归档对话。其 `×` 直接关闭精确临时 session，不显示
   “关闭并归档”确认或归档成功文案。
5. `TerminalWorkspace` 为每次状态广播分配单调 `revision`，renderer 拒绝更小 revision。活动 session
   切换不再全局 invalidate launch preflight；只有 session 消失、generation/token 过期或显式取消才结束。
6. 同时到达的多个 launch preflight 决策在 renderer 内 FIFO 展示，不能由后一次弹窗覆盖并取消前一次。

## 后果

- 五次或十次点击仍代表五个或十个真实创建意图；设备可承受的部分并行，其余以可见、可取消的方式等待。
- 页面、项目和历史行切换不再决定后台任务生死；迟到 workspace 响应不能删除已出现的新会话。
- 队列只存在于当前 renderer 生命周期。应用退出仍由现有 blocking busy lease 统一确认，不承诺跨进程
  恢复尚未准入的创建意图。

## 验证

- 队列单元测试覆盖设备门限、并发槽、FIFO、精确取消和位置压紧。
- renderer 行为测试覆盖排队新建取消不调用 main、失败行直接移除且不请求归档确认、多个预检决策 FIFO。
- main/renderer 测试覆盖工作区 revision 单调递增及迟到快照拒绝。
