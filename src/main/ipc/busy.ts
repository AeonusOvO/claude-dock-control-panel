import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain } from 'electron';
import type { Registry } from '../infra/registry';
import { BUSY_REGISTRY } from '../infra/service-tokens';
import type { MainState } from './context';
import type { MainGuards } from './guards';

export interface BusyIpcDependencies {
  guards: Pick<MainGuards, 'validateSender'>;
  services: Registry;
  state: MainState;
}

export const registerBusyIpc = ({
  guards: { validateSender },
  services,
  state,
}: BusyIpcDependencies): void => {
  let releaseWorkspaceTransitionBusy: (() => void) | undefined;
  ipcMain.handle(CHANNELS.BUSY_LIST, (event) => {
    validateSender(event);
    return services.resolve(BUSY_REGISTRY).list();
  });
  ipcMain.handle(CHANNELS.BUSY_SET_CONVERSATION, (event, busy: unknown) => {
    validateSender(event);
    if (typeof busy !== 'boolean') {
      throw new Error('对话忙碌状态无效。');
    }
    const busyRegistry = services.resolve(BUSY_REGISTRY);
    if (busy && !state.releaseConversationBusy) {
      state.releaseConversationBusy = busyRegistry.acquire({
        cancellable: true,
        id: 'conversation:renderer',
        kind: 'conversation',
        label: '独立对话正在生成或准备发送',
        severity: 'blocking',
      });
    } else if (!busy && state.releaseConversationBusy) {
      state.releaseConversationBusy();
      state.releaseConversationBusy = undefined;
    }
    return busyRegistry.list();
  });
  ipcMain.handle(CHANNELS.BUSY_SET_WORKSPACE_TRANSITION, (event, busy: unknown) => {
    validateSender(event);
    if (typeof busy !== 'boolean') {
      throw new Error('工作区会话收尾状态无效。');
    }
    const busyRegistry = services.resolve(BUSY_REGISTRY);
    if (busy && !releaseWorkspaceTransitionBusy) {
      releaseWorkspaceTransitionBusy = busyRegistry.acquire({
        cancellable: false,
        domain: 'conversation',
        id: 'conversation:workspace-transition',
        kind: 'conversation',
        label: '正在新建或恢复对话，后台仍在完成模型接入与终端交接',
        severity: 'blocking',
        stage: '强制退出不会删除历史正文，但会中断尚未完成的启动或恢复',
      });
    } else if (!busy && releaseWorkspaceTransitionBusy) {
      releaseWorkspaceTransitionBusy();
      releaseWorkspaceTransitionBusy = undefined;
    }
    return busyRegistry.list();
  });
};
