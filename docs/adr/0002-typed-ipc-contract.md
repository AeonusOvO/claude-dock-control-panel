# ADR-0002 单一类型化 IPC 契约

- 状态：已采纳
- 日期：2026-08-17

## 背景

渲染进程需要 187 个能力：158 个请求响应、22 个事件订阅、6 个单向命令、1 个进程内调用。

Electron 允许 preload 直接把 `ipcRenderer` 或一个通用 `invoke(channel, ...args)` 交给渲染端。这样加通道零成本，但渲染端能调用任意频道名，且没有任何一处能列出全部通道——频道名与载荷形状只存在于两侧的字面量里。

## 决策

`src/shared/contracts/control-panel-api.ts` 的 `ControlPanelApi` 是唯一的渲染端可见接口。preload 逐方法实现它，`contextBridge.exposeInMainWorld` 单点暴露，不导出 `ipcRenderer` 本体，不提供接受频道名参数的通用转发方法。

加一个通道必须同时改四处：`contracts/control-panel-api.ts` 的签名、preload 的桥方法、main 的 `ipcMain.handle`、`docs/reference/ipc-contract.md` 的表格。少任何一处会编译失败或运行时报 no handler。

主进程侧的固定形态：

```ts
ipcMain.handle('namespace:action', async (event, argument: unknown) => {
  validateSender(event);
  const validated = validateSomething(argument);
  // ...
});
```

- `validateSender(event)` 是每个 handler 的首行，拒绝非主窗口 `webContents` 的调用。
- 参数以 `unknown` 接收，经 `validate*()` 收窄；渲染端传来的值不被信任。
- 异常转成结构化失败结果返回，不让 Promise reject 穿过 IPC 边界。

高频写入（终端按键、尺寸变化）例外，走单向 `ipcRenderer.send` + `ipcMain.on`：每次按键一次 Promise 往返的开销不可接受。这类通道必须带单调版本号（`ptyGeneration`、`resizeRevision`），接收侧丢弃过期消息。

## 结果

- 渲染端能调用的通道集合是封闭的，等于 `ControlPanelApi` 的成员集合。
- 载荷形状由 TypeScript 检查，两侧不会静默分叉。
- 全部通道可枚举，`docs/reference/ipc-contract.md` 是完整清单。
- 代价：`ControlPanelApi` 是 187 个成员的单一接口。已拆成 19 个按域划分的子接口再组合，签名总数不变，`window.controlPanel` 运行期仍是一个扁平对象。
- 代价：加通道要改四处。

## 备选方案

**暴露通用 `invoke(channel, ...args)`** —— 加通道零成本，但渲染端可达的频道集合不再封闭，且无法静态列出全部通道。

**按需为每个界面单独 expose 一个命名空间对象** —— 减少单接口的成员数，但会有多个 `exposeInMainWorld` 入口，白名单不再是单点。
