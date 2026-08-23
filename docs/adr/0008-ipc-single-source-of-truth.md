# ADR-0008 IPC 通道与载荷的单一事实源

- 状态：已采纳
- 日期：2026-08-19

## 背景

[ADR-0002](0002-typed-ipc-contract.md) 把渲染端可达的通道集合封闭成 `ControlPanelApi` 的成员，但通道名字符串本身仍然分散：preload 桥里写一份 `ipcRenderer.invoke('xxx:yyy')`，main 的 handler 里写一份 `ipcMain.handle('xxx:yyy')`，载荷校验函数内联在各 handler 文件里。两侧各写一份字面量，拼写、大小写、前缀分叉不会被 TypeScript 发现，只能在运行时报 no handler 或静默发错频道。

演进过程：通道常量先从两侧字面量提取到 `src/shared/ipc/channels.ts`，载荷校验集中到 `src/shared/ipc/`，preload 桥按域拆成 20 个文件，main 侧 handler 改为贡献点注册（见 [ADR-0010](0010-runtime-registry-and-contributions.md)）。本 ADR 记录收敛后的终局形态。

## 决策

`src/shared/ipc/` 是 IPC 通道名与载荷形状的唯一事实源，四个组成部分：

| 组成部分     | 位置                         | 规模（实测）                                                             |
| ------------ | ---------------------------- | ------------------------------------------------------------------------ |
| 通道常量     | `src/shared/ipc/channels.ts` | 196 个常量，分三组：请求响应 166、单向命令 7、事件推送 23                |
| 载荷校验     | `src/shared/ipc/`            | 通用 schema 与 Claude 执行 schema 分文件，全部经共享解析器收窄           |
| preload 桥   | `src/preload/bridges/`       | 20 个按域拆分的桥文件，`index.ts` 展开组装并 `satisfies ControlPanelApi` |
| main handler | `src/main/ipc/`              | 24 个 IPC 域贡献，经 `MAIN_IPC_CONTRIBUTIONS` 数组注册                   |

通道常量按消息方向分三组，每组同时导出字符串字面量类型与冻结数组：

| 分组              | 通道数 | 消费方式                                                    |
| ----------------- | ------ | ----------------------------------------------------------- |
| `requestChannels` | 166    | preload `invoke` ↔ main `ipcMain.handle`                    |
| `sendChannels`    | 7      | preload `send` ↔ main `ipcMain.on`（高频写入，见 ADR-0002） |
| `eventChannels`   | 23     | main `webContents.send` ↔ preload `on`                      |

两侧都从 `CHANNELS` 常量取通道名的原因：preload 与 main 是两个独立编译的进程入口，字面量在两侧各写一份必然分叉；常量放在 `shared/` 让一次编译同时检查两侧。渲染端不引用 `CHANNELS`——它只看到 `ControlPanelApi` 的类型化方法，通道名对它不存在。

## 结果

- **字面量清零判据**（机检）：196 个通道字符串值在 `channels.ts` 之外的 `src/` 全部 `.ts` 文件中出现次数为 0。实测脚本从 `channels.ts` 提取全部通道值后对 `src/` 其余文件做子串扫描，违规 0 处。
- 通道总数可枚举：`IPC_CHANNELS` 冻结数组就是完整清单，`docs/reference/ipc-contract.md` 从这里核对。
- 加一个通道仍然要改多处（`channels.ts` 常量、`schema.ts` 校验、preload 桥、main handler、契约文档），但每一处都有唯一文件归属，且两侧通道名由同一常量绑定，不会静默分叉。
- `CHANNELS` 被 25 个以上文件 import（main 的 20 个 IPC 域 handler、`app/` 的窗口与生命周期、`claude/state-publisher`、preload 桥、`schema.ts` 自身）。
- 代价：196 个常量集中在一个文件里，按域注释分段；新增域时按字母序插入对应分组。

## 备选方案

**通道名留在两侧各自定义，靠 code review 对齐** —— 这是收敛前的状态；分叉只能在运行时暴露，且没有任何一处能列出全部通道。

**每个域各自一个 `xxx-channels.ts`** —— 文件数变多，但「全部通道的完整清单」不再单一可枚举，契约文档与跨域审计都要聚合多个文件。

**用 zod schema 的 key 派生通道名** —— 通道名与载荷形状耦合后，纯事件通道（无载荷）与单向命令需要额外机制，且 `ControlPanelApi` 方法名与通道名的对应关系变得间接。
