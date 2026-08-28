import { ipcMain } from 'electron';
import { CHANNELS } from '../../shared/ipc/channels';
import type { Registry } from '../infra/registry';
import { MODEL_USAGE_SERVICE, MODEL_USAGE_WINDOW } from '../infra/service-tokens';
import type { MainGuards } from './guards';

export const registerModelUsageIpc = ({
  services,
  guards,
}: {
  services: Registry;
  guards: Pick<MainGuards, 'validateSender' | 'assertLaunchAdmissionAllowed'>;
}): void => {
  const validateSender = (event: Electron.IpcMainInvokeEvent): boolean => {
    const widget = services.resolve(MODEL_USAGE_WINDOW).isSender(event);
    if (!widget) guards.validateSender(event);
    return widget;
  };
  ipcMain.handle(CHANNELS.MODEL_USAGE_GET, (event) => {
    validateSender(event);
    return services.resolve(MODEL_USAGE_SERVICE).getSnapshot();
  });
  ipcMain.handle(CHANNELS.MODEL_USAGE_SET_FLOATING, async (event, visible: unknown) => {
    const widget = validateSender(event);
    if (typeof visible !== 'boolean' || (widget && visible)) throw new Error('悬浮球操作无效。');
    if (visible) guards.assertLaunchAdmissionAllowed();
    await services.resolve(MODEL_USAGE_WINDOW).setVisible(visible);
    return services.resolve(MODEL_USAGE_SERVICE).getSnapshot();
  });
};
