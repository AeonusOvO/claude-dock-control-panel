import { ipcMain } from 'electron';
import { CHANNELS } from '../../shared/ipc/channels';
import { parseIpcRequestArgs } from '../../shared/ipc/schema';
import type { Registry } from '../infra/registry';
import { SUBSCRIPTION_SERVICE } from '../infra/service-tokens';
import type { MainGuards } from './guards';

export const registerSubscriptionIpc = ({
  services,
  guards,
}: {
  services: Registry;
  guards: Pick<
    MainGuards,
    'validateSender' | 'assertLaunchAdmissionAllowed' | 'assertExternalRoutingWritesAllowed'
  >;
}): void => {
  ipcMain.handle(CHANNELS.SUBSCRIPTION_STATE, (event) => {
    guards.validateSender(event);
    return services.resolve(SUBSCRIPTION_SERVICE).getState();
  });
  ipcMain.handle(CHANNELS.SUBSCRIPTION_SETUP, (event, ...args: unknown[]) => {
    guards.validateSender(event);
    guards.assertLaunchAdmissionAllowed();
    guards.assertExternalRoutingWritesAllowed();
    const [provider] = parseIpcRequestArgs(CHANNELS.SUBSCRIPTION_SETUP, args);
    return services.resolve(SUBSCRIPTION_SERVICE).setup(provider);
  });
  ipcMain.handle(CHANNELS.SUBSCRIPTION_CANCEL, (event, ...args: unknown[]) => {
    guards.validateSender(event);
    const [attempt] = parseIpcRequestArgs(CHANNELS.SUBSCRIPTION_CANCEL, args);
    return services.resolve(SUBSCRIPTION_SERVICE).cancel(attempt);
  });
};
