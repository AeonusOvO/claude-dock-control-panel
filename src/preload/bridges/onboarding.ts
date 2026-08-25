import { ipcRenderer } from 'electron';
import type { ControlPanelApi } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const onboardingBridge = {
  getOnboardingState: () => ipcRenderer.invoke(CHANNELS.ONBOARDING_GET),
  updateOnboardingProgress: (input) => ipcRenderer.invoke(CHANNELS.ONBOARDING_UPDATE, input),
  completeOnboarding: () => ipcRenderer.invoke(CHANNELS.ONBOARDING_COMPLETE),
  skipOnboarding: () => ipcRenderer.invoke(CHANNELS.ONBOARDING_SKIP),
  resetOnboarding: () => ipcRenderer.invoke(CHANNELS.ONBOARDING_RESET),
} satisfies Partial<ControlPanelApi>;
