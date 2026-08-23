import { ipcRenderer } from 'electron';
import type {
  ControlPanelApi,
  ManagedChatGptGatewayOperationResult,
  ManagedChatGptGatewayState,
  ManagedChatGptSetupProgress,
  OperationResult,
} from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const managedChatgptBridge = {
  getManagedChatGptGatewayState: () =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_STATE,
    ) as Promise<ManagedChatGptGatewayState>,
  logoutManagedChatGptGateway: () =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_LOGOUT,
    ) as Promise<ManagedChatGptGatewayOperationResult>,
  openManagedChatGptGatewayManagement: () =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_OPEN_MANAGEMENT,
    ) as Promise<OperationResult>,
  onManagedChatGptSetupProgress: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      progress: ManagedChatGptSetupProgress,
    ): void => {
      listener(progress);
    };
    ipcRenderer.on(CHANNELS.CLAUDE_MANAGED_CHATGPT_SETUP_PROGRESS, callback);
    return () => {
      ipcRenderer.removeListener(CHANNELS.CLAUDE_MANAGED_CHATGPT_SETUP_PROGRESS, callback);
    };
  },
  setManagedChatGptGatewayModel: (sessionId, model) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_MODEL,
      sessionId,
      model,
    ) as Promise<ManagedChatGptGatewayOperationResult>,
  setupManagedChatGptGateway: (sessionId) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_SETUP,
      sessionId,
    ) as Promise<ManagedChatGptGatewayOperationResult>,
} satisfies Partial<ControlPanelApi>;
