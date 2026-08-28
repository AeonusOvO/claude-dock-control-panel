import { ipcRenderer } from 'electron';
import type {
  ControlPanelApi,
  SubscriptionResult,
  SubscriptionState,
} from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const subscriptionBridge = {
  getSubscriptionState: () =>
    ipcRenderer.invoke(CHANNELS.SUBSCRIPTION_STATE) as Promise<SubscriptionState>,
  setupSubscription: (provider) =>
    ipcRenderer.invoke(CHANNELS.SUBSCRIPTION_SETUP, provider) as Promise<SubscriptionResult>,
  cancelSubscriptionSetup: (attempt) =>
    ipcRenderer.invoke(CHANNELS.SUBSCRIPTION_CANCEL, attempt) as Promise<SubscriptionResult>,
  onSubscriptionState: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, state: SubscriptionState): void =>
      listener(state);
    ipcRenderer.on(CHANNELS.SUBSCRIPTION_CHANGED, callback);
    return () => ipcRenderer.removeListener(CHANNELS.SUBSCRIPTION_CHANGED, callback);
  },
} satisfies Partial<ControlPanelApi>;
