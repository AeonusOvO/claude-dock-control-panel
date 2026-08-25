import { ipcMain } from 'electron';
import type { OnboardingPath, OnboardingProgressInput } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';
import type { OnboardingStore } from '../stores/onboarding';
import type { MainGuards } from './guards';

export interface OnboardingIpcDependencies {
  guards: Pick<MainGuards, 'validateSender'>;
  onboardingStore: OnboardingStore;
}

export const registerOnboardingIpc = ({
  guards: { validateSender },
  onboardingStore,
}: OnboardingIpcDependencies): void => {
  ipcMain.handle(CHANNELS.ONBOARDING_GET, (event) => {
    validateSender(event);
    return onboardingStore.get();
  });
  ipcMain.handle(CHANNELS.ONBOARDING_UPDATE, (event, input: OnboardingProgressInput) => {
    validateSender(event);
    return onboardingStore.update(input);
  });
  ipcMain.handle(CHANNELS.ONBOARDING_COMPLETE, (event, pathChoice?: OnboardingPath) => {
    validateSender(event);
    return onboardingStore.complete(pathChoice);
  });
  ipcMain.handle(CHANNELS.ONBOARDING_SKIP, (event) => {
    validateSender(event);
    return onboardingStore.skip();
  });
  ipcMain.handle(CHANNELS.ONBOARDING_RESET, (event) => {
    validateSender(event);
    return onboardingStore.reset();
  });
};
