import type { ControlPanelApi, ModelUsageApi } from '../shared/contracts';

declare global {
  interface Window {
    controlPanel: ControlPanelApi;
    modelUsage: ModelUsageApi;
  }
}

export {};
