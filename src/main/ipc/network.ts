import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain } from 'electron';
import type { NetworkPreflightRunInput } from '../../shared/contracts';
import { validateNetworkPreflightAction, validateNetworkProvider } from './validation';
import type { MainGuards } from './guards';

export interface NetworkIpcDependencies {
  guards: Pick<MainGuards, 'requireNetworkPreflightService' | 'validateSender'>;
}

export const registerNetworkIpc = ({
  guards: { requireNetworkPreflightService, validateSender },
}: NetworkIpcDependencies): void => {
  ipcMain.handle(CHANNELS.NETWORK_PREFLIGHT_GET, (event, provider: unknown) => {
    validateSender(event);
    return requireNetworkPreflightService().get(validateNetworkProvider(provider));
  });
  ipcMain.handle(CHANNELS.NETWORK_PREFLIGHT_RUN, (event, input: unknown) => {
    validateSender(event);
    const record =
      input && typeof input === 'object' ? (input as Partial<NetworkPreflightRunInput>) : undefined;
    if (!record) {
      throw new Error('网络预检参数无效。');
    }
    return requireNetworkPreflightService().run({
      action: validateNetworkPreflightAction(record.action),
      force: record.force === true,
      provider: validateNetworkProvider(record.provider),
    });
  });
  ipcMain.handle(CHANNELS.NETWORK_PREFLIGHT_INVALIDATE, (event, reason: unknown) => {
    validateSender(event);
    requireNetworkPreflightService().invalidate(
      typeof reason === 'string' ? reason.slice(0, 120) : 'renderer-request',
    );
  });
  ipcMain.handle(CHANNELS.NETWORK_PREFLIGHT_GET_HISTORY, (event) => {
    validateSender(event);
    return requireNetworkPreflightService().getHistory();
  });
  ipcMain.handle(CHANNELS.NETWORK_PREFLIGHT_CLEAR_HISTORY, (event) => {
    validateSender(event);
    return requireNetworkPreflightService().clearHistory();
  });
};
