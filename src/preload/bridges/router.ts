import { ipcRenderer } from 'electron';
import type {
  ControlPanelApi,
  ClaudeRouterOperationResult,
  RouterKernelOperationResult,
  RouterKernelState,
  RouterOperationProgress,
} from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const routerBridge = {
  deleteClaudeRouterProvider: (sessionId, providerId) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_ROUTER_DELETE_PROVIDER,
      sessionId,
      providerId,
    ) as Promise<ClaudeRouterOperationResult>,
  installClaudeRouter: (sessionId) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_ROUTER_INSTALL,
      sessionId,
    ) as Promise<ClaudeRouterOperationResult>,
  installClaudeRouterFromSource: (sessionId, source) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_ROUTER_INSTALL_SOURCE,
      sessionId,
      source,
    ) as Promise<ClaudeRouterOperationResult>,
  uninstallClaudeRouter: (sessionId) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_ROUTER_UNINSTALL,
      sessionId,
    ) as Promise<ClaudeRouterOperationResult>,
  getRouterKernelState: (sessionId) =>
    ipcRenderer.invoke(CHANNELS.ROUTER_KERNEL_STATE, sessionId) as Promise<RouterKernelState>,
  onRouterOperationProgress: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      progress: RouterOperationProgress,
    ): void => {
      listener(progress);
    };
    ipcRenderer.on(CHANNELS.ROUTER_OPERATION_PROGRESS, callback);
    return () => {
      ipcRenderer.removeListener(CHANNELS.ROUTER_OPERATION_PROGRESS, callback);
    };
  },
  installCcSwitch: (sessionId) =>
    ipcRenderer.invoke(
      CHANNELS.ROUTER_CC_SWITCH_INSTALL,
      sessionId,
    ) as Promise<RouterKernelOperationResult>,
  uninstallCcSwitch: (sessionId) =>
    ipcRenderer.invoke(
      CHANNELS.ROUTER_CC_SWITCH_UNINSTALL,
      sessionId,
    ) as Promise<RouterKernelOperationResult>,
  exportCurrentProviderToCcSwitch: (sessionId) =>
    ipcRenderer.invoke(
      CHANNELS.ROUTER_CC_SWITCH_EXPORT_CURRENT,
      sessionId,
    ) as Promise<RouterKernelOperationResult>,
  openClaudeRouterManagement: (sessionId) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_ROUTER_OPEN_MANAGEMENT,
      sessionId,
    ) as Promise<ClaudeRouterOperationResult>,
  saveClaudeRouterProvider: (sessionId, input) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_ROUTER_SAVE_PROVIDER,
      sessionId,
      input,
    ) as Promise<ClaudeRouterOperationResult>,
  repairClaudeRouterFromProject: (sessionId) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_ROUTER_REPAIR_FROM_PROJECT,
      sessionId,
    ) as Promise<ClaudeRouterOperationResult>,
  startClaudeRouter: (sessionId) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_ROUTER_START,
      sessionId,
    ) as Promise<ClaudeRouterOperationResult>,
  stopClaudeRouter: (sessionId) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_ROUTER_STOP,
      sessionId,
    ) as Promise<ClaudeRouterOperationResult>,
} satisfies Partial<ControlPanelApi>;
